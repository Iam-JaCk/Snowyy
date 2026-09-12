import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflow, normalizeWorkflow, updateWorkflow, workflowProgress } from '../lib/workflows.mjs';

test('workflow templates create ordered progress and advance one active step at a time', () => {
  const workflow = createWorkflow({ template: 'implement', title: 'Add workflows' });
  assert.equal(workflow.steps.length, 5);
  assert.equal(workflow.steps[0].status, 'active');
  assert.equal(workflow.steps[1].status, 'pending');

  let current = workflow;
  for (const step of workflow.steps) {
    current = updateWorkflow(current, { step_id: step.id, step_status: 'complete' });
  }
  assert.equal(current.status, 'complete');
  assert.deepEqual(workflowProgress(current), { completed: 5, total: 5, percent: 100 });
});

test('workflow normalization repairs duplicate active steps and rejects incomplete records', () => {
  const normalized = normalizeWorkflow({
    title: 'Review a change',
    steps: [
      { title: 'Inspect', status: 'active' },
      { title: 'Test', status: 'active' },
      { title: 'Report', status: 'pending' }
    ]
  });
  assert.deepEqual(normalized.steps.map((step) => step.status), ['active', 'pending', 'pending']);
  assert.equal(normalizeWorkflow({ title: 'Too short', steps: ['Only one'] }), null);
  assert.throws(() => createWorkflow({ title: 'Missing steps' }), /needs a title/);
});
