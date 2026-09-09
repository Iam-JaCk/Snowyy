import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_SESSION_MESSAGES = 500;
const MAX_TIMELINE_ENTRIES = 1_000;

function cleanTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return title.slice(0, 64) || 'New session';
}

function titleFromMessages(messages) {
  const firstUser = messages.find((message) => message.role === 'user');
  return firstUser ? cleanTitle(firstUser.content) : 'New session';
}

export const defaultSettings = Object.freeze({
  planningOnly: false,
  maxContextTokens: 32_000,
  approvalMode: 'ask',
  enabledTools: null
});

export function normalizeSettings(settings = {}) {
  const maxContextTokens = Number.isInteger(settings.maxContextTokens)
    ? Math.min(Math.max(settings.maxContextTokens, 1_000), 5_000_000)
    : defaultSettings.maxContextTokens;
  return {
    planningOnly: Boolean(settings.planningOnly),
    maxContextTokens,
    approvalMode: settings.approvalMode === 'always' ? 'always' : 'ask',
    enabledTools: Array.isArray(settings.enabledTools)
      ? [...new Set(settings.enabledTools.filter((name) => typeof name === 'string'))]
      : null
  };
}

function normalizeContext(context, messageCount) {
  const summarizedMessages = Number.isInteger(context?.summarizedMessages)
    ? Math.min(Math.max(context.summarizedMessages, 0), messageCount)
    : 0;
  return {
    summary: typeof context?.summary === 'string' ? context.summary.slice(0, 100_000) : '',
    summarizedMessages,
    updatedAt: typeof context?.updatedAt === 'string' ? context.updatedAt : null
  };
}

function normalizeGoal(goal) {
  const title = cleanTitle(goal?.title);
  if (title === 'New session') return null;
  const now = new Date().toISOString();
  return {
    id: typeof goal?.id === 'string' && goal.id ? goal.id : crypto.randomUUID(),
    title,
    status: goal?.status === 'complete' ? 'complete' : 'active',
    createdAt: typeof goal?.createdAt === 'string' ? goal.createdAt : now,
    updatedAt: typeof goal?.updatedAt === 'string' ? goal.updatedAt : now
  };
}

function normalizeSession(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return {
    ...session,
    messages,
    timeline: Array.isArray(session.timeline)
      ? session.timeline
      : messages.map((message) => ({ type: 'message', ...message })),
    settings: normalizeSettings(session.settings),
    context: normalizeContext(session.context, messages.length),
    goals: Array.isArray(session.goals) ? session.goals.map(normalizeGoal).filter(Boolean) : []
  };
}

function cleanMessages(messages) {
  return messages
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .map((message) => ({ role: message.role, content: message.content.slice(0, 100_000) }));
}

