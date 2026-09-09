const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uiHelpers = globalThis.SnowyyUiHelpers;

// Keep chat usable when the page is connected to an older Snowyy server that
// does not know about the standalone markdown.js asset yet.
const fallbackMarkdownRenderer = (() => {
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function inline(value) {
    const code = [];
    let output = escapeHtml(value).replace(/`([^`\n]+)`/g, (_match, content) => {
      const token = `SNOWYYFALLBACKCODE${code.length}TOKEN`;
      code.push(`<code>${content}</code>`);
      return token;
    });
    output = output
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    code.forEach((replacement, index) => {
      output = output.replace(`SNOWYYFALLBACKCODE${index}TOKEN`, replacement);
    });
    return output;
  }

  function renderInto(container, value) {
    const text = String(value)
      .replace(/\s+(?=\d+[.)]\s+\*\*)/g, '\n')
      .replace(/\s+(?=[-*]\s+\*\*)/g, '\n');
    const blocks = [];
    let paragraph = [];
    let listType = null;
    let items = [];
    const flushParagraph = () => {
      if (paragraph.length) blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (items.length) blocks.push(`<${listType}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${listType}>`);
      items = [];
      listType = null;
    };

    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? 'ul' : 'ol';
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        items.push((unordered || ordered)[1]);
      } else if (!line.trim()) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line.trim());
      }
    }
    flushParagraph();
    flushList();
    container.innerHTML = blocks.join('');
  }

  return { renderInto };
})();

function renderAssistantMarkdown(container, value) {
  const renderer = globalThis.SnowyyMarkdown?.renderInto
    ? globalThis.SnowyyMarkdown
    : fallbackMarkdownRenderer;
  renderer.renderInto(container, value);
}

const conversation = $('#conversation');
const conversationInner = $('.conversation-inner');
const form = $('#composerForm');
const input = $('#promptInput');
const sendButton = $('#sendButton');
const modelSelect = $('#modelSelect');
const modelMenu = $('#modelMenu');
const modelName = $('#modelName');
const permissionToast = $('#permissionToast');
const sidebar = $('#sidebar');
const scrim = $('#sidebarScrim');
const settingsModal = $('#settingsModal');
const workspaceModal = $('#workspaceModal');
const approvalModal = $('#approvalModal');
const fileDrawer = $('#fileDrawer');
let conversationHistory = [];
let activeSessionId = null;
let currentWorkspace = '';
let activeAssistant = null;
let activeApprovalId = null;
let streamedAssistantText = '';
let streamedRoundText = '';
let activeStreamParagraph = null;
let activeReasoningBlock = null;
let activeReasoningText = '';
let streamSegmentPending = false;
let requestController = null;
let messageCount = 0;
let activeApprovalEvent = null;
let activeDiffIndex = 0;
let currentSettings = { planningOnly: false, maxContextTokens: 32_000, approvalMode: 'ask', enabledTools: null };
let currentGoals = [];
const attachedFiles = new Set();
const uploadedAttachments = new Map();
const modifiedFiles = new Set();
const allToolNames = ['list_directory', 'find_files', 'search_text', 'read_file', 'web_search', 'fetch_url', 'list_goals', 'create_goal', 'update_goal', 'delete_goal', 'apply_patch', 'write_file', 'insert_text', 'replace_lines', 'delete_lines', 'apply_changes', 'rollback_change', 'run_command'];
let mentionSearchTimer = null;
let mentionSearchRequest = 0;
let mentionResults = [];
let mentionSelection = 0;
let currentMention = null;

function normalizeClientSettings(settings = {}) {
  return {
    planningOnly: false,
    maxContextTokens: 32_000,
    approvalMode: 'ask',
    enabledTools: null,
    ...settings
  };
}

function currentTime() {
  return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function formatTokenCount(value) {
  const tokens = Math.max(Number(value) || 0, 0);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}k`;
  return String(tokens);
}

function attachmentCount() {
  return attachedFiles.size + uploadedAttachments.size;
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 145)}px`;
  const running = Boolean(requestController);
  sendButton.disabled = !running && !input.value.trim() && attachmentCount() === 0;
  sendButton.classList.toggle('stop', running);
  sendButton.innerHTML = running
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 19V5"/></svg>';
  sendButton.setAttribute('aria-label', running ? 'Stop Snowyy' : 'Send message');
}

function scrollToBottom() {
  conversation.scrollTop = conversation.scrollHeight;
}

function setRunning(running) {
  if (!running) requestController = null;
  input.disabled = running || Boolean(activeApprovalId);
  resizeInput();
  $('.topbar p').innerHTML = running
    ? '<span class="live-dot"></span> Agent working'
    : '<span class="live-dot"></span> Session ready';
}

function removeThinking(message = activeAssistant) {
  $('.thinking-row', message)?.remove();
}

function appendUserMessage(copy, attachments = []) {
  const fragment = $('#userMessageTemplate').content.cloneNode(true);
  $('.message-meta span', fragment).textContent = currentTime();
  $('.dynamic-copy', fragment).textContent = copy || 'Attached files';
  if (attachments.length) {
    const preview = document.createElement('div');
    preview.className = 'message-attachments';
    attachments.forEach((attachment) => {
      if (attachment.dataUrl) {
        const image = document.createElement('img');
        image.src = attachment.dataUrl;
        image.alt = attachment.name;
        image.title = attachment.name;
        preview.append(image);
      } else {
        const chip = document.createElement('span');
        chip.textContent = attachment.name || attachment;
        preview.append(chip);
      }
    });
    $('.message-body', fragment).append(preview);
  }
  conversationInner.append(fragment);
}

function appendCommandNotice(title, message) {
  const assistant = appendAssistantMessage();
  removeThinking(assistant);
  const notice = document.createElement('div');
  notice.className = 'command-notice';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = message;
  notice.append(strong, copy);
  $('.message-body', assistant).append(notice);
  scrollToBottom();
}

function appendAssistantMessage() {
  const fragment = $('#assistantMessageTemplate').content.cloneNode(true);
  $('.message-meta span', fragment).textContent = currentTime();
  conversationInner.append(fragment);
  return conversationInner.lastElementChild;
}

function assistantParagraph() {
  if (!activeStreamParagraph?.isConnected) {
    activeStreamParagraph = document.createElement('div');
    activeStreamParagraph.className = 'streamed-copy markdown-body';
    $('.message-body', activeAssistant).append(activeStreamParagraph);
  }
  return activeStreamParagraph;
}

function beginAssistantSegment() {
  if (activeReasoningBlock) activeReasoningBlock.open = false;
  activeStreamParagraph = null;
  activeReasoningBlock = null;
  activeReasoningText = '';
  streamedRoundText = '';
  streamSegmentPending = true;
}

function appendReasoning(token, targetAssistant = activeAssistant) {
  if (!targetAssistant) return;
  removeThinking(targetAssistant);
  if (!activeReasoningBlock?.isConnected) {
    activeReasoningBlock = document.createElement('details');
    activeReasoningBlock.className = 'reasoning-block';
    activeReasoningBlock.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Model reasoning';
    const pre = document.createElement('pre');
    activeReasoningBlock.append(summary, pre);
    $('.message-body', targetAssistant).append(activeReasoningBlock);
    activeReasoningText = '';
  }
  activeReasoningText += token;
  $('pre', activeReasoningBlock).textContent = activeReasoningText;
  scrollToBottom();
}

function renderReasoning(content, targetAssistant) {
  const previousBlock = activeReasoningBlock;
  const previousText = activeReasoningText;
  activeReasoningBlock = null;
  activeReasoningText = '';
  appendReasoning(content, targetAssistant);
  if (activeReasoningBlock) activeReasoningBlock.open = false;
  activeReasoningBlock = previousBlock;
  activeReasoningText = previousText;
}

function appendToken(token) {
  removeThinking();
  if (activeReasoningBlock) activeReasoningBlock.open = false;
  if (streamSegmentPending) {
    if (streamedAssistantText.trim()) streamedAssistantText += '\n\n';
    streamSegmentPending = false;
  }
  streamedAssistantText += token;
  streamedRoundText += token;
  renderAssistantMarkdown(assistantParagraph(), streamedRoundText);
  scrollToBottom();
}

function toolIconSvg(name) {
  return name === 'run_command'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 8 4 4-4 4M13 16h4"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg>'
    : name === 'apply_patch' || name === 'write_file'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11Z" /></svg>';
}

function createToolCard(toolCall, targetAssistant = activeAssistant) {
  removeThinking(targetAssistant);
  const existing = $(`[data-tool-id="${CSS.escape(toolCall.id)}"]`, targetAssistant);
  if (existing) return;
  const card = document.createElement('div');
  card.className = 'tool-card running entering';
  card.dataset.toolId = toolCall.id;
  card.dataset.toolName = toolCall.name;

  const header = document.createElement('button');
  header.className = 'tool-card-header';
  header.setAttribute('aria-expanded', 'true');

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.innerHTML = toolIconSvg(toolCall.name);

  const title = document.createElement('span');
  title.className = 'tool-title';
  const strong = document.createElement('strong');
  strong.textContent = toolCall.name;
  const target = document.createElement('code');
  target.textContent = toolCall.summary?.detail || toolCall.args?.path || toolCall.args?.query || '';
  title.append(strong, target);

  const state = document.createElement('span');
  state.className = 'tool-state';
  state.innerHTML = '<i>·</i><span>running</span>';
  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.textContent = '⌄';
  header.append(icon, title, state, chevron);

  const output = document.createElement('div');
  output.className = 'tool-output code-output';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(toolCall.args, null, 2);
  output.append(pre);
  if (toolCall.name === 'run_command') {
    const live = document.createElement('pre');
    live.className = 'command-live-output';
    live.hidden = true;
    const controls = document.createElement('div');
    controls.className = 'command-controls';
    for (const [action, label] of [['pause', 'Pause'], ['stop', 'Stop']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.commandAction = action;
      button.textContent = label;
      controls.append(button);
    }
    output.append(live, controls);
  }
  card.append(header, output);
  $('.message-body', targetAssistant).append(card);
  scrollToBottom();
}

function updateToolCard(event, targetAssistant = activeAssistant) {
  const card = $(`[data-tool-id="${CSS.escape(event.id)}"]`, targetAssistant);
  if (!card) return;
  card.classList.remove('running');
  card.classList.add(event.ok ? 'success' : 'failed');
  const state = $('.tool-state', card);
  state.innerHTML = '';
  const indicator = document.createElement('i');
  indicator.textContent = event.ok ? '✓' : event.denied ? '–' : '!';
  const label = document.createElement('span');
  label.textContent = event.ok ? 'complete' : event.denied ? 'denied' : 'failed';
  state.append(indicator, label);
  $('.tool-output pre', card).textContent = JSON.stringify(event.result, null, 2);
  $$('.command-controls button', card).forEach((button) => { button.disabled = true; });
  const changedPaths = event.result?.files?.map((file) => file.path) || (event.result?.path ? [event.result.path] : []);
  changedPaths.forEach((filePath) => modifiedFiles.add(filePath));
  if (event.result?.transaction_id) {
    const undo = document.createElement('button');
    undo.className = 'secondary-button rollback-button';
    undo.textContent = 'Undo change';
    undo.addEventListener('click', async () => {
      if (!window.confirm('Roll back this change? Rollback is refused if any affected file changed afterward.')) return;
      undo.disabled = true;
      try {
        await apiJson('/api/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactionId: event.result.transaction_id }) });
        undo.textContent = 'Rolled back';
      } catch (error) {
        undo.disabled = false;
        window.alert(error.message);
      }
    });
    $('.tool-output', card).append(undo);
  }
  scrollToBottom();
}

function appendCommandOutput(event) {
  const card = document.querySelector(`[data-tool-id="${CSS.escape(event.id)}"]`);
  const output = card && $('.command-live-output', card);
  if (!output) return;
  output.hidden = false;
  output.textContent = `${output.textContent}${event.chunk || ''}`.slice(-30_000);
  output.scrollTop = output.scrollHeight;
  scrollToBottom();
}

function updateCommandState(event) {
  const card = document.querySelector(`[data-tool-id="${CSS.escape(event.id)}"]`);
  if (!card) return;
  const label = $('.tool-state span', card);
  if (label && event.state !== 'complete') label.textContent = event.state;
  const pause = $('[data-command-action="pause"]', card);
  if (pause) {
    pause.dataset.commandAction = event.state === 'paused' ? 'resume' : 'pause';
    pause.textContent = event.state === 'paused' ? 'Resume' : 'Pause';
    pause.disabled = ['complete', 'stopping'].includes(event.state);
  }
  const stop = $('[data-command-action="stop"]', card);
  if (stop) stop.disabled = ['complete', 'stopping'].includes(event.state);
}

async function controlCommand(button) {
  const card = button.closest('[data-tool-id]');
  if (!card) return;
  const action = button.dataset.commandAction;
  button.disabled = true;
  try {
    const result = await apiJson(`/api/commands/${encodeURIComponent(card.dataset.toolId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action })
    });
    updateCommandState({ id: card.dataset.toolId, state: result.state });
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
}

