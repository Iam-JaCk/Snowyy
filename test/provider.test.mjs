import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkProvider, streamChatCompletion } from '../lib/provider.mjs';

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('Snowyy provider adapter merges streamed text and tool-call arguments', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"Checking "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"files."}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const tokens = [];
  const result = await streamChatCompletion({
    config: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test', apiKey: '' },
    messages: [{ role: 'user', content: 'Inspect the readme' }],
    tools: [],
    onToken: (token) => tokens.push(token)
  });

  assert.equal(tokens.join(''), 'Checking files.');
  assert.equal(result.content, 'Checking files.');
  assert.equal(result.tool_calls[0].id, 'call_1');
  assert.equal(result.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments), { path: 'README.md' });
});

test('provider checks turn HTML responses into actionable errors', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!DOCTYPE html><html><body>Proxy login required</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  await assert.rejects(
    checkProvider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test', apiKey: '' }),
    /Provider returned an HTML page.*Proxy login required/
  );
});

test('provider forwards a separate model reasoning stream', async (t) => {
  let requestBody;
  const server = http.createServer(async (request, response) => {
    requestBody = await readJsonRequest(request);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"Inspecting context. "}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"reasoning":"Choosing a tool."}}]}\n\n');
    response.end('data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const reasoning = [];
  const result = await streamChatCompletion({
    config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test', apiKey: '' },
    messages: [{ role: 'user', content: 'Think.' }], tools: [], reasoningEffort: 'high', onReasoning: (token) => reasoning.push(token)
  });
  assert.equal(requestBody.reasoning_effort, 'high');
  assert.equal(reasoning.join(''), 'Inspecting context. Choosing a tool.');
  assert.equal(result.reasoning, 'Inspecting context. Choosing a tool.');
  assert.equal(result.reasoning_field, 'reasoning_content');
  assert.equal(result.content, 'Done.');
});

test('xhigh reasoning retries as the equivalent max level when the endpoint uses that name', async (t) => {
  const efforts = [];
  const server = http.createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    efforts.push(body.reasoning_effort);
    if (body.reasoning_effort === 'xhigh') {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unsupported reasoning_effort xhigh' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Used max.' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await streamChatCompletion({
    config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test', apiKey: '' },
    messages: [{ role: 'user', content: 'Think carefully.' }], tools: [], reasoningEffort: 'xhigh'
  });
  assert.deepEqual(efforts, ['xhigh', 'max']);
  assert.equal(result.content, 'Used max.');
});

test('reasoning effort is omitted on retry when an endpoint does not support the parameter', async (t) => {
  const efforts = [];
  const server = http.createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    efforts.push(body.reasoning_effort ?? null);
    if (Object.hasOwn(body, 'reasoning_effort')) {
      response.writeHead(422, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'reasoning_effort is not supported' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'Compatible fallback.' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await streamChatCompletion({
    config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test', apiKey: '' },
    messages: [{ role: 'user', content: 'Answer.' }], tools: [], reasoningEffort: 'medium'
  });
  assert.deepEqual(efforts, ['medium', null]);
  assert.equal(result.content, 'Compatible fallback.');
});

test('provider accepts a non-streamed JSON fallback and identifies incomplete streams', async (t) => {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Fallback response.' }, finish_reason: 'stop' }] }, null, 2));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"Partial response."}}]}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = {
    config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test', apiKey: '' },
    messages: [{ role: 'user', content: 'Answer.' }],
    tools: []
  };
  const fallback = await streamChatCompletion(options);
  assert.equal(fallback.content, 'Fallback response.');
  assert.equal(fallback.stream_complete, true);
  const interrupted = await streamChatCompletion(options);
  assert.equal(interrupted.content, 'Partial response.');
  assert.equal(interrupted.stream_complete, false);
});