export function createSessionStore(filePath) {
  let loaded = false;
  let sessions = [];
  let preferences = { settings: { ...defaultSettings }, provider: {} };
  let writeQueue = Promise.resolve();

  async function load() {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      sessions = Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSession) : [];
      preferences = {
        settings: normalizeSettings(parsed.preferences?.settings || sessions[0]?.settings),
        provider: {
          ...(typeof parsed.preferences?.provider?.baseUrl === 'string' ? { baseUrl: parsed.preferences.provider.baseUrl } : {}),
          ...(typeof parsed.preferences?.provider?.model === 'string' ? { model: parsed.preferences.provider.model } : {})
        }
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      sessions = [];
    }
    loaded = true;
  }

  async function persist() {
    const snapshot = JSON.stringify({ version: 2, preferences, sessions }, null, 2);
    writeQueue = writeQueue.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, filePath);
    });
    return writeQueue;
  }

  async function list() {
    await load();
    return sessions
      .map(({ messages: _messages, ...metadata }) => ({ ...metadata, messageCount: _messages.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function get(id) {
    await load();
    const session = sessions.find((item) => item.id === id);
    return session ? structuredClone(session) : null;
  }

  async function create({ workspace, title = 'New session', settings } = {}) {
    await load();
    const now = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      title: cleanTitle(title),
      workspace,
      createdAt: now,
      updatedAt: now,
      messages: [],
      timeline: [],
      settings: normalizeSettings(settings || preferences.settings),
      context: normalizeContext(null, 0),
      goals: []
    };
    sessions.unshift(session);
    await persist();
    return structuredClone(session);
  }

  async function setMessages(id, messages) {
    return setState(id, { messages });
  }

  async function setState(id, { messages, timeline, context, goals } = {}) {
    await load();
    const session = sessions.find((item) => item.id === id);
    if (!session) return null;
    let droppedMessages = 0;
    if (Array.isArray(messages)) {
      const cleaned = cleanMessages(messages);
      droppedMessages = Math.max(cleaned.length - MAX_SESSION_MESSAGES, 0);
      session.messages = cleaned.slice(-MAX_SESSION_MESSAGES);
      if (droppedMessages) {
        session.context = {
          ...session.context,
          summarizedMessages: Math.max((session.context?.summarizedMessages || 0) - droppedMessages, 0)
        };
      }
    }
    if (Array.isArray(timeline)) session.timeline = timeline.slice(-MAX_TIMELINE_ENTRIES);
    if (context) session.context = normalizeContext({
      ...context,
      summarizedMessages: Math.max((context.summarizedMessages || 0) - droppedMessages, 0)
    }, session.messages.length);
    if (Array.isArray(goals)) session.goals = goals.map(normalizeGoal).filter(Boolean).slice(-100);
    if (session.title === 'New session') session.title = titleFromMessages(session.messages);
    session.updatedAt = new Date().toISOString();
    await persist();
    return structuredClone(session);
  }

  async function updateSettings(id, changes = {}) {
    await load();
    const session = sessions.find((item) => item.id === id);
    if (!session) return null;
    session.settings = normalizeSettings({
      ...session.settings,
      ...(typeof changes.planningOnly === 'boolean' ? { planningOnly: changes.planningOnly } : {}),
      ...(Number.isInteger(changes.maxContextTokens) ? { maxContextTokens: changes.maxContextTokens } : {}),
      ...(['ask', 'always'].includes(changes.approvalMode) ? { approvalMode: changes.approvalMode } : {}),
      ...(Array.isArray(changes.enabledTools) || changes.enabledTools === null ? { enabledTools: changes.enabledTools } : {})
    });
    preferences.settings = structuredClone(session.settings);
    session.updatedAt = new Date().toISOString();
    await persist();
    return structuredClone(session);
  }

  async function getPreferences() {
    await load();
    return structuredClone(preferences);
  }

  async function updatePreferences(changes = {}) {
    await load();
    if (changes.settings) preferences.settings = normalizeSettings({ ...preferences.settings, ...changes.settings });
    if (changes.provider) {
      preferences.provider = {
        ...preferences.provider,
        ...(typeof changes.provider.baseUrl === 'string' ? { baseUrl: changes.provider.baseUrl } : {}),
        ...(typeof changes.provider.model === 'string' ? { model: changes.provider.model } : {})
      };
    }
    await persist();
    return structuredClone(preferences);
  }

  async function createGoal(id, title) {
    await load();
    const session = sessions.find((item) => item.id === id);
    if (!session) return null;
    const goal = normalizeGoal({ title });
    if (!goal) throw new Error('Goal title is required.');
    session.goals.push(goal);
    session.updatedAt = new Date().toISOString();
    await persist();
    return { goal: structuredClone(goal), goals: structuredClone(session.goals) };
  }

  async function updateGoal(sessionId, goalId, changes = {}) {
    await load();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const goal = session.goals.find((item) => item.id === goalId);
    if (!goal) return false;
    if (typeof changes.title === 'string' && cleanTitle(changes.title) !== 'New session') goal.title = cleanTitle(changes.title);
    if (['active', 'complete'].includes(changes.status)) goal.status = changes.status;
    goal.updatedAt = new Date().toISOString();
    session.updatedAt = goal.updatedAt;
    await persist();
    return { goal: structuredClone(goal), goals: structuredClone(session.goals) };
  }

  async function removeGoal(sessionId, goalId) {
    await load();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const index = session.goals.findIndex((item) => item.id === goalId);
    if (index < 0) return false;
    const [goal] = session.goals.splice(index, 1);
    session.updatedAt = new Date().toISOString();
    await persist();
    return { goal: structuredClone(goal), goals: structuredClone(session.goals) };
  }

  async function remove(id) {
    await load();
    const index = sessions.findIndex((item) => item.id === id);
    if (index < 0) return false;
    sessions.splice(index, 1);
    await persist();
    return true;
  }

  return {
    list, get, create, setMessages, setState, updateSettings, getPreferences, updatePreferences,
    createGoal, updateGoal, removeGoal, remove
  };
}