function showApproval(event) {
  activeApprovalEvent = event;
  activeDiffIndex = 0;
  activeApprovalId = event.approvalId;
  $('#permissionTitle').textContent = event.toolCall.summary?.title || `Approve ${event.toolCall.name}`;
  $('#permissionDetail').textContent = event.toolCall.summary?.detail || 'Review this tool call before continuing.';
  permissionToast.classList.add('visible');
  openApprovalReview();
  setRunning(false);
  input.disabled = true;
}

function renderApprovalDiff() {
  const preview = activeApprovalEvent?.preview;
  const files = preview?.files || [];
  const tabs = $('#diffTabs');
  tabs.replaceChildren();
  files.forEach((file, index) => {
    const button = document.createElement('button');
    button.textContent = file.path;
    button.className = index === activeDiffIndex ? 'active' : '';
    button.addEventListener('click', () => { activeDiffIndex = index; renderApprovalDiff(); });
    tabs.append(button);
  });
  $('#diffView').textContent = preview?.kind === 'error' ? `Preview error: ${preview.error}` : files[activeDiffIndex]?.diff || preview?.diff || 'No textual diff available.';
}

function openApprovalReview() {
  if (!activeApprovalEvent) return;
  $('#approvalModalTitle').textContent = activeApprovalEvent.toolCall.summary?.title || 'Approval required';
  $('#approvalModalDetail').textContent = activeApprovalEvent.toolCall.summary?.detail || '';
  $('#proposalEditor').hidden = true;
  $('#editProposal').hidden = !['apply_patch', 'write_file', 'insert_text', 'replace_lines'].includes(activeApprovalEvent.toolCall.name);
  renderApprovalDiff();
  approvalModal.classList.add('visible');
  approvalModal.setAttribute('aria-hidden', 'false');
}

function closeApprovalReview() {
  approvalModal.classList.remove('visible');
  approvalModal.setAttribute('aria-hidden', 'true');
}

function showError(message) {
  removeThinking();
  const block = document.createElement('div');
  block.className = 'error-block';
  const strong = document.createElement('strong');
  strong.textContent = 'Agent stopped';
  const copy = document.createElement('p');
  copy.textContent = message;
  block.append(strong, copy);
  $('.message-body', activeAssistant).append(block);
  scrollToBottom();
}

function finishResponse() {
  removeThinking();
  if (activeReasoningBlock) activeReasoningBlock.open = false;
  if (streamedAssistantText.trim()) conversationHistory.push({ role: 'assistant', content: streamedAssistantText });
  activeAssistant = null;
  streamedAssistantText = '';
  streamedRoundText = '';
  activeStreamParagraph = null;
  activeReasoningBlock = null;
  activeReasoningText = '';
  activeReasoningBlock = null;
  activeReasoningText = '';
  streamSegmentPending = false;
  activeApprovalId = null;
  activeApprovalEvent = null;
  permissionToast.classList.remove('visible');
  closeApprovalReview();
  messageCount += 1;
  const tokens = 1100 + conversationHistory.reduce((total, item) => total + item.content.length / 4, 0);
  updateContextMeter(tokens);
  setRunning(false);
  input.focus();
}

async function consumeEventStream(response, handlers) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || `Request failed with ${response.status}.`);
  }
  if (!response.body) throw new Error('The server returned no event stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function consumeBlock(block) {
    if (!block.trim()) return;
    let type = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const parsed = JSON.parse(data.join('\n'));
    handlers[type]?.(parsed);
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.forEach(consumeBlock);
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
}

