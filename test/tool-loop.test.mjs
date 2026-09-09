import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
function events(stream, name) {
  return stream.split(/\r?\n\r?\n/).filter((block) => block.startsWith(`event: ${name}\n`)).map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6)));
}

async function fixture(t, respond) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snowyy-tool-loop-'));
  let child;
  let provider;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    if (provider?.listening) await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, 'note.txt'), 'hello\n');
  const requests = [];
  provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    const reply = await respond(body, requests.length);
    const { finish_reason: configuredFinishReason, omit_done: omitDone, ...message } = reply;
    const finishReason = Object.hasOwn(reply, 'finish_reason')
      ? configuredFinishReason
      : message.tool_calls ? 'tool_calls' : 'stop';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ message, finish_reason: finishReason }] })}\n\n${omitDone ? '' : 'data: [DONE]\n\n'}`);
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', WORKSPACE_ROOT: root, SESSION_STORE_PATH: path.join(root, 'sessions.json'), LLM_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, LLM_MODEL: 'test-model' }
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 8000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Snowyy is running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
  });
  return { root, url, requests, async chat(prompt, settings) {
    let sessionId;
    if (settings) {
      const created = await (await fetch(`${url}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      sessionId = created.session.id;
      await fetch(`${url}/api/sessions/${sessionId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
    }
    return (await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: prompt }] }) })).text();
  } };
}

test('invalid JSON and schema errors become tool replies; valid calls still run and the model can recover', async (t) => {
  const app = await fixture(t, (_body, round) => round === 1 ? {
    tool_calls: [call('bad-json', 'read_file', '{broken'), call('bad-schema', 'read_file', { path: 'note.txt', start_line: 0 }), call('good-read', 'read_file', { path: 'note.txt' })]
  } : round === 2 ? { tool_calls: [call('retry-read', 'read_file', { path: 'note.txt', start_line: 1 })] } : { content: 'The note contains hello.' });
  const stream = await app.chat('Inspect note.txt.');
  assert.equal(events(stream, 'error').length, 0);
  assert.equal(events(stream, 'done').length, 1);
  const results = events(stream, 'tool_result');
  assert.deepEqual(results.map(({ id, ok }) => [id, ok]), [['bad-json', false], ['bad-schema', false], ['good-read', true], ['retry-read', true]]);
  assert.equal(results[0].result.code, 'INVALID_ARGUMENTS');
  assert.match(results[0].result.suggestion, /JSON object/);
  assert.deepEqual(app.requests[1].messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id), ['bad-json', 'bad-schema', 'good-read']);
});

test('planning can search files while attempted writes are rejected before path normalization', async (t) => {
  const app = await fixture(t, (_body, round) => round === 1 ? { tool_calls: [
    call('disabled-write', 'write_file', { path: '../outside.txt', content: 'no', expected_sha256: '' }),
    call('search', 'search_text', { query: 'hello', path: 'note.txt' })
  ] } : { content: 'The note contains hello.' });
  const stream = await app.chat('Inspect the note and plan an edit.', { planningOnly: true });
  assert.deepEqual(app.requests[0].tools.map((tool) => tool.function.name).sort(), ['fetch_url', 'find_files', 'list_directory', 'list_goals', 'read_file', 'search_text', 'web_search']);
  assert.equal(events(stream, 'tool_result')[0].result.code, 'TOOL_DISABLED');
  assert.equal(events(stream, 'tool_result')[1].result.matches[0].line, 1);
  assert.equal(events(stream, 'approval').length, 0);
  assert.equal(events(stream, 'done').length, 1);
});

test('nonzero command exits are persisted as failures and sent to the model as failures', async (t) => {
  const app = await fixture(t, (_body, round) => round === 1 ? {
    tool_calls: [call('failed-command', 'run_command', { executable: 'node', args: ['-e', 'process.exit(7)'] })]
  } : { content: 'I cannot complete the command because it exited with code 7.' });
  const stream = await app.chat('Run the diagnostic command.', { approvalMode: 'always' });
  const result = events(stream, 'tool_result')[0];
  assert.equal(result.ok, false);
  assert.equal(result.result.code, 'COMMAND_FAILED');
  const delivered = JSON.parse(app.requests[1].messages.findLast((message) => message.role === 'tool').content);
  assert.equal(delivered.ok, false);
  const store = JSON.parse(await readFile(path.join(app.root, 'sessions.json'), 'utf8'));
  const trace = store.sessions[0].timeline.find((entry) => entry.id === 'failed-command');
  assert.equal(trace.status, 'failed');
});

test('a stale approval cannot change a file and does not approve the next queued edit', async (t) => {
  const app = await fixture(t, (_body, round) => round === 1 ? { tool_calls: [
    call('first-edit', 'apply_patch', { path: 'note.txt', old_text: 'hello', new_text: 'first' }),
    call('second-edit', 'apply_patch', { path: 'note.txt', old_text: 'hello', new_text: 'second' })
  ] } : { content: 'I cannot proceed with the denied edit.' });
  const initial = await app.chat('Edit the note.');
  const approvalId = events(initial, 'approval')[0].approvalId;
  await writeFile(path.join(app.root, 'note.txt'), 'hello\nexternally changed\n');
  const resumed = await (await fetch(`${app.url}/api/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId, decision: 'approve' }) })).text();
  assert.equal(events(resumed, 'tool_result')[0].result.code, 'FILE_CHANGED');
  const nextApproval = events(resumed, 'approval')[0];
  assert.equal(nextApproval.toolCall.id, 'second-edit');
  assert.equal(await readFile(path.join(app.root, 'note.txt'), 'utf8'), 'hello\nexternally changed\n');
  const denied = await (await fetch(`${app.url}/api/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: nextApproval.approvalId, decision: 'deny' }) })).text();
  assert.equal(events(denied, 'tool_result')[0].result.denied, true);
});

test('agent tool use is not capped at twenty rounds', async (t) => {
  const app = await fixture(t, (_body, round) => round <= 24
    ? { tool_calls: [call(`goal-list-${round}`, 'list_goals', {})] }
    : { content: 'Finished after all required inspections.' });
  const stream = await app.chat('Keep inspecting until the task is complete.');
  assert.equal(events(stream, 'tool_result').length, 24);
  assert.equal(events(stream, 'done').length, 1);
  assert.equal(app.requests.length, 25);
});

test('output-limited responses continue seamlessly and persist as one complete assistant turn', async (t) => {
  const app = await fixture(t, (body, round) => {
    if (round === 1) return { content: 'The first half ', finish_reason: 'length' };
    assert.match(body.messages.at(-1).content, /Continue exactly where it ended/);
    return { content: 'and the second half.', finish_reason: 'stop' };
  });
  const stream = await app.chat('Give me the complete answer.');
  const continuing = events(stream, 'status').find((event) => event.reason === 'output_limit');
  assert.equal(continuing.seamless, true);
  assert.equal(events(stream, 'token').map((event) => event.token).join(''), 'The first half and the second half.');
  assert.equal(events(stream, 'done')[0].finishReason, 'stop');
  const sessionId = events(stream, 'session')[0].id;
  const session = (await (await fetch(`${app.url}/api/sessions/${sessionId}`)).json()).session;
  assert.equal(session.messages.at(-1).content, 'The first half and the second half.');
  assert.equal(session.timeline.filter((entry) => entry.role === 'assistant').at(-1).continuation, true);
});

test('a normal stop after a natural-language tool handoff continues automatically', async (t) => {
  const app = await fixture(t, (body, round) => {
    if (round === 1) {
      return { content: 'Now I can see the full picture. Let me fix this by updating the handler. Let me start with the first file:' };
    }
    if (round === 2) {
      assert.equal(body.tool_choice, 'required');
      assert.deepEqual(body.tools.map((tool) => tool.function.name), ['apply_patch']);
      return { tool_calls: [call('natural-handoff-edit', 'apply_patch', { path: 'note.txt', old_text: 'hello', new_text: 'updated' })] };
    }
    return { content: 'Updated note.txt.' };
  });
  const stream = await app.chat('Fix note.txt by updating the handler.', { approvalMode: 'always' });
  assert.equal(events(stream, 'status').filter((event) => event.status === 'continuing').length, 1);
  assert.equal(events(stream, 'tool_result')[0].ok, true);
  assert.equal(events(stream, 'done').length, 1);
  assert.equal(await readFile(path.join(app.root, 'note.txt'), 'utf8'), 'updated\n');
});

test('a reasoning-only stop that promises more work forces the missing tool call', async (t) => {
  const app = await fixture(t, (body, round) => {
    if (round === 1) {
      return { reasoning: 'I have enough context from the results. Now let me implement the change, but first let me search more specifically:' };
    }
    if (round === 2) {
      assert.equal(body.tool_choice, 'required');
      return { tool_calls: [call('reasoning-recovery-read', 'read_file', { path: 'note.txt' })] };
    }
    return { content: 'The note contains hello.' };
  });
  const stream = await app.chat('Inspect note.txt and continue the work.');
  const continuing = events(stream, 'status').find((event) => event.status === 'continuing');
  assert.equal(continuing.recovery, 'tool');
  assert.equal(events(stream, 'tool_result')[0].ok, true);
  assert.match(events(stream, 'reasoning')[0].token, /search more specifically/);
  assert.equal(events(stream, 'done').length, 1);
});

test('Continue keeps the earlier actionable request in tool recovery context', async (t) => {
  const app = await fixture(t, (body, round) => {
    if (round === 1) return { content: 'Which replacement text should I use?' };
    if (round === 2) return { content: 'I have the context now. Let me implement the edit and start with the first file:' };
    assert.equal(body.tool_choice, 'required');
    assert.deepEqual(body.tools.map((tool) => tool.function.name), ['apply_patch']);
    assert.match(body.messages.at(-1).content, /Original request:\nFix note\.txt/);
    assert.doesNotMatch(body.messages.at(-1).content, /Original request:\nContinue\./);
    return { tool_calls: [call('continued-objective-edit', 'apply_patch', { path: 'note.txt', old_text: 'hello', new_text: 'continued' })] };
  });
  const first = await app.chat('Fix note.txt by replacing its text.');
  const sessionId = events(first, 'session')[0].id;
  assert.equal(events(first, 'done').length, 1);
  const second = await (await fetch(`${app.url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: 'Continue.' }] })
  })).text();
  assert.equal(events(second, 'status').filter((event) => event.status === 'continuing').length, 1);
  assert.equal(events(second, 'approval').length, 1);
});

