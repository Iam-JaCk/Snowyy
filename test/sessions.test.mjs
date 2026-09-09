import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSessionStore } from '../lib/sessions.mjs';

test('sessions persist, derive titles, reopen, and delete', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'snowyy-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sessions.json');
  const store = createSessionStore(file);

  const created = await store.create({ workspace: 'C:\\project' });
  assert.equal(created.title, 'New session');
  const updated = await store.setMessages(created.id, [
    { role: 'user', content: 'Explore this project and explain its architecture' },
    { role: 'assistant', content: 'I will inspect the files.' }
  ]);
  assert.equal(updated.title, 'Explore this project and explain its architecture');
  const state = await store.setState(created.id, {
    messages: updated.messages,
    timeline: [{ type: 'message', role: 'user', content: 'Explore this project and explain its architecture' }, { type: 'tool', id: 'read_1', name: 'read_file', status: 'complete' }]
  });
  assert.equal(state.timeline.length, 2);
  const configured = await store.updateSettings(created.id, { planningOnly: true, maxContextTokens: 128_560, approvalMode: 'always', enabledTools: ['read_file'] });
  assert.equal(configured.settings.planningOnly, true);
  assert.equal(configured.settings.maxContextTokens, 128_560);
  assert.equal(configured.settings.approvalMode, 'always');
  const inherited = await store.create({ workspace: 'C:\\another-project' });
  assert.deepEqual(inherited.settings, configured.settings);
  const goalState = await store.createGoal(created.id, 'Finish persistence');
  assert.equal(goalState.goals[0].status, 'active');
  const completedGoal = await store.updateGoal(created.id, goalState.goal.id, { status: 'complete' });
  assert.equal(completedGoal.goal.status, 'complete');
  await store.setState(created.id, { context: { summary: 'Earlier decisions.', summarizedMessages: 1 } });
  await store.updatePreferences({ provider: { baseUrl: 'https://provider.example/v1', model: 'chosen-model' } });

  const reloaded = createSessionStore(file);
  const opened = await reloaded.get(created.id);
  assert.equal(opened.messages.length, 2);
  assert.equal(opened.timeline[1].name, 'read_file');
  assert.equal(opened.settings.maxContextTokens, 128_560);
  assert.equal(opened.context.summary, 'Earlier decisions.');
  assert.equal(opened.goals[0].status, 'complete');
  assert.deepEqual((await reloaded.getPreferences()).provider, { baseUrl: 'https://provider.example/v1', model: 'chosen-model' });
  assert.equal((await reloaded.list()).find((session) => session.id === created.id).messageCount, 2);
  assert.equal(await reloaded.remove(created.id), true);
  assert.equal(await reloaded.get(created.id), null);
});