async function readApiJson(response, routeDescription) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (/<\s*!doctype|<\s*html/i.test(text)) {
      throw new Error(`Snowyy received HTML from ${routeDescription}. Start the app with “npm start” and open http://127.0.0.1:4173 — do not open index.html directly or use Live Server.`);
    }
    throw new Error(`Snowyy received an invalid response from ${routeDescription}.`);
  }
  if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}.`);
  return body;
}

async function runAgentRequest(url, payload) {
  requestController = new AbortController();
  setRunning(true);
  let paused = false;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: requestController.signal
  });
  await consumeEventStream(response, {
    session: (event) => {
      activeSessionId = event.id;
      currentSettings = normalizeClientSettings(event.settings || currentSettings);
      renderGoals(event.goals || currentGoals);
      syncSessionControls();
    },
    session_updated: (event) => {
      $('#sessionTitle').textContent = event.title;
      loadSessions();
    },
    token: ({ token }) => appendToken(token),
    reasoning: ({ token }) => appendReasoning(token),
    tool_start: (event) => {
      createToolCard(event);
      beginAssistantSegment();
    },
    tool_result: updateToolCard,
    command_output: appendCommandOutput,
    command_state: updateCommandState,
    goals: ({ goals }) => renderGoals(goals),
    approval: (event) => { paused = true; showApproval(event); },
    paused: () => { paused = true; },
    status: ({ status, seamless }) => {
      if (status === 'continuing' && !seamless) beginAssistantSegment();
      if (status === 'compacting') $('.topbar p').innerHTML = '<span class="live-dot"></span> Compacting context';
    },
    error: ({ message }) => showError(message),
    context: ({ estimatedTokens, maxContextTokens }) => updateContextMeter(estimatedTokens, null, maxContextTokens),
    usage: (usage) => updateContextMeter(usage.total_tokens || usage.totalTokens || 0, usage.cost),
    done: ({ finishReason }) => {
      if (finishReason === 'length') {
        showError('The model reached its token or context limit before finishing. Start a new session, reduce attachments, or raise the Ollama context allocation.');
      }
      finishResponse();
    }
  });
  if (!paused && activeAssistant) finishResponse();
}

async function sendPrompt(prompt) {
  const workspaceAttachments = [...attachedFiles];
  const uploads = [...uploadedAttachments.values()];
  const displayAttachments = [
    ...workspaceAttachments.map((name) => ({ name })),
    ...uploads.map(({ name, dataUrl }) => ({ name, dataUrl }))
  ];
  const userPrompt = prompt || 'Please inspect the attached files.';
  appendUserMessage(userPrompt, displayAttachments);
  conversationHistory.push({ role: 'user', content: userPrompt });
  activeAssistant = appendAssistantMessage();
  streamedAssistantText = '';
  streamedRoundText = '';
  activeStreamParagraph = null;
  streamSegmentPending = false;
  scrollToBottom();
  try {
    attachedFiles.clear();
    uploadedAttachments.clear();
    updateAttachmentPill();
    await runAgentRequest('/api/chat', { messages: [{ role: 'user', content: userPrompt }], sessionId: activeSessionId, attachments: workspaceAttachments, uploads });
  } catch (error) {
    if (error.name !== 'AbortError') {
      showError(error.message);
      finishResponse();
    }
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  closeMentionMenu();
  if (requestController) {
    requestController.abort();
    requestController = null;
    $$('.tool-card.running', activeAssistant).forEach((card) => {
      card.classList.remove('running');
      card.classList.add('failed');
      $('.tool-state', card).innerHTML = '<i>–</i><span>cancelled</span>';
    });
    if (activeAssistant) {
      showError('Stopped by user.');
      finishResponse();
    }
    return;
  }
  const prompt = input.value.trim();
  if ((!prompt && attachmentCount() === 0) || requestController || activeApprovalId) return;
  input.value = '';
  resizeInput();
  if (prompt.startsWith('/')) {
    handleSlashCommand(prompt).catch((error) => appendCommandNotice('Command failed', error.message));
    return;
  }
  sendPrompt(prompt);
});

function updateContextMeter(tokens, cost = null, maximum = null) {
  const value = Math.max(Number(tokens) || 0, 0);
  const maxContext = Math.max(Number(maximum || currentSettings.maxContextTokens) || 32_000, 1_000);
  currentSettings.maxContextTokens = maxContext;
  $('#contextValue').textContent = `${formatTokenCount(value)} / ${formatTokenCount(maxContext)}`;
  $('#contextBar').style.width = `${Math.min((value / maxContext) * 100, 100)}%`;
  $('#contextValue').title = cost == null ? `${value} estimated tokens` : `${value} tokens · $${Number(cost).toFixed(6)}`;
}

function updateAttachmentPill() {
  const pill = $('#attachmentPill');
  const count = attachmentCount();
  pill.hidden = count === 0;
  pill.textContent = `${count} file${count === 1 ? '' : 's'} attached`;
  renderAttachmentPreviews();
  resizeInput();
}

function attachWorkspaceFile(filePath) {
  if (!attachedFiles.has(filePath) && attachedFiles.size >= 10) {
    window.alert('You can attach up to 10 workspace files per message.');
    return false;
  }
  attachedFiles.add(filePath);
  updateAttachmentPill();
  return true;
}

function renderAttachmentPreviews() {
  const strip = $('#attachmentPreviewStrip');
  strip.replaceChildren();
  attachedFiles.forEach((filePath) => {
    const item = document.createElement('span');
    item.className = 'attachment-preview-item file';
    const name = document.createElement('span');
    name.textContent = filePath;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${filePath}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      attachedFiles.delete(filePath);
      updateAttachmentPill();
    });
    item.append(name, remove);
    strip.append(item);
  });
  uploadedAttachments.forEach((attachment, id) => {
    const item = document.createElement('span');
    item.className = `attachment-preview-item ${attachment.dataUrl ? 'image' : 'file'}`;
    if (attachment.dataUrl) {
      const image = document.createElement('img');
      image.src = attachment.dataUrl;
      image.alt = '';
      item.append(image);
    }
    const name = document.createElement('span');
    name.textContent = attachment.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      uploadedAttachments.delete(id);
      updateAttachmentPill();
    });
    item.append(name, remove);
    strip.append(item);
  });
  strip.hidden = attachmentCount() === 0;
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(reader.error || new Error(`Could not read ${file.name}.`)));
    reader.readAsDataURL(file);
  });
}

async function addLocalAttachments(files) {
  const textExtensions = /\.(?:txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|html|xml|ya?ml|toml|csv|lua|luau|py|java|c|h|cpp|hpp|rs|go|sql|sh|ps1)$/i;
  for (const file of [...files]) {
    if (uploadedAttachments.size >= 6) throw new Error('You can attach up to 6 local files per message.');
    const id = `${file.name}:${file.size}:${file.lastModified}`;
    if (uploadedAttachments.has(id)) continue;
    if (/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type)) {
      if (file.size > 4_000_000) throw new Error(`${file.name} exceeds the 4 MB image limit.`);
      uploadedAttachments.set(id, { name: file.name || 'screenshot.png', mimeType: file.type, size: file.size, dataUrl: await fileAsDataUrl(file) });
    } else if (file.type.startsWith('text/') || textExtensions.test(file.name)) {
      if (file.size > 500_000) throw new Error(`${file.name} exceeds the 500 KB text attachment limit.`);
      uploadedAttachments.set(id, { name: file.name, mimeType: file.type || 'text/plain', size: file.size, text: await file.text() });
    } else {
      throw new Error(`${file.name} is not a supported image or text attachment.`);
    }
  }
  updateAttachmentPill();
}

const slashCommands = [
  { command: '/plan', detail: 'Enable planning-only mode' },
  { command: '/plan off', detail: 'Return to agent mode' },
  { command: '/context', detail: 'Show the current context limit' },
  { command: '/context 128000', detail: 'Set a context-token limit' },
  { command: '/approve always', detail: 'Auto-approve writes and commands' },
  { command: '/approve ask', detail: 'Require approval again' },
  { command: '/files', detail: 'Browse workspace files' },
  { command: '/settings', detail: 'Open model and agent settings' },
  { command: '/new', detail: 'Start a new session' },
  { command: '/help', detail: 'List slash commands' }
];

function renderSlashMenu() {
  const menu = $('#slashMenu');
  const query = input.value.trim().toLowerCase();
  if (!query.startsWith('/') || query.includes('\n')) {
    menu.hidden = true;
    return;
  }
  const matches = slashCommands.filter((item) => item.command.startsWith(query) || item.command.split(' ')[0] === query.split(' ')[0]).slice(0, 6);
  menu.replaceChildren();
  matches.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    const command = document.createElement('strong');
    command.textContent = item.command;
    const detail = document.createElement('span');
    detail.textContent = item.detail;
    button.append(command, detail);
    button.addEventListener('click', () => {
      input.value = item.command;
      menu.hidden = true;
      resizeInput();
      input.focus();
    });
    menu.append(button);
  });
  menu.hidden = matches.length === 0;
}

function activeMentionAtCursor() {
  const cursor = input.selectionStart;
  if (!Number.isInteger(cursor)) return null;
  const beforeCursor = input.value.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@"']*)$/);
  if (!match) return null;
  const start = beforeCursor.lastIndexOf('@');
  return { start, end: cursor, query: match[1] };
}

function closeMentionMenu() {
  window.clearTimeout(mentionSearchTimer);
  mentionSearchTimer = null;
  mentionSearchRequest += 1;
  mentionResults = [];
  mentionSelection = 0;
  currentMention = null;
  $('#mentionMenu').hidden = true;
}

function mentionPathParts(filePath) {
  return uiHelpers.mentionPathParts(filePath);
}

function rankMentionResults(files, query) {
  const needle = query.toLowerCase();
  return [...files]
    .filter((filePath) => !/(?:^|[\\/])(?:out|coverage)(?:[\\/]|$)/i.test(filePath))
    .sort((left, right) => {
      const leftName = mentionPathParts(left).name.toLowerCase();
      const rightName = mentionPathParts(right).name.toLowerCase();
      const score = (name, fullPath) => (name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : fullPath.toLowerCase().startsWith(needle) ? 3 : 4);
      return score(leftName, left) - score(rightName, right) || left.length - right.length || left.localeCompare(right);
    })
    .slice(0, 8);
}

function setMentionSelection(index) {
  mentionSelection = index;
  $$('#mentionMenu button').forEach((button, buttonIndex) => {
    const selected = buttonIndex === mentionSelection;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    if (selected) button.scrollIntoView({ block: 'nearest' });
  });
}

function renderMentionMenu(status = '') {
  const menu = $('#mentionMenu');
  menu.replaceChildren();
  if (status || mentionResults.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'mention-empty';
    empty.textContent = status || 'No matching workspace files';
    menu.append(empty);
    menu.hidden = false;
    return;
  }
  mentionResults.forEach((filePath, index) => {
    const parts = mentionPathParts(filePath);
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.toggle('active', index === mentionSelection);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === mentionSelection));
    const name = document.createElement('strong');
    name.textContent = `@${parts.name}`;
    const parent = document.createElement('span');
    parent.textContent = parts.parent;
    button.append(name, parent);
    button.addEventListener('mouseenter', () => setMentionSelection(index));
    button.addEventListener('click', () => selectMention(index));
    menu.append(button);
  });
  menu.hidden = false;
}

function selectMention(index = mentionSelection) {
  const filePath = mentionResults[index];
  const mention = activeMentionAtCursor() || currentMention;
  if (!filePath || !mention || !attachWorkspaceFile(filePath)) return;
  const token = /\s/.test(filePath) ? `@"${filePath}"` : `@${filePath}`;
  input.setRangeText(`${token} `, mention.start, mention.end, 'end');
  closeMentionMenu();
  resizeInput();
  input.focus();
}

async function loadMentionResults(mention, requestId) {
  try {
    const result = await apiJson(`/api/files?path=.&q=${encodeURIComponent(mention.query)}`);
    const latest = activeMentionAtCursor();
    if (requestId !== mentionSearchRequest || !latest || latest.start !== mention.start || latest.query !== mention.query) return;
    currentMention = latest;
    mentionResults = rankMentionResults(result.files || [], mention.query);
    mentionSelection = 0;
    renderMentionMenu();
  } catch (error) {
    if (requestId !== mentionSearchRequest) return;
    mentionResults = [];
    renderMentionMenu(error.message || 'Could not search workspace files');
  }
}

function scheduleMentionMenu() {
  window.clearTimeout(mentionSearchTimer);
  const mention = activeMentionAtCursor();
  if (!mention) {
    closeMentionMenu();
    return;
  }
  $('#slashMenu').hidden = true;
  currentMention = mention;
  mentionResults = [];
  mentionSelection = 0;
  renderMentionMenu('Finding workspace files…');
  const requestId = ++mentionSearchRequest;
  mentionSearchTimer = window.setTimeout(() => loadMentionResults(mention, requestId), 120);
}

function parseTokenLimit(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!match) return NaN;
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

async function patchSessionSettings(changes) {
  if (!activeSessionId) await createNewSession();
  const updated = await apiJson(`/api/sessions/${activeSessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: changes })
  });
  currentSettings = normalizeClientSettings(updated.session.settings);
  syncSessionControls();
  return currentSettings;
}

