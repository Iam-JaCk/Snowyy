import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkProvider, streamChatCompletion } from '../lib/provider.mjs';

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
  const server = http.createServer((_request, response) => {
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
    messages: [{ role: 'user', content: 'Think.' }], tools: [], onReasoning: (token) => reasoning.push(token)
  });
  assert.equal(reasoning.join(''), 'Inspecting context. Choosing a tool.');
  assert.equal(result.reasoning, 'Inspecting context. Choosing a tool.');
  assert.equal(result.content, 'Done.');
});
