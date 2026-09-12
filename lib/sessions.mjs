import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkflow as createWorkflowRecord, normalizeWorkflow, updateWorkflow as updateWorkflowRecord } from './workflows.mjs';

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
  reasoningEffort: 'medium',
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
    reasoningEffort: ['low', 'medium', 'high', 'xhigh'].includes(settings.reasoningEffort) ? settings.reasoningEffort : defaultSettings.reasoningEffort,
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

function normalizeBaseUrls(values) {
  const urls = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().replace(/\/+$/, '');
    try {
      const parsed = new URL(normalized);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      urls.push(normalized);
    } catch {}
  }
  return [...new Set(urls)].slice(0, 20);
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
    goals: Array.isArray(session.goals) ? session.goals.map(normalizeGoal).filter(Boolean) : [],
    workflows: Array.isArray(session.workflows) ? session.workflows.map(normalizeWorkflow).filter(Boolean) : []
  };
}

function cleanMessages(messages) {
  return messages
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .map((message) => ({ role: message.role, content: message.content }));
}

export function createSessionStore(filePath) {
  let loaded = false;
  let sessions = [];
  let preferences = { settings: { ...defaultSettings }, provider: { baseUrls: [] } };
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
          ...(typeof parsed.preferences?.provider?.model === 'string' ? { model: parsed.preferences.provider.model } : {}),
          baseUrls: normalizeBaseUrls([
            ...(Array.isArray(parsed.preferences?.provider?.baseUrls) ? parsed.preferences.provider.baseUrls : []),
            parsed.preferences?.provider?.baseUrl
          ])
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
      goals: [],
      workflows: []
    };
    sessions.unshift(session);
    await persist();
    return structuredClone(session);
  }

  async function setMessages(id, messages) {
    return setState(id, { messages });
  }

  async function setState(id, { messages, timeline, context, goals, workflows } = {}) {
    await load();
    const session = sessions.find((item) => item.id === id);
    if (!session) return null;
    if (Array.isArray(messages)) {
      session.messages = cleanMessages(messages);
    }
    if (Array.isArray(timeline)) session.timeline = structuredClone(timeline);
    if (context) session.context = normalizeContext(context, session.messages.length);
    if (Array.isArray(goals)) session.goals = goals.map(normalizeGoal).filter(Boolean).slice(-100);
    if (Array.isArray(workflows)) session.workflows = workflows.map(normalizeWorkflow).filter(Boolean).slice(-20);
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
      ...(['low', 'medium', 'high', 'xhigh'].includes(changes.reasoningEffort) ? { reasoningEffort: changes.reasoningEffort } : {}),
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
      const currentBaseUrls = normalizeBaseUrls(preferences.provider.baseUrls);
      const nextBaseUrls = Array.isArray(changes.provider.baseUrls)
        ? normalizeBaseUrls(changes.provider.baseUrls)
        : currentBaseUrls;
      if (typeof changes.provider.addBaseUrl === 'string') {
        nextBaseUrls.unshift(changes.provider.addBaseUrl);
      }
      const removeBaseUrl = typeof changes.provider.removeBaseUrl === 'string'
        ? changes.provider.removeBaseUrl.trim().replace(/\/+$/, '')
        : '';
      preferences.provider = {
        ...preferences.provider,
        ...(typeof changes.provider.baseUrl === 'string' ? { baseUrl: changes.provider.baseUrl } : {}),
        ...(typeof changes.provider.model === 'string' ? { model: changes.provider.model } : {}),
        baseUrls: normalizeBaseUrls(nextBaseUrls).filter((value) => value !== removeBaseUrl)
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

  async function createWorkflow(sessionId, input) {
    await load();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const workflow = createWorkflowRecord(input);
    session.workflows.push(workflow);
    session.workflows = session.workflows.slice(-20);
    session.updatedAt = new Date().toISOString();
    await persist();
    return { workflow: structuredClone(workflow), workflows: structuredClone(session.workflows) };
  }

  async function updateWorkflow(sessionId, workflowId, changes = {}) {
    await load();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const index = session.workflows.findIndex((item) => item.id === workflowId);
    if (index < 0) return false;
    const workflow = updateWorkflowRecord(session.workflows[index], changes);
    if (!workflow) return false;
    session.workflows[index] = workflow;
    session.updatedAt = workflow.updatedAt;
    await persist();
    return { workflow: structuredClone(workflow), workflows: structuredClone(session.workflows) };
  }

  async function removeWorkflow(sessionId, workflowId) {
    await load();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const index = session.workflows.findIndex((item) => item.id === workflowId);
    if (index < 0) return false;
    const [workflow] = session.workflows.splice(index, 1);
    session.updatedAt = new Date().toISOString();
    await persist();
    return { workflow: structuredClone(workflow), workflows: structuredClone(session.workflows) };
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
    createGoal, updateGoal, removeGoal, createWorkflow, updateWorkflow, removeWorkflow, remove
  };
}