function syncSessionControls() {
  const planning = Boolean(currentSettings.planningOnly);
  const modePill = $('.mode-pill');
  modePill.innerHTML = '<span class="live-dot"></span>';
  modePill.append(document.createTextNode(planning ? ' Plan mode' : ' Agent mode'));
  modePill.title = currentSettings.approvalMode === 'always' ? 'Writes and commands are auto-approved' : 'Writes and commands require approval';
  updateContextMeter(Number($('#contextValue').title.match(/^\d+/)?.[0]) || 0);
}

async function handleSlashCommand(rawCommand) {
  const commandLine = rawCommand.trim();
  const [command, ...argumentsList] = commandLine.split(/\s+/);
  const argument = argumentsList.join(' ').toLowerCase();
  $('#slashMenu').hidden = true;
  appendUserMessage(commandLine);

  if (command === '/plan') {
    const planningOnly = argument === 'off' ? false : argument === 'on' || !argument ? true : null;
    if (planningOnly === null) throw new Error('Use /plan, /plan on, or /plan off.');
    await patchSessionSettings({ planningOnly });
    appendCommandNotice('Mode updated', planningOnly ? 'Planning-only mode is enabled. Tools are disabled.' : 'Agent mode is enabled.');
    return;
  }
  if (command === '/context') {
    if (!argument) {
      appendCommandNotice('Context limit', `${currentSettings.maxContextTokens.toLocaleString()} tokens for this session.`);
      return;
    }
    const maxContextTokens = parseTokenLimit(argument);
    if (!Number.isInteger(maxContextTokens) || maxContextTokens < 1_000 || maxContextTokens > 5_000_000) throw new Error('Context must be between 1,000 and 5,000,000 tokens. Suffixes such as 128k and 1.3m are supported.');
    await patchSessionSettings({ maxContextTokens });
    appendCommandNotice('Context updated', `Maximum context is now ${maxContextTokens.toLocaleString()} tokens.`);
    return;
  }
  if (command === '/approve') {
    if (!['always', 'ask'].includes(argument)) {
      appendCommandNotice('Approval policy', currentSettings.approvalMode === 'always' ? 'Writes and commands are automatically approved.' : 'Snowyy asks before every write or command.');
      return;
    }
    await patchSessionSettings({ approvalMode: argument });
    appendCommandNotice('Approval policy updated', argument === 'always' ? 'Writes and commands will run without pausing in this session.' : 'Snowyy will ask before writes and commands.');
    return;
  }
  if (command === '/files') {
    openFileDrawer();
    return;
  }
  if (command === '/settings') {
    openSettings();
    return;
  }
  if (command === '/new') {
    await createNewSession();
    return;
  }
  if (command === '/help') {
    appendCommandNotice('Slash commands', slashCommands.map((item) => `${item.command} — ${item.detail}`).join('\n'));
    return;
  }
  throw new Error(`Unknown command: ${command}. Use /help to see available commands.`);
}

input.addEventListener('input', () => {
  resizeInput();
  renderSlashMenu();
  scheduleMentionMenu();
});
input.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  const mentionMenu = $('#mentionMenu');
  if (!mentionMenu.hidden && mentionResults.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setMentionSelection((mentionSelection + direction + mentionResults.length) % mentionResults.length);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectMention();
      return;
    }
  }
  if (event.key === 'Escape' && !mentionMenu.hidden) {
    event.preventDefault();
    closeMentionMenu();
    return;
  }
  if (event.key === 'Escape' && !$('#slashMenu').hidden) {
    $('#slashMenu').hidden = true;
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener('click', scheduleMentionMenu);
input.addEventListener('keyup', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) scheduleMentionMenu();
});

document.addEventListener('click', (event) => {
  const commandControl = event.target.closest('[data-command-action]');
  if (commandControl) controlCommand(commandControl);
  const goalControl = event.target.closest('[data-goal-action]');
  if (goalControl) changeGoal(goalControl).catch((error) => window.alert(error.message));
  const copyCode = event.target.closest('[data-copy-code]');
  if (copyCode) {
    const code = copyCode.closest('.markdown-code')?.querySelector('code')?.textContent || '';
    navigator.clipboard?.writeText(code).then(() => {
      copyCode.textContent = 'Copied';
      window.setTimeout(() => { copyCode.textContent = 'Copy'; }, 1200);
    }).catch(() => {});
  }
  const header = event.target.closest('.tool-card-header');
  if (header) header.setAttribute('aria-expanded', String(header.getAttribute('aria-expanded') !== 'true'));
  if (!modelMenu.contains(event.target) && !modelSelect.contains(event.target)) modelMenu.classList.remove('open');
  if (!$('#mentionMenu').contains(event.target) && event.target !== input) closeMentionMenu();
});

