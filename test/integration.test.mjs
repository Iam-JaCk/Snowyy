import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sendStream(response, chunks) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Snowyy server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${url}/api/config`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Snowyy server did not start.');
}

function extractEvent(stream, eventName) {
  for (const block of stream.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.find((line) => line === `event: ${eventName}`)) {
      const data = lines.find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
    }
  }
  return null;
}

test('agent pauses a write, resumes after approval, and streams completion', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'snowyy-integration-'));
  await writeFile(path.join(workspace, 'note.txt'), 'hello\n', 'utf8');
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const providerBodies = [];
  const provider = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'second-model:latest' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    providerBodies.push(body);
    const lastContent = body.messages.at(-1)?.content;
    const lastText = Array.isArray(lastContent)
      ? lastContent.find((part) => part.type === 'text')?.text || ''
      : String(lastContent || '');
    const forcedToolName = body.tool_choice === 'required' && body.tools?.length === 1 ? body.tools[0].function?.name : null;
    const contextualEditRequest = lastText.includes('Can you edit it to print "Hi Snowyy!"?')
      || (body.messages.at(-1)?.role === 'tool' && body.messages.findLast((message) => message.role === 'user')?.content.includes('Can you edit it to print "Hi Snowyy!"?'))
      || forcedToolName === 'read_file' || forcedToolName === 'apply_patch';
    if (contextualEditRequest) {
      if (body.messages.at(-1).role === 'tool') {
        const result = JSON.parse(body.messages.at(-1).content);
        if (typeof result.content === 'string') {
          sendStream(response, [{ choices: [{ delta: { content: 'Applied small targeted edit to note.txt successfully.' }, finish_reason: 'stop' }] }]);
          return;
        }
        sendStream(response, [{ choices: [{ delta: { content: 'Updated note.txt to print "Hi Snowyy!".' }, finish_reason: 'stop' }] }]);
        return;
      }
      if (forcedToolName === 'read_file') {
        sendStream(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'context_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"@note.txt"}' } }] }, finish_reason: 'tool_calls' }] }]);
        return;
      }
      if (forcedToolName === 'apply_patch') {
        sendStream(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'context_edit', type: 'function', function: { name: 'apply_patch', arguments: '{"path":"@note.txt","old_text":"hello Snowyy","new_text":"Console.WriteLine(\\"Hi Snowyy!\\");"}' } }] }, finish_reason: 'tool_calls' }] }]);
        return;
      }
      sendStream(response, [{ choices: [{ delta: { content: "I'll read the current file first and then use apply_patch." }, finish_reason: 'stop' }] }]);
      return;
    }
    if (body.messages.some((message) => message.role === 'user' && String(message.content).includes('Create a file but keep promising instead.'))) {
      sendStream(response, [{ choices: [{ delta: { content: "I'll call write_file next." }, finish_reason: 'stop' }] }]);
      return;
    }
    if (forcedToolName === 'write_file' && body.messages.some((message) => String(message.content).includes('Create recovery file'))) {
      const redundantPath = `${path.basename(workspace)}\\recovered.cs`;
      sendStream(response, [{ choices: [{ delta: { content: 'Retrying with the required empty hash.', tool_calls: [{ index: 0, id: 'recovery_write_2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: redundantPath, content: 'class Recovered {}\n', expected_sha256: 'sha256:' }) } }] }, finish_reason: 'tool_calls' }] }]);
      return;
    }
    if (lastText.includes('The request is still active. Continue now')) {
      const redundantPath = `${path.basename(workspace)}\\recovered.cs`;
      sendStream(response, [{
        choices: [{
          delta: {
            content: 'Retrying with the required empty hash.',
            tool_calls: [{ index: 0, id: 'recovery_write_2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: redundantPath, content: 'class Recovered {}\n', expected_sha256: 'sha256:' }) } }]
          },
          finish_reason: 'tool_calls'
        }]
      }]);
      return;
    }
    if (lastText.includes('What did you write inside of the file?')) {
      sendStream(response, [{ choices: [{ delta: { content: 'The file contains `class Recovered {}`.' }, finish_reason: 'stop' }] }]);
      return;
    }
    if (lastText.includes('Look at this screenshot')) {
      sendStream(response, [{ choices: [{ delta: { content: 'I can see the attachment.' }, finish_reason: 'stop' }] }]);
      return;
    }
    if (body.messages.at(-1).role === 'tool') {
      const toolResult = JSON.parse(body.messages.at(-1).content);
      if (toolResult.ok === false) {
        sendStream(response, [{ choices: [{ delta: { content: "I'll call write_file again with the corrected arguments now." }, finish_reason: 'stop' }] }]);
        return;
      }
      sendStream(response, [{ choices: [{ delta: { content: 'The file was updated.' }, finish_reason: 'stop' }] }]);
      return;
    }
    if (lastText.includes('Create recovery file')) {
      sendStream(response, [{
        choices: [{
          delta: {
            content: 'Trying an edit before confirming that the target exists.',
            tool_calls: [{ index: 0, id: 'recovery_write_1', type: 'function', function: { name: 'apply_patch', arguments: '{"path":"recovered.cs","old_text":"class Recovered {}","new_text":"class Recovered { }"}' } }]
          },
          finish_reason: 'tool_calls'
        }]
      }]);
      return;
    }
    sendStream(response, [{
      choices: [{
        delta: { content: 'I’ll update the note first.', tool_calls: [{ index: 0, id: 'edit_1', type: 'function', function: { name: 'apply_patch', arguments: '{"path":"note.txt","old_text":"hello","new_text":"hello Snowyy"}' } }] },
        finish_reason: 'tool_calls'
      }]
    }]);
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const providerPort = provider.address().port;
  const snowyyPort = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(snowyyPort), WORKSPACE_ROOT: workspace, SESSION_STORE_PATH: path.join(workspace, 'sessions.json'), LLM_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, LLM_MODEL: 'test-model' },
    stdio: 'ignore',
    windowsHide: true
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const baseUrl = `http://127.0.0.1:${snowyyPort}`;
  await waitForServer(baseUrl, child);

  const runtimeConfig = await (await fetch(`${baseUrl}/api/config`)).json();
  const expectedVersion = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).version;
  assert.equal(runtimeConfig.app.version, expectedVersion);
  assert.equal(runtimeConfig.app.channel, 'development');
  assert.equal(runtimeConfig.app.updatesEnabled, false);
  const updateStatus = await (await fetch(`${baseUrl}/api/updates`)).json();
  assert.deepEqual(updateStatus, { version: expectedVersion, enabled: false, status: 'disabled', releaseName: null, error: null });

  const modelDiscoveryResponse = await fetch(`${baseUrl}/api/provider/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}/v1` })
  });
  assert.equal(modelDiscoveryResponse.status, 200);
  assert.deepEqual((await modelDiscoveryResponse.json()).models, ['test-model', 'second-model:latest']);

  const uiHelpersResponse = await fetch(`${baseUrl}/ui-helpers.js`);
  assert.equal(uiHelpersResponse.status, 200);
  assert.match(await uiHelpersResponse.text(), /SnowyyUiHelpers/);

  const editorRead = await (await fetch(`${baseUrl}/api/file?path=note.txt`)).json();
  const editorSaveResponse = await fetch(`${baseUrl}/api/file?path=note.txt`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello editor\n', expected_sha256: editorRead.sha256 })
  });
  assert.equal(editorSaveResponse.status, 200);
  const editorSave = await editorSaveResponse.json();
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'hello editor\n');
  const staleSave = await fetch(`${baseUrl}/api/file?path=note.txt`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'stale\n', expected_sha256: editorRead.sha256 })
  });
  assert.equal(staleSave.ok, false);
  const restored = await fetch(`${baseUrl}/api/file?path=note.txt`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello\n', expected_sha256: editorSave.result.files[0].sha256 })
  });
  assert.equal(restored.status, 200);

  const chatResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Update the note.' }] })
  });
  const firstStream = await chatResponse.text();
  const streamedSession = extractEvent(firstStream, 'session');
  const approval = extractEvent(firstStream, 'approval');
  assert.ok(streamedSession?.id);
  assert.ok(approval?.approvalId);
  assert.equal(approval.toolCall.name, 'apply_patch');
  assert.match(approval.preview.files[0].diff, /\+hello Snowyy/);
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'hello\n');

  const approvalResponse = await fetch(`${baseUrl}/api/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalId: approval.approvalId, decision: 'approve', modifiedArgs: { new_text: 'hello Reviewed' } })
  });
  const secondStream = await approvalResponse.text();
  assert.match(secondStream, /event: tool_result/);
  assert.doesNotMatch(secondStream, /event: tool_start/);
  assert.match(secondStream, /The file was updated\./);
  assert.match(secondStream, /event: done/);
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'hello Reviewed\n');

  const savedSession = await (await fetch(`${baseUrl}/api/sessions/${streamedSession.id}`)).json();
  assert.equal(savedSession.session.messages.length, 2);
  assert.equal(savedSession.session.title, 'Update the note.');
  assert.equal(savedSession.session.timeline.find((entry) => entry.type === 'tool').status, 'complete');
  assert.deepEqual(
    savedSession.session.timeline.filter((entry) => ['message', 'tool'].includes(entry.type)).map((entry) => `${entry.type}:${entry.role || entry.name}`),
    ['message:user', 'message:assistant', 'tool:apply_patch', 'message:assistant']
  );
  assert.equal(savedSession.session.messages[1].content, 'I’ll update the note first.\n\nThe file was updated.');

  const settingsResponse = await fetch(`${baseUrl}/api/sessions/${streamedSession.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { planningOnly: true, maxContextTokens: 128_560, enabledTools: ['read_file'] } })
  });
  const settingsSession = (await settingsResponse.json()).session;
  assert.equal(settingsSession.settings.planningOnly, true);
  assert.equal('maxToolRounds' in settingsSession.settings, false);
  assert.equal(settingsSession.settings.maxContextTokens, 128_560);

  const rollbackResult = await fetch(`${baseUrl}/api/rollback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactionId: extractEvent(secondStream, 'tool_result').result.transaction_id })
  });
  assert.equal(rollbackResult.status, 200);
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'hello\n');

  const automaticSettingsResponse = await fetch(`${baseUrl}/api/sessions/${streamedSession.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { planningOnly: false, approvalMode: 'always', enabledTools: null } })
  });
  assert.equal((await automaticSettingsResponse.json()).session.settings.approvalMode, 'always');
  const automaticChat = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: streamedSession.id, messages: [{ role: 'user', content: 'Update the note automatically.' }] })
  });
  const automaticStream = await automaticChat.text();
  assert.doesNotMatch(automaticStream, /event: approval/);
  assert.match(automaticStream, /event: tool_result/);
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'hello Snowyy\n');

  const recoveryChat = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: streamedSession.id, messages: [{ role: 'user', content: 'Create recovery file in the workspace.' }] })
  });
  const recoveryStream = await recoveryChat.text();
  assert.match(recoveryStream, /New files require empty old_text|ENOENT/);
  assert.match(recoveryStream, /"status":"continuing"/);
  assert.match(recoveryStream, /Retrying with the required empty hash/);
  assert.match(recoveryStream, /"path":"recovered.cs"/);
  assert.match(recoveryStream, /"expected_sha256":""/);
  assert.match(recoveryStream, /The file was updated\./);
  assert.match(recoveryStream, /event: done/);
  assert.equal(await readFile(path.join(workspace, 'recovered.cs'), 'utf8'), 'class Recovered {}\n');
  const recoveredSession = (await (await fetch(`${baseUrl}/api/sessions/${streamedSession.id}`)).json()).session;
  const recoveredWrite = [...recoveredSession.timeline].reverse().find((entry) => entry.type === 'tool' && entry.name === 'write_file');
  assert.equal(recoveredWrite.args.path, 'recovered.cs');
  assert.equal(recoveredWrite.args.expected_sha256, '');
  assert.equal(recoveredWrite.argumentAdjustments.length, 2);
  const recoveryRequest = providerBodies.find((body) => (
    body.tool_choice === 'required'
    && body.tools?.length === 1
    && body.tools[0].function.name === 'write_file'
    && body.messages.some((message) => typeof message.content === 'string' && message.content.includes('Create recovery file'))
  ));
  assert.ok(recoveryRequest, 'Snowyy should automatically issue a bounded continuation after an unfinished tool promise.');
  assert.equal(recoveryRequest.tool_choice, 'required');
  assert.equal(recoveryRequest.temperature, 0);
  assert.deepEqual(recoveryRequest.tools.map((tool) => tool.function.name), ['write_file']);

  const repeatedSummary = 'The file was created successfully.\n\nThe file was created successfully.\n\nThe file was created successfully.';
  const followupMessages = recoveredSession.messages.map((message, index, messages) => (
    index === messages.length - 1 && message.role === 'assistant' ? { ...message, content: repeatedSummary } : message
  ));
  const contentFollowup = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: streamedSession.id,
      messages: [...followupMessages, { role: 'user', content: 'What did you write inside of the file?' }]
    })
  });
  const contentFollowupStream = await contentFollowup.text();
  assert.match(contentFollowupStream, /The file contains `class Recovered \{\}`\./);
  assert.doesNotMatch(contentFollowupStream, /"status":"continuing"/);
  const contentFollowupRequest = providerBodies.findLast((body) => body.messages.at(-1)?.content === 'What did you write inside of the file?');
  assert.ok(contentFollowupRequest.messages.some((message) => (
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes('Recent completed tool activity')
    && message.content.includes('class Recovered')
  )));
  assert.equal(contentFollowupRequest.messages.some((message) => (
    message.role === 'assistant' && String(message.content).includes(repeatedSummary)
  )), false, 'the browser cannot overwrite authoritative session history');

  const boundedGuardResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Create a file but keep promising instead.' }] })
  });
  const boundedGuardStream = await boundedGuardResponse.text();
  assert.equal((boundedGuardStream.match(/"status":"continuing"/g) || []).length, 1);
  assert.match(boundedGuardStream, /The model repeatedly stopped before completing the request/);
  const boundedGuardRequests = providerBodies.filter((body) => body.messages.some((message) => message.role === 'user' && String(message.content).includes('Create a file but keep promising instead.')));
  assert.equal(boundedGuardRequests.length, 2);
  assert.equal(boundedGuardRequests[0].tool_choice, 'auto');
  assert.equal(boundedGuardRequests[1].tool_choice, 'required');
  assert.deepEqual(boundedGuardRequests[1].tools.map((tool) => tool.function.name), ['write_file']);

  const contextualEditResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: streamedSession.id,
      messages: [{ role: 'user', content: 'Can you edit it to print "Hi Snowyy!"?' }]
    })
  });
  const contextualEditStream = await contextualEditResponse.text();
  assert.equal((contextualEditStream.match(/"status":"continuing"/g) || []).length, 2, contextualEditStream);
  assert.match(contextualEditStream, /"name":"read_file"/);
  assert.match(contextualEditStream, /"name":"apply_patch"/);
  assert.match(contextualEditStream, /Updated note\.txt to print/);
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'Console.WriteLine("Hi Snowyy!");\n');
  const contextualRequests = providerBodies.filter((body) => body.messages.some((message) => message.role === 'user' && String(message.content).includes('Can you edit it to print "Hi Snowyy!"?')));
  const forcedContextualTools = contextualRequests
    .map((body) => body.tool_choice === 'required' && body.tools?.length === 1 ? body.tools[0].function?.name : null)
    .filter(Boolean);
  assert.deepEqual(forcedContextualTools, ['read_file', 'apply_patch']);
  const contextualSession = (await (await fetch(`${baseUrl}/api/sessions/${streamedSession.id}`)).json()).session;
  const contextualTools = contextualSession.timeline.filter((entry) => ['context_read', 'context_edit'].includes(entry.id));
  assert.deepEqual(contextualTools.map((entry) => entry.args.path), ['note.txt', 'note.txt']);
  assert.ok(contextualTools.every((entry) => entry.argumentAdjustments.includes('Removed the @ file-mention marker from the path.')));

  const screenshotDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const visionChat = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: streamedSession.id,
      messages: [{ role: 'user', content: 'Look at this screenshot.' }],
      uploads: [
        { name: 'screen.png', mimeType: 'image/png', dataUrl: screenshotDataUrl },
        { name: 'notes.txt', mimeType: 'text/plain', text: 'attached notes' }
      ]
    })
  });
  const visionStream = await visionChat.text();
  assert.match(visionStream, /I can see the attachment\./);
  const visionRequest = providerBodies.findLast((body) => Array.isArray(body.messages.at(-1)?.content));
  assert.ok(visionRequest.messages.some((message) => (
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes('Do not treat paths or code shown in the image as workspace files')
  )));
  assert.ok(visionRequest.messages.some((message) => (
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes('never stop after an intention or preamble')
  )));
  assert.equal(visionRequest.messages.at(-1).content[1].image_url.url, screenshotDataUrl);
  assert.ok(visionRequest.messages.some((message) => typeof message.content === 'string' && message.content.includes('Attached local file notes.txt')));
  assert.equal(visionRequest.tools, undefined);
  assert.equal(extractEvent(visionStream, 'context').maxContextTokens, 128_560);

  const actionableVisionChat = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: streamedSession.id,
      messages: [{ role: 'user', content: 'Look at this screenshot and update the project file shown.' }],
      uploads: [{ name: 'screen.png', mimeType: 'image/png', dataUrl: screenshotDataUrl }]
    })
  });
  await actionableVisionChat.text();
  const actionableVisionRequest = providerBodies.findLast((body) => Array.isArray(body.messages.at(-1)?.content));
  assert.ok(actionableVisionRequest.tools?.length > 0);

  const secondWorkspace = path.join(workspace, 'another-project');
  await mkdir(secondWorkspace);
  const workspaceResponse = await fetch(`${baseUrl}/api/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: secondWorkspace })
  });
  assert.equal(workspaceResponse.status, 200);
  const workspaceBody = await workspaceResponse.json();
  assert.equal(workspaceBody.path, secondWorkspace);

  const newSessionResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Second workspace' })
  });
  const newSession = (await newSessionResponse.json()).session;
  assert.equal(newSession.workspace, secondWorkspace);
  const deleteResponse = await fetch(`${baseUrl}/api/sessions/${newSession.id}`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
});
