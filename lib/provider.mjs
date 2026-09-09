function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function providerHeaders(config, accept) {
  const headers = { Accept: accept, 'User-Agent': 'Snowyy-Local-Agent/0.6.0' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  try {
    if (new URL(config.baseUrl).hostname === 'openrouter.ai') {
      headers['HTTP-Referer'] = 'http://127.0.0.1';
      headers['X-Title'] = 'Snowyy Local Agent';
    }
  } catch {}
  return headers;
}

function describeUnexpectedBody(url, response, body) {
  const contentType = response.headers.get('content-type') || 'unknown content type';
  const compact = body.replace(/\s+/g, ' ').trim().slice(0, 180);
  const kind = /<\s*!doctype|<\s*html/i.test(body) ? 'an HTML page' : 'a non-JSON response';
  return `Provider returned ${kind} from ${url} (${response.status}, ${contentType}).${compact ? ` Response began: ${compact}` : ''}`;
}

function mergeToolDelta(toolCalls, deltaCalls = []) {
  for (const delta of deltaCalls) {
    const index = delta.index ?? 0;
    if (!toolCalls[index]) {
      toolCalls[index] = { id: delta.id || '', type: 'function', function: { name: '', arguments: '' } };
    }
    const target = toolCalls[index];
    if (delta.id) target.id = delta.id;
    if (delta.function?.name) target.function.name += delta.function.name;
    if (delta.function?.arguments) target.function.arguments += delta.function.arguments;
  }
}

export async function streamChatCompletion({ config, messages, tools, toolChoice = 'auto', temperature, signal, onToken, onReasoning }) {
  const url = joinUrl(config.baseUrl, 'chat/completions');
  const headers = { ...providerHeaders(config, 'text/event-stream, application/json'), 'Content-Type': 'application/json' };
  const requestBody = { model: config.model, messages, stream: true, stream_options: { include_usage: true } };
  if (Number.isFinite(temperature)) requestBody.temperature = temperature;
  if (tools?.length) Object.assign(requestBody, { tools, tool_choice: toolChoice });
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000);
    throw new Error(`Model endpoint returned ${response.status}: ${detail || response.statusText}`);
  }
  const responseType = response.headers.get('content-type') || '';
  if (responseType.includes('text/html')) {
    const body = await response.text();
    throw new Error(describeUnexpectedBody(url, response, body));
  }
  if (!response.body) throw new Error('Model endpoint returned no response body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;
  const toolCalls = [];
  let usage = null;

  function consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const raw = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!raw || raw === '[DONE]') return;
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.error) throw new Error(event.error.message || 'Model endpoint returned an error.');
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') {
      content += delta.content;
      onToken?.(delta.content);
    }
    const reasoningDelta = [delta.reasoning_content, delta.reasoning, delta.thinking].find((value) => typeof value === 'string');
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      onReasoning?.(reasoningDelta);
    }
    if (delta.tool_calls) mergeToolDelta(toolCalls, delta.tool_calls);
    if (!choice.delta && choice.message) {
      if (typeof choice.message.content === 'string') {
        content += choice.message.content;
        onToken?.(choice.message.content);
      }
      const messageReasoning = [choice.message.reasoning_content, choice.message.reasoning, choice.message.thinking].find((value) => typeof value === 'string');
      if (messageReasoning) {
        reasoning += messageReasoning;
        onReasoning?.(messageReasoning);
      }
      if (choice.message.tool_calls) mergeToolDelta(toolCalls, choice.message.tool_calls.map((call, index) => ({ ...call, index })));
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer.trim()) consumeLine(buffer);

  return {
    role: 'assistant',
    content: content || null,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    finish_reason: finishReason,
    usage
  };
}

export async function checkProvider(config) {
  const url = joinUrl(config.baseUrl, 'models');
  const response = await fetch(url, { headers: providerHeaders(config, 'application/json'), signal: AbortSignal.timeout(8_000) });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 500);
    try { detail = JSON.parse(text).error?.message || JSON.parse(text).error || detail; } catch {}
    throw new Error(`Provider returned ${response.status} from ${url}: ${detail || response.statusText}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(describeUnexpectedBody(url, response, text));
  }
  const models = Array.isArray(body.data) ? body.data.map((item) => item.id).filter(Boolean) : [];
  return { ok: true, models };
}