modelSelect.addEventListener('click', () => modelMenu.classList.toggle('open'));

async function getConfig() {
  const response = await fetch('/api/config');
  return readApiJson(response, '/api/config');
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  return readApiJson(response, url);
}

function workspaceLabel(workspacePath) {
  return uiHelpers.workspaceLabel(workspacePath);
}

function updateWorkspaceUi(workspacePath) {
  if (currentWorkspace && currentWorkspace !== workspacePath) {
    currentBrowserPath = '.';
    clearFilePreview();
    attachedFiles.clear();
    modifiedFiles.clear();
    updateAttachmentPill();
    closeFileDrawer();
  }
  currentWorkspace = workspacePath;
  const name = workspaceLabel(workspacePath);
  $('#workspaceName').textContent = name;
  $('#workspaceState').textContent = workspacePath;
  $('#workspacePathInput').value = workspacePath;
  $('.workspace-pill').textContent = `~/${name}`;
  $('.welcome-block .eyebrow').textContent = `WORKSPACE · ${name.toUpperCase()}`;
}

function resetConversation() {
  requestController?.abort();
  requestController = null;
  $$('.message').forEach((message) => message.remove());
  conversationHistory = [];
  activeAssistant = null;
  streamedAssistantText = '';
  streamedRoundText = '';
  activeStreamParagraph = null;
  streamSegmentPending = false;
  activeApprovalId = null;
  attachedFiles.clear();
  uploadedAttachments.clear();
  updateAttachmentPill();
  permissionToast.classList.remove('visible');
  renderGoals([]);
  setRunning(false);
}

function renderSavedMessage(message) {
  if (message.role === 'user') {
    appendUserMessage(message.content);
    return;
  }
  const assistant = appendAssistantMessage();
  removeThinking(assistant);
  const paragraph = document.createElement('div');
  paragraph.className = 'streamed-copy markdown-body';
  renderAssistantMarkdown(paragraph, message.content);
  $('.message-body', assistant).append(paragraph);
}

function renderTimeline(timeline) {
  let traceAssistant = null;
  let traceParagraph = null;
  let traceParagraphText = '';
  for (const entry of timeline) {
    if (entry.type === 'message' && entry.role === 'user') {
      appendUserMessage(entry.content);
      traceAssistant = null;
      traceParagraph = null;
      traceParagraphText = '';
    } else if (entry.type === 'message' && entry.role === 'assistant') {
      if (!traceAssistant) {
        traceAssistant = appendAssistantMessage();
        removeThinking(traceAssistant);
      }
      if (entry.continuation && traceParagraph) {
        traceParagraphText += entry.content;
        renderAssistantMarkdown(traceParagraph, traceParagraphText);
      } else {
        traceParagraph = document.createElement('div');
        traceParagraph.className = 'streamed-copy markdown-body';
        traceParagraphText = entry.content;
        renderAssistantMarkdown(traceParagraph, traceParagraphText);
        $('.message-body', traceAssistant).append(traceParagraph);
      }
    } else if (entry.type === 'reasoning') {
      if (!traceAssistant) {
        traceAssistant = appendAssistantMessage();
        removeThinking(traceAssistant);
      }
      renderReasoning(entry.content, traceAssistant);
    } else if (entry.type === 'tool') {
      if (!traceAssistant) {
        traceAssistant = appendAssistantMessage();
        removeThinking(traceAssistant);
      }
      createToolCard({ id: entry.id, name: entry.name, args: entry.args, summary: { detail: entry.args?.path || '' } }, traceAssistant);
      if (['complete', 'failed', 'denied'].includes(entry.status)) {
        updateToolCard({ id: entry.id, ok: entry.status === 'complete', denied: entry.status === 'denied', result: entry.result }, traceAssistant);
      } else {
        const card = $(`[data-tool-id="${CSS.escape(entry.id)}"]`, traceAssistant);
        card?.classList.remove('running');
        const state = card && $('.tool-state', card);
        if (state) state.innerHTML = '<i>–</i><span>interrupted</span>';
      }
      traceParagraph = null;
      traceParagraphText = '';
    } else if (entry.type === 'usage') {
      updateContextMeter(entry.usage?.total_tokens || entry.usage?.totalTokens || 0, entry.usage?.cost);
    }
  }
}

function renderGoals(goals = []) {
  currentGoals = Array.isArray(goals) ? goals : [];
  const panel = $('#goalPanel');
  const list = $('#goalList');
  panel.hidden = currentGoals.length === 0;
  $('#goalCount').textContent = String(currentGoals.length);
  list.replaceChildren();
  for (const goal of currentGoals) {
    const item = document.createElement('div');
    item.className = `goal-item ${goal.status === 'complete' ? 'complete' : 'active'}`;
    item.dataset.goalId = goal.id;
    const status = document.createElement('button');
    status.type = 'button';
    status.className = 'goal-status';
    status.dataset.goalAction = 'toggle';
    status.textContent = goal.status === 'complete' ? '✓' : '○';
    status.title = goal.status === 'complete' ? 'Mark active' : 'Mark complete';
    const title = document.createElement('span');
    title.className = 'goal-title';
    title.textContent = goal.title;
    title.title = goal.title;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'goal-remove';
    remove.dataset.goalAction = 'remove';
    remove.textContent = '×';
    remove.title = 'Remove goal';
    item.append(status, title, remove);
    list.append(item);
  }
}

async function changeGoal(button) {
  const item = button.closest('[data-goal-id]');
  const goal = currentGoals.find(({ id }) => id === item?.dataset.goalId);
  if (!goal || !activeSessionId) return;
  button.disabled = true;
  const remove = button.dataset.goalAction === 'remove';
  const result = await apiJson(`/api/sessions/${activeSessionId}/goals/${goal.id}`, remove ? {
    method: 'DELETE'
  } : {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: goal.status === 'complete' ? 'active' : 'complete' })
  });
  renderGoals(result.goals);
}

function relativeSessionTime(isoDate) {
  const elapsed = Date.now() - new Date(isoDate).getTime();
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function renderSessions(sessions) {
  const list = $('#sessionList');
  list.replaceChildren();
  $('#sessionCount').textContent = String(sessions.length);
  if (!sessions.length) {
    const empty = document.createElement('p');
    empty.className = 'session-empty';
    empty.textContent = 'No saved sessions yet.';
    list.append(empty);
    return;
  }
  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = `session-item${session.id === activeSessionId ? ' active' : ''}`;
    const open = document.createElement('button');
    open.className = 'session-open';
    open.dataset.sessionId = session.id;
    const dot = document.createElement('span');
    dot.className = `status-dot${session.id === activeSessionId ? '' : ' muted'}`;
    const copy = document.createElement('span');
    copy.className = 'session-copy';
    const title = document.createElement('strong');
    title.textContent = session.title;
    const detail = document.createElement('small');
    detail.textContent = `${workspaceLabel(session.workspace)} · ${relativeSessionTime(session.updatedAt)}`;
    copy.append(title, detail);
    open.append(dot, copy);
    const remove = document.createElement('button');
    remove.className = 'session-delete';
    remove.dataset.deleteSession = session.id;
    remove.setAttribute('aria-label', `Delete ${session.title}`);
    remove.textContent = '×';
    item.append(open, remove);
    list.append(item);
  }
}

function setSessionsCollapsed(collapsed, persist = true) {
  const nav = $('.session-nav');
  nav.classList.toggle('collapsed', collapsed);
  $('#sessionToggle').setAttribute('aria-expanded', String(!collapsed));
  if (persist) {
    try { localStorage.setItem('snowyy:sessions-collapsed', String(collapsed)); } catch {}
  }
}

async function loadSessions() {
  const result = await apiJson('/api/sessions');
  renderSessions(result.sessions);
  return result.sessions;
}

async function setWorkspace(workspacePath) {
  if (!confirmDiscardFileEdit()) throw new Error('Workspace change cancelled because the open file has unsaved changes.');
  const result = await apiJson('/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspacePath })
  });
  updateWorkspaceUi(result.path);
  return result;
}

async function openSession(sessionId) {
  const result = await apiJson(`/api/sessions/${sessionId}`);
  const session = result.session;
  if (session.workspace !== currentWorkspace) await setWorkspace(session.workspace);
  resetConversation();
  activeSessionId = session.id;
  currentSettings = normalizeClientSettings(session.settings || currentSettings);
  syncSessionControls();
  conversationHistory = session.messages.map((message) => ({ ...message }));
  renderGoals(session.goals || []);
  if (session.timeline?.length) renderTimeline(session.timeline);
  else session.messages.forEach(renderSavedMessage);
  $('#sessionTitle').textContent = session.title;
  $('.welcome-block h2').textContent = session.messages.length ? 'Continue where you left off' : 'Start a new session';
  await loadSessions();
  scrollToBottom();
  closeSidebar();
}