test('an abruptly closed provider stream preserves partial text and reports interruption', async (t) => {
  const app = await fixture(t, () => ({ content: 'Partial but retained.', finish_reason: null, omit_done: true }));
  const stream = await app.chat('Do not lose a partial response.');
  assert.equal(events(stream, 'error')[0].code, 'PROVIDER_STREAM_INTERRUPTED');
  const sessionId = events(stream, 'session')[0].id;
  const session = (await (await fetch(`${app.url}/api/sessions/${sessionId}`)).json()).session;
  assert.equal(session.messages.at(-1).content, 'Partial but retained.');
  assert.equal(session.timeline.filter((entry) => entry.role === 'assistant').at(-1).content, 'Partial but retained.');
});

test('automatic compaction persists a clean reusable context summary', async (t) => {
  const app = await fixture(t, (body) => body.messages[0]?.content?.includes('Condense conversation context')
    ? { content: 'Objective: preserve the architecture decision. Next: finish the implementation.' }
    : { content: 'Context retained.' });
  const created = await (await fetch(`${app.url}/api/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).json();
  await fetch(`${app.url}/api/sessions/${created.session.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { maxContextTokens: 1_000 } })
  });
  const messages = [];
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: 'user', content: `Decision ${index}: ${'context '.repeat(80)}` });
    messages.push({ role: 'assistant', content: `Acknowledged ${index}: ${'detail '.repeat(80)}` });
  }
  messages.push({ role: 'user', content: 'What is the next step?' });
  const stream = await (await fetch(`${app.url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: created.session.id, messages })
  })).text();
  assert.equal(events(stream, 'compacted').length, 1);
  const session = (await (await fetch(`${app.url}/api/sessions/${created.session.id}`)).json()).session;
  assert.match(session.context.summary, /preserve the architecture decision/);
  assert.ok(session.context.summarizedMessages > 0);
  assert.equal(session.messages.at(-2).content, 'What is the next step?');
});

test('stopping a run preserves completed context and the active user turn', async (t) => {
  const app = await fixture(t, async (body) => {
    const lastUser = body.messages.findLast((message) => message.role === 'user')?.content;
    if (lastUser === 'This turn will be stopped.') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { content: 'Too late.' };
    }
    return { content: 'First turn complete.' };
  });
  const first = await app.chat('Remember this completed turn.');
  const sessionId = events(first, 'session')[0].id;
  const controller = new AbortController();
  const response = await fetch(`${app.url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
    body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: 'This turn will be stopped.' }] })
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(response.text(), (error) => error.name === 'AbortError');
  const session = (await (await fetch(`${app.url}/api/sessions/${sessionId}`)).json()).session;
  assert.deepEqual(session.messages.map(({ role, content }) => [role, content]), [
    ['user', 'Remember this completed turn.'],
    ['assistant', 'First turn complete.'],
    ['user', 'This turn will be stopped.']
  ]);
});

test('a focused clarification question completes without a forced tool call', async (t) => {
  const app = await fixture(t, () => ({ content: 'Which file should I edit?' }));
  const stream = await app.chat('Please edit the file.');
  assert.equal(events(stream, 'done').length, 1);
  assert.equal(events(stream, 'tool_start').length, 0);
  assert.equal(app.requests.length, 1);
});

test('the model can create a persistent goal that is streamed to the UI', async (t) => {
  const app = await fixture(t, (_body, round) => round === 1
    ? { tool_calls: [call('create-goal-1', 'create_goal', { title: 'Finish the migration' })] }
    : { content: 'Goal created.' });
  const stream = await app.chat('Track this migration as a goal.');
  const goalEvent = events(stream, 'goals')[0];
  assert.equal(goalEvent.goals[0].title, 'Finish the migration');
  const sessionId = events(stream, 'session')[0].id;
  const session = (await (await fetch(`${app.url}/api/sessions/${sessionId}`)).json()).session;
  assert.equal(session.goals[0].status, 'active');
});
