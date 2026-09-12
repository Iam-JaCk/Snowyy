import crypto from 'node:crypto';

const STEP_STATUSES = new Set(['pending', 'active', 'complete', 'skipped']);
const WORKFLOW_STATUSES = new Set(['active', 'complete']);

export const workflowTemplates = Object.freeze([
  Object.freeze({
    id: 'implement',
    title: 'Implement a change',
    steps: Object.freeze(['Inspect the relevant code', 'Plan the change', 'Implement the change', 'Run focused validation', 'Summarize the result'])
  }),
  Object.freeze({
    id: 'debug',
    title: 'Debug a problem',
    steps: Object.freeze(['Reproduce or inspect the failure', 'Identify the root cause', 'Implement the fix', 'Verify the failing path', 'Report the cause and fix'])
  }),
  Object.freeze({
    id: 'review',
    title: 'Review code',
    steps: Object.freeze(['Identify the changed surface', 'Inspect correctness and edge cases', 'Check validation coverage', 'Prioritize findings', 'Present the review'])
  })
]);

function cleanText(value, maximum = 96) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalizeStep(step, index) {
  const title = cleanText(typeof step === 'string' ? step : step?.title);
  if (!title) return null;
  const now = new Date().toISOString();
  return {
    id: typeof step?.id === 'string' && step.id ? step.id : crypto.randomUUID(),
    title,
    status: STEP_STATUSES.has(step?.status) ? step.status : index === 0 ? 'active' : 'pending',
    updatedAt: typeof step?.updatedAt === 'string' ? step.updatedAt : now
  };
}

function reconcile(workflow) {
  if (workflow.status === 'complete') {
    workflow.steps.forEach((step) => {
      if (!['complete', 'skipped'].includes(step.status)) step.status = 'complete';
    });
    return workflow;
  }
  if (workflow.steps.every((step) => ['complete', 'skipped'].includes(step.status))) {
    workflow.status = 'complete';
    return workflow;
  }
  const activeSteps = workflow.steps.filter((step) => step.status === 'active');
  if (!activeSteps.length) workflow.steps.find((step) => step.status === 'pending').status = 'active';
  else activeSteps.slice(1).forEach((step) => { step.status = 'pending'; });
  return workflow;
}

export function normalizeWorkflow(value) {
  const title = cleanText(value?.title, 80);
  const steps = (Array.isArray(value?.steps) ? value.steps : []).slice(0, 12).map(normalizeStep).filter(Boolean);
  if (!title || steps.length < 2) return null;
  const now = new Date().toISOString();
  return reconcile({
    id: typeof value?.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    title,
    status: WORKFLOW_STATUSES.has(value?.status) ? value.status : 'active',
    steps,
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : now
  });
}

export function createWorkflow({ title, steps, template } = {}) {
  const selected = workflowTemplates.find((item) => item.id === template);
  const workflowTitle = cleanText(title, 80) || selected?.title;
  const workflowSteps = Array.isArray(steps) && steps.length ? steps : selected?.steps;
  const workflow = normalizeWorkflow({ title: workflowTitle, steps: workflowSteps });
  if (!workflow) throw new Error('A workflow needs a title and between 2 and 12 named steps.');
  return workflow;
}

export function updateWorkflow(workflow, changes = {}) {
  const updated = structuredClone(workflow);
  const now = new Date().toISOString();
  if (typeof changes.title === 'string' && cleanText(changes.title, 80)) updated.title = cleanText(changes.title, 80);
  if (WORKFLOW_STATUSES.has(changes.status)) updated.status = changes.status;
  if (changes.step_id) {
    const step = updated.steps.find((item) => item.id === changes.step_id);
    if (!step) return null;
    if (!STEP_STATUSES.has(changes.step_status)) throw new Error('step_status must be pending, active, complete, or skipped.');
    if (changes.step_status === 'active') {
      updated.steps.forEach((item) => {
        if (item.status === 'active') item.status = 'pending';
      });
      updated.status = 'active';
    }
    step.status = changes.step_status;
    step.updatedAt = now;
  }
  updated.updatedAt = now;
  return reconcile(updated);
}

export function workflowProgress(workflow) {
  const completed = workflow.steps.filter((step) => ['complete', 'skipped'].includes(step.status)).length;
  return { completed, total: workflow.steps.length, percent: Math.round((completed / workflow.steps.length) * 100) };
}