async function createNewSession() {
  resetConversation();
  const result = await apiJson('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New session' })
  });
  activeSessionId = result.session.id;
  currentSettings = normalizeClientSettings(result.session.settings || currentSettings);
  renderGoals(result.session.goals || []);
  syncSessionControls();
  $('#sessionTitle').textContent = 'New session';
  $('.welcome-block h2').textContent = 'Start a new session';
  $('.welcome-block > div:last-child > p:last-child').textContent = 'Your workspace is ready. Ask Snowyy to inspect, edit, or build something.';
  await loadSessions();
  input.focus();
  closeSidebar();
}

async function saveConfig(values) {
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values)
  });
  const body = await readApiJson(response, '/api/config');
  modelName.textContent = body.model;
  return body;
}

const CUSTOM_MODEL_VALUE = '__snowyy_custom_model__';

function selectedModel() {
  const selection = $('#modelSelectInput').value;
  return selection === CUSTOM_MODEL_VALUE ? $('#modelInput').value.trim() : selection.trim();
}

function syncCustomModelInput({ focus = false } = {}) {
  const custom = $('#modelSelectInput').value === CUSTOM_MODEL_VALUE;
  const input = $('#modelInput');
  input.hidden = !custom;
  input.required = custom;
  if (custom && focus) input.focus();
}

function populateModelSelect(models = [], currentModel = selectedModel()) {
  const select = $('#modelSelectInput');
  const uniqueModels = [...new Set(models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim()))];
  if (currentModel && !uniqueModels.includes(currentModel)) uniqueModels.unshift(currentModel);
  select.replaceChildren();
  for (const model of uniqueModels) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.append(option);
  }
  const customOption = document.createElement('option');
  customOption.value = CUSTOM_MODEL_VALUE;
  customOption.textContent = 'Other model…';
  select.append(customOption);
  select.value = currentModel && uniqueModels.includes(currentModel) ? currentModel : CUSTOM_MODEL_VALUE;
  syncCustomModelInput();
}

async function refreshModels({ quiet = false } = {}) {
  const button = $('#refreshModels');
  const hint = $('#modelDiscoveryStatus');
  const currentModel = selectedModel();
  button.disabled = true;
  if (!quiet) hint.textContent = 'Loading models from the provider…';
  try {
    const response = await fetch('/api/provider/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: $('#baseUrlInput').value,
        apiKey: $('#apiKeyInput').value,
        clearApiKey: $('#clearApiKeyInput').checked
      })
    });
    const result = await readApiJson(response, '/api/provider/check');
    populateModelSelect(result.models, currentModel);
    hint.textContent = result.models.length
      ? `${result.models.length} model(s) available. Select one from the list.`
      : 'The provider connected but returned no model names. Use Other model…';
    return result;
  } catch (error) {
    populateModelSelect([], currentModel);
    hint.textContent = `Could not load models: ${error.message}`;
    if (!quiet) throw error;
    return null;
  } finally {
    button.disabled = false;
  }
}

function openSettings() {
  $('#planningOnlyInput').checked = Boolean(currentSettings.planningOnly);
  $('#maxContextInput').value = currentSettings.maxContextTokens || 32_000;
  $('#approvalAlwaysInput').checked = currentSettings.approvalMode === 'always';
  renderToolPolicies();
  settingsModal.classList.add('visible');
  settingsModal.setAttribute('aria-hidden', 'false');
  modelMenu.classList.remove('open');
  $('#baseUrlInput').focus();
  refreshModels({ quiet: true });
}

function renderToolPolicies() {
  const grid = $('#toolPolicyGrid');
  grid.replaceChildren();
  const enabled = currentSettings.enabledTools ? new Set(currentSettings.enabledTools) : new Set(allToolNames);
  allToolNames.forEach((name) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = name;
    checkbox.checked = enabled.has(name);
    label.append(checkbox, document.createTextNode(name));
    grid.append(label);
  });
}

function closeSettings() {
  settingsModal.classList.remove('visible');
  settingsModal.setAttribute('aria-hidden', 'true');
}

async function loadConfig() {
  try {
    const config = await getConfig();
    modelName.textContent = config.model;
    $('#baseUrlInput').value = config.baseUrl;
    $('#modelInput').value = config.model;
    populateModelSelect([], config.model);
    const version = config.app?.version || 'unknown';
    const channel = config.app?.channel || 'unknown';
    const updates = config.app?.updatesEnabled ? 'updates enabled' : 'updates disabled';
    $('#appVersion').textContent = `v${version}`;
    $('#appVersion').title = `Snowyy ${version} · ${channel} · ${updates}`;
    updateContextMeter(0);
    updateWorkspaceUi(config.workspace);
  } catch (error) {
    modelName.textContent = 'Server unavailable';
    $('#appVersion').textContent = 'v?';
  }
}

$$('[data-preset]').forEach((button) => {
  button.addEventListener('click', async () => {
    const preset = button.dataset.preset === 'gpt-oss'
      ? { baseUrl: 'http://127.0.0.1:11434/v1', model: 'gpt-oss:20b' }
      : { baseUrl: 'http://127.0.0.1:11434/v1', model: 'snowyy-qwen3-vl' };
    try {
      await saveConfig(preset);
      $('#baseUrlInput').value = preset.baseUrl;
      $('#modelInput').value = preset.model;
      populateModelSelect([], preset.model);
      modelMenu.classList.remove('open');
    } catch (error) {
      openSettings();
      $('#settingsStatus p').textContent = error.message;
    }
  });
});

$('[data-configure]').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (event) => { if (event.target === settingsModal) closeSettings(); });

$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveConfig({
      baseUrl: $('#baseUrlInput').value,
      model: selectedModel(),
      apiKey: $('#apiKeyInput').value,
      clearApiKey: $('#clearApiKeyInput').checked
    });
    if (activeSessionId) {
      const enabledTools = $$('input[type="checkbox"]', $('#toolPolicyGrid')).filter((box) => box.checked).map((box) => box.value);
      const updated = await apiJson(`/api/sessions/${activeSessionId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: {
          planningOnly: $('#planningOnlyInput').checked,
          maxContextTokens: Number($('#maxContextInput').value),
          approvalMode: $('#approvalAlwaysInput').checked ? 'always' : 'ask',
          enabledTools
        } })
      });
      currentSettings = normalizeClientSettings(updated.session.settings);
      syncSessionControls();
    }
    $('#apiKeyInput').value = '';
    $('#clearApiKeyInput').checked = false;
    closeSettings();
  } catch (error) {
    $('#settingsStatus').className = 'settings-status failed';
    $('#settingsStatus p').textContent = error.message;
  }
});

$('#testProvider').addEventListener('click', async () => {
  const status = $('#settingsStatus');
  status.className = 'settings-status checking';
  $('p', status).textContent = 'Testing the model endpoint…';
  try {
    const result = await refreshModels();
    await saveConfig({ baseUrl: $('#baseUrlInput').value, model: selectedModel(), apiKey: $('#apiKeyInput').value });
    status.className = 'settings-status success';
    $('p', status).textContent = result.models.length ? `Connected. ${result.models.length} model(s) available.` : 'Connected successfully.';
  } catch (error) {
    status.className = 'settings-status failed';
    $('p', status).textContent = error.message;
  }
});

$('#modelSelectInput').addEventListener('change', () => syncCustomModelInput({ focus: true }));
$('#refreshModels').addEventListener('click', () => refreshModels().catch(() => {}));
$('#baseUrlInput').addEventListener('change', () => refreshModels({ quiet: true }));

async function resolveApproval(decision) {
    if (!activeApprovalId) return;
    const approvalId = activeApprovalId;
    let modifiedArgs = null;
    if (decision === 'approve' && !$('#proposalEditor').hidden && activeApprovalEvent) {
      const field = { apply_patch: 'new_text', write_file: 'content', insert_text: 'text', replace_lines: 'new_text' }[activeApprovalEvent.toolCall.name];
      if (field) modifiedArgs = { [field]: $('#proposalEditorInput').value };
    }
    activeApprovalId = null;
    activeApprovalEvent = null;
    permissionToast.classList.remove('visible');
    closeApprovalReview();
    input.disabled = false;
    try {
      await runAgentRequest('/api/approve', { approvalId, decision, modifiedArgs });
    } catch (error) {
      if (error.name !== 'AbortError') {
        showError(error.message);
        finishResponse();
      }
    }
}

$$('[data-permission]').forEach((button) => {
  button.addEventListener('click', () => resolveApproval(button.dataset.permission));
});
$$('[data-modal-decision]').forEach((button) => {
  button.addEventListener('click', () => resolveApproval(button.dataset.modalDecision));
});

$('#editProposal').addEventListener('click', () => {
  if (!activeApprovalEvent) return;
  const name = activeApprovalEvent.toolCall.name;
  const field = { apply_patch: 'new_text', write_file: 'content', insert_text: 'text', replace_lines: 'new_text' }[name];
  if (!field) return;
  $('#proposalEditor').hidden = false;
  $('#proposalEditorLabel').textContent = field.replaceAll('_', ' ');
  $('#proposalEditorInput').value = activeApprovalEvent.toolCall.args[field] || '';
  $('#proposalEditorInput').focus();
});

$('#themeToggle').addEventListener('click', () => document.body.classList.toggle('light'));

let currentBrowserPath = '.';
let currentPreviewPath = null;
let currentPreviewHash = '';
let currentPreviewContent = '';
let currentPreviewTruncated = false;
let fileEditorDirty = false;
let fileSearchTimer = null;
let fileSearchRequest = 0;

function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fileLanguage(filePath = '') {
  return uiHelpers.fileLanguage(filePath);
}

function fileIconLabel(filePath, isDirectory) {
  return uiHelpers.fileIconLabel(filePath, isDirectory);
}

function setEditorNotice(message, tone = '') {
  const notice = $('#editorNotice');
  notice.textContent = message;
  notice.className = `editor-notice${tone ? ` ${tone}` : ''}`;
}

function renderCodePreview(content) {
  const viewer = $('#previewContent');
  viewer.replaceChildren();
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, index) => {
    const row = document.createElement('div');
    row.className = 'code-line';
    const number = document.createElement('span');
    number.className = 'code-line-number';
    number.textContent = String(index + 1);
    const copy = document.createElement('span');
    copy.className = 'code-line-copy';
    copy.textContent = line || ' ';
    row.append(number, copy);
    viewer.append(row);
  });
}

function updateEditorPosition() {
  const editor = $('#fileEditorInput');
  const beforeCursor = editor.value.slice(0, editor.selectionStart);
  const lines = beforeCursor.split('\n');
  $('#editorPosition').textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
}

function updateEditorMetadata(content = currentPreviewContent) {
  $('#editorLanguage').textContent = fileLanguage(currentPreviewPath);
  $('#editorFileStatus').textContent = currentPreviewPath
    ? `${String(content).split(/\r?\n/).length} lines · ${formatBytes(new TextEncoder().encode(content).length)}`
    : 'No file open';
}

function setFileEditMode(editing) {
  const editor = $('#fileEditorInput');
  $('#previewContent').hidden = editing;
  editor.hidden = !editing;
  $('#editPreviewFile').hidden = editing;
  $('#attachPreviewFile').hidden = editing;
  $('#cancelFileEdit').hidden = !editing;
  $('#saveFileEdit').hidden = !editing;
  if (editing) {
    editor.value = currentPreviewContent;
    fileEditorDirty = false;
    $('#saveFileEdit').disabled = true;
    setEditorNotice('Editing workspace file · Ctrl+S to save');
    editor.focus();
    updateEditorPosition();
  } else {
    fileEditorDirty = false;
    $('#saveFileEdit').disabled = true;
    renderCodePreview(currentPreviewContent);
    updateEditorMetadata();
  }
}

function confirmDiscardFileEdit() {
  if ($('#fileEditorInput').hidden || !fileEditorDirty) return true;
  return window.confirm('Discard the unsaved changes in this file?');
}

function clearFilePreview() {
  currentPreviewPath = null;
  currentPreviewHash = '';
  currentPreviewContent = '';
  currentPreviewTruncated = false;
  fileEditorDirty = false;
  $('#previewPath').textContent = 'Select a file';
  $('#previewContent').replaceChildren();
  $('#fileEditorInput').value = '';
  $('#fileEditorInput').hidden = true;
  $('#previewContent').hidden = false;
  $('#editPreviewFile').hidden = false;
  $('#attachPreviewFile').hidden = false;
  $('#cancelFileEdit').hidden = true;
  $('#saveFileEdit').hidden = true;
  $('#editPreviewFile').disabled = true;
  $('#attachPreviewFile').disabled = true;
  setEditorNotice('Choose a workspace file to preview or edit it.');
  updateEditorMetadata('');
  $('#editorPosition').textContent = 'Ln 1, Col 1';
}

function renderFileRows(entries) {
  const list = $('#fileList');
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'session-empty';
    empty.textContent = 'No matching files.';
    list.append(empty);
    return;
  }
  entries.forEach((entry) => {
    const filePath = typeof entry === 'string' ? entry : entry.path;
    const isDirectory = typeof entry !== 'string' && entry.type === 'directory';
    const button = document.createElement('button');
    button.className = `file-row${modifiedFiles.has(filePath) ? ' modified' : ''}${filePath === currentPreviewPath ? ' active' : ''}`;
    button.dataset.filePath = filePath;
    button.dataset.fileType = isDirectory ? 'directory' : 'file';
    const icon = document.createElement('span');
    icon.className = 'file-row-icon';
    icon.textContent = fileIconLabel(filePath, isDirectory);
    const name = document.createElement('span');
    name.className = 'file-row-name';
    name.textContent = typeof entry === 'string' ? entry : entry.name;
    const size = document.createElement('span');
    size.className = 'file-row-size';
    size.textContent = typeof entry === 'string' ? '' : formatBytes(entry.size);
    button.append(icon, name, size);
    list.append(button);
  });
}

async function loadDirectory(directory = '.') {
  fileSearchRequest += 1;
  currentBrowserPath = directory;
  $('#fileBreadcrumb').textContent = directory;
  const result = await apiJson(`/api/files?path=${encodeURIComponent(directory)}`);
  renderFileRows(result.entries || []);
}

async function previewFile(filePath) {
  if (!$('#fileEditorInput').hidden && filePath === currentPreviewPath) return;
  if (!confirmDiscardFileEdit()) return;
  setFileEditMode(false);
  currentPreviewPath = filePath;
  currentPreviewHash = '';
  currentPreviewContent = '';
  currentPreviewTruncated = false;
  $('#previewPath').textContent = filePath;
  $('#previewContent').replaceChildren();
  setEditorNotice('Loading file…');
  $('#attachPreviewFile').disabled = true;
  $('#editPreviewFile').disabled = true;
  try {
    const result = await apiJson(`/api/file?path=${encodeURIComponent(filePath)}`);
    currentPreviewHash = result.sha256;
    currentPreviewContent = result.content;
    currentPreviewTruncated = result.end_line < result.total_lines;
    $('#fileEditorInput').value = result.content;
    renderCodePreview(result.content);
    updateEditorMetadata(result.content);
    $('#attachPreviewFile').disabled = false;
    $('#editPreviewFile').disabled = currentPreviewTruncated;
    $('#attachPreviewFile').textContent = attachedFiles.has(filePath) ? 'Remove context' : 'Add to context';
    setEditorNotice(
      currentPreviewTruncated ? `Preview limited to ${result.end_line.toLocaleString()} of ${result.total_lines.toLocaleString()} lines. Editing is disabled.` : 'File loaded. Select Edit to make a guarded change.',
      currentPreviewTruncated ? 'warning' : ''
    );
    $$('.file-row').forEach((row) => row.classList.toggle('active', row.dataset.filePath === filePath));
  } catch (error) {
    currentPreviewContent = '';
    renderCodePreview(error.message);
    setEditorNotice('This file could not be opened.', 'warning');
  }
}

function openFileDrawer() {
  fileDrawer.classList.add('open');
  fileDrawer.setAttribute('aria-hidden', 'false');
  loadDirectory(currentBrowserPath).catch((error) => { $('#fileList').textContent = error.message; });
}

function closeFileDrawer() {
  if (!confirmDiscardFileEdit()) return;
  if (!$('#fileEditorInput').hidden) setFileEditMode(false);
  fileDrawer.classList.remove('open');
  fileDrawer.setAttribute('aria-hidden', 'true');
}

$('#fileBrowserButton').addEventListener('click', openFileDrawer);
$('#attachFiles').addEventListener('click', () => $('#localAttachmentInput').click());
$('#localAttachmentInput').addEventListener('change', async (event) => {
  try {
    await addLocalAttachments(event.target.files || []);
  } catch (error) {
    window.alert(error.message);
  } finally {
    event.target.value = '';
  }
});
input.addEventListener('paste', (event) => {
  const directFiles = [...(event.clipboardData?.files || [])];
  const itemFiles = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const images = (directFiles.length ? directFiles : itemFiles).filter((file) => file.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  addLocalAttachments(images).catch((error) => window.alert(error.message));
});
$('#closeFileDrawer').addEventListener('click', closeFileDrawer);
$('#fileBreadcrumb').addEventListener('click', () => {
  $('#fileSearchInput').value = '';
  loadDirectory('.').catch((error) => window.alert(error.message));
});
$('#fileParentButton').addEventListener('click', () => {
  const parts = currentBrowserPath.split(/[\\/]/).filter(Boolean);
  parts.pop();
  $('#fileSearchInput').value = '';
  loadDirectory(parts.join('/') || '.').catch((error) => window.alert(error.message));
});
$('#refreshFiles').addEventListener('click', () => {
  if ($('#fileSearchInput').value.trim()) $('#fileSearchButton').click();
  else loadDirectory(currentBrowserPath).catch((error) => window.alert(error.message));
});
$('#fileList').addEventListener('click', (event) => {
  const row = event.target.closest('[data-file-path]');
  if (!row) return;
  if (row.dataset.fileType === 'directory') {
    $('#fileSearchInput').value = '';
    loadDirectory(row.dataset.filePath).catch((error) => window.alert(error.message));
  }
  else previewFile(row.dataset.filePath);
});

async function searchWorkspaceFiles() {
  const query = $('#fileSearchInput').value.trim();
  const requestId = ++fileSearchRequest;
  if (!query) return loadDirectory(currentBrowserPath);
  try {
    const result = await apiJson(`/api/files?path=.&q=${encodeURIComponent(query)}`);
    if (requestId !== fileSearchRequest) return;
    $('#fileBreadcrumb').textContent = `Search · ${query}`;
    renderFileRows(result.files || []);
  } catch (error) { window.alert(error.message); }
}

$('#fileSearchButton').addEventListener('click', () => {
  window.clearTimeout(fileSearchTimer);
  searchWorkspaceFiles();
});
$('#fileSearchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#fileSearchButton').click(); });
$('#fileSearchInput').addEventListener('input', () => {
  window.clearTimeout(fileSearchTimer);
  fileSearchTimer = window.setTimeout(() => searchWorkspaceFiles(), 180);
});
$('#attachPreviewFile').addEventListener('click', () => {
  if (!currentPreviewPath) return;
  if (attachedFiles.has(currentPreviewPath)) attachedFiles.delete(currentPreviewPath);
  else if (!attachWorkspaceFile(currentPreviewPath)) return;
  if (!attachedFiles.has(currentPreviewPath)) updateAttachmentPill();
  $('#attachPreviewFile').textContent = attachedFiles.has(currentPreviewPath) ? 'Remove context' : 'Add to context';
});
$('#editPreviewFile').addEventListener('click', () => {
  if (!currentPreviewPath || currentPreviewTruncated) return;
  setFileEditMode(true);
});
$('#cancelFileEdit').addEventListener('click', () => {
  if (!confirmDiscardFileEdit()) return;
  setFileEditMode(false);
  setEditorNotice('Changes discarded.');
});
$('#saveFileEdit').addEventListener('click', async () => {
  if (!currentPreviewPath || !fileEditorDirty) return;
  const save = $('#saveFileEdit');
  const content = $('#fileEditorInput').value;
  save.disabled = true;
  setEditorNotice('Saving file…');
  try {
    const response = await apiJson(`/api/file?path=${encodeURIComponent(currentPreviewPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, expected_sha256: currentPreviewHash })
    });
    const savedFile = response.result?.files?.[0];
    currentPreviewHash = savedFile?.sha256 || currentPreviewHash;
    currentPreviewContent = content;
    fileEditorDirty = false;
    modifiedFiles.add(currentPreviewPath);
    setFileEditMode(false);
    setEditorNotice(response.result?.validation?.some((item) => item.checked) ? 'Saved and syntax-checked.' : 'Saved successfully.', 'success');
    $$('.file-row').forEach((row) => {
      if (row.dataset.filePath === currentPreviewPath) row.classList.add('modified');
    });
  } catch (error) {
    save.disabled = false;
    setEditorNotice(error.message, 'warning');
  }
});
$('#fileEditorInput').addEventListener('input', () => {
  fileEditorDirty = $('#fileEditorInput').value !== currentPreviewContent;
  $('#saveFileEdit').disabled = !fileEditorDirty;
  updateEditorMetadata($('#fileEditorInput').value);
  updateEditorPosition();
});
$('#fileEditorInput').addEventListener('click', updateEditorPosition);
$('#fileEditorInput').addEventListener('keyup', updateEditorPosition);
$('#fileEditorInput').addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (fileEditorDirty) $('#saveFileEdit').click();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    const editor = $('#fileEditorInput');
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    editor.dispatchEvent(new Event('input'));
  }
});

function openWorkspaceModal() {
  workspaceModal.classList.add('visible');
  workspaceModal.setAttribute('aria-hidden', 'false');
  $('#workspacePathInput').value = currentWorkspace;
  $('#workspacePathInput').focus();
}

function closeWorkspaceModal() {
  workspaceModal.classList.remove('visible');
  workspaceModal.setAttribute('aria-hidden', 'true');
}

$('#workspaceButton').addEventListener('click', openWorkspaceModal);
$('#closeWorkspace').addEventListener('click', closeWorkspaceModal);
workspaceModal.addEventListener('click', (event) => { if (event.target === workspaceModal) closeWorkspaceModal(); });

$('#browseWorkspace').addEventListener('click', async () => {
  const status = $('#workspaceStatus');
  status.className = 'settings-status checking';
  $('p', status).textContent = 'Waiting for the folder picker…';
  try {
    const result = await apiJson('/api/workspace/pick', { method: 'POST' });
    if (result.cancelled) {
      status.className = 'settings-status';
      $('p', status).textContent = 'Folder selection cancelled.';
      return;
    }
    $('#workspacePathInput').value = result.path;
    status.className = 'settings-status success';
    $('p', status).textContent = 'Folder selected. Choose Open workspace to attach it.';
  } catch (error) {
    status.className = 'settings-status failed';
    $('p', status).textContent = error.message;
  }
});

$('#workspaceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('#workspaceStatus');
  status.className = 'settings-status checking';
  $('p', status).textContent = 'Opening workspace…';
  try {
    await setWorkspace($('#workspacePathInput').value.trim());
    closeWorkspaceModal();
    await createNewSession();
  } catch (error) {
    status.className = 'settings-status failed';
    $('p', status).textContent = error.message;
  }
});

function closeSidebar() {
  sidebar.classList.remove('open');
  scrim.classList.remove('visible');
}

$('#openSidebar').addEventListener('click', () => {
  sidebar.classList.add('open');
  scrim.classList.add('visible');
});
$('#closeSidebar').addEventListener('click', closeSidebar);
scrim.addEventListener('click', closeSidebar);

$('#newSession').addEventListener('click', () => createNewSession().catch((error) => window.alert(error.message)));
$('#sessionToggle').addEventListener('click', () => {
  setSessionsCollapsed(!$('.session-nav').classList.contains('collapsed'));
});

$('.session-nav').addEventListener('click', async (event) => {
  const deleteButton = event.target.closest('[data-delete-session]');
  if (deleteButton) {
    const id = deleteButton.dataset.deleteSession;
    if (!window.confirm('Delete this session? This cannot be undone.')) return;
    try {
      await apiJson(`/api/sessions/${id}`, { method: 'DELETE' });
      if (id === activeSessionId) await createNewSession();
      else await loadSessions();
    } catch (error) {
      window.alert(error.message);
    }
    return;
  }
  const openButton = event.target.closest('[data-session-id]');
  if (openButton && openButton.dataset.sessionId !== activeSessionId) {
    openSession(openButton.dataset.sessionId).catch((error) => window.alert(error.message));
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    $('#newSession').click();
  }
  if (event.key === 'Escape' && settingsModal.classList.contains('visible')) closeSettings();
  if (event.key === 'Escape' && workspaceModal.classList.contains('visible')) closeWorkspaceModal();
  if (event.key === 'Escape' && fileDrawer.classList.contains('open')) closeFileDrawer();
});

try { setSessionsCollapsed(localStorage.getItem('snowyy:sessions-collapsed') === 'true', false); } catch { setSessionsCollapsed(false, false); }
resizeInput();
async function bootstrap() {
  await loadConfig();
  const sessions = await loadSessions();
  if (sessions.length) await openSession(sessions[0].id);
  else await createNewSession();
}

bootstrap().catch((error) => {
  modelName.textContent = 'Server unavailable';
  console.error(error);
});
