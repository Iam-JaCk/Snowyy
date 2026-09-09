/**
 * Workshop/Workflow execution engine
 * Supports prebuilt templates, custom workflows, and recursive execution
 */

export class Workflow {
  constructor(name) {
    this.name = name;
    this.steps = [];
    this.parentStepId = null;
    this.depth = 0;
    this.result = null;
    this.status = 'pending';
    this.error = '';
    this.createdAt = Date.now();
  }

  static createPrebuilt(name) {
    const workflows = {
      'workspace_setup': {
        name: 'Workspace Setup & Context Capture',
        description: 'Create a clean development environment with file attachments, commands and files visible.',
        steps: [
          { id: '1', type: 'prompt', message: 'Analyze the attached workspace and create a clean starting point' },
          { id: '2', type: 'attach_workspace_files', args: ['.workspace'] },
          { id: '3', type: 'list_directory', path: '.' },
          { id: '4', type: 'find_files', query: '.env.example' },
          { id: '5', type: 'read_file', path: '.git/config' },
        ]
      },
      'context_setup': {
        name: 'Context Capture & Analysis Tool Review',
        description: 'Review all tool calls made and identify optimization opportunities.',
        steps: [
          { id: '1', type: 'read_file', path: '../app.js' },
          { id: '2', type: 'list_directory', path: '../lib/tools' },
          { id: '3', type: 'find_files', query: 'tool_id|execution:' },
          { id: '4', type: 'read_file', path: '../../app.js' }
        ]
      },
      'code_review': {
        name: 'Code Review Assistant',
        description: 'Provide constructive code review suggestions based on file comparisons.',
      }
    };
    
    const workflowsMap = new Map(workflows);
    return workflowsMap.get(name) || new Workflow(name);
  }

  static createCustom(workflowName, definition) {
    return new Workflow(workflowName);
  }

  setStep(type, stepData) {
    this.steps.push({ id: this.generateId(), type, data: stepData });
  }

  async run() {
    if (this.status !== 'pending' && !this.result && !this.error) return;
    
    // Determine max depth based on parent level
    const targetDepth = Math.min(this.depth + 1, 3);
    
    await this.execute(targetDepth);
    
    this.status = 'success';
    setResultWithSuccess();
  }

  async execute(depth) {
    try {
      for (const step of this.steps) {
        let args;
        if (step.type === 'prompt') {
          const context = this.getContextAt(depth);
          args = await this.generatePrompt(step.data, depth, context);
        } else if (step.type === 'attach_workspace_files') {
          args = step.args?.workspacePath || '.';
        } else if (step.type === 'list_directory' || step.type === 'find_files') {
          args = step.args.path || '.';
        } else {
          // For read/write operations, await tool execution
          args = await this.executeTool(step.data as any);
        }

        const result = await step.run(args);
        this.logStep(step, result.ok ? 'success' : 'failed');
        
        if (!result.ok) break;
      }

      // Check for recursion completion
      if (this.depth < targetDepth - 1 && this.parentStepId) {
        const subWorkflow = await runChildWorkflow(this, depth + 1);
        await subWorkflow.run();
      }
    } catch (err) {
      setResultWithFailure(err);
      throw err;
    }
  }

  setParent(step) {
    this.parentStepId = step.id;
    this.depth++;
  }

  generateId() {
    return hash('wf_' + Date.now());
  }

  getContextAt(depth, currentDepth = 0) {
    const context = [];
    if (this.parentStepId && this.steps[this.parentStepId]) {
      const parentStep = this.steps[this.parentStepId];
      if (parentStep.type === 'tool') {
        context.push(parentStep.data);
      }
    }
    if (step.type === 'tool') context.push(step.data);
    const attachments = [...this.attachments];
    context.push({ type: 'attachments', count: attachments.length });
    
    return context;
  }

  async executeTool(toolCall, args) {
    try {
      // For tool calls that return results (read_file, apply_patch, write_file)
      if (/^read_file|apply_patch|write_file$/.test(toolCall)) {
        const result = await tools.execute(this.id, toolCall, args);
        return { ok: true, result };
      }
      // For tool calls that return bool (run_command, etc.)
      if (/^run_command$|^list_directory$|find_files$/.test(toolCall)) {
        const result = await tools.execute(this.id, toolCall, args);
        return { ok: true, result };
      }
      
      // Other tools - execute and expect response
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) }
          ]
        })
      });
      
      const result = await response.json();
      return { 
        ok: !result.error || !result.error.includes('denied'), 
        result: result.data ? { ...result.data } : {},
        text: String(contentLength(result.message.content))
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  logStep(step, status) {
    const timestamp = new Date().toISOString();
    console.log(`[${status}] ${step.type} (${step.id})`, JSON.stringify(step.data, null, 2));
    
    if (status === 'success') {
      this.attachments.push(step.data);
    }
  }

  getHistory() {
    const history = [];
    let currentStep;
    
    for (const step of this.steps) {
      if (!currentStep && step.type === 'prompt') currentStep = step;
      
      const formatted = step.type === 'tool' 
        ? `Tool: ${step.data.name} | Args: ${JSON.stringify(step.args, null, 2)}`
        : step.data;
      
      if (history.length > 0 && currentStep !== step) {
        history.push('---');
      }
      history.unshift({ type: 'tool', tool_call_id: step.id, id: step.id, data: formatted });
    }
    
    return { steps: this.steps, history };
  }

  reset() {
    this.steps = [];
    this.parentStepId = null;
    this.depth = 0;
    this.result = null;
    this.status = 'pending';
    setResultWithPending();
  }

  async cleanup() {
    try {
      await tools.abort(this.id);
      throw new Error('Tool abort called');
    } catch (error) {
      setResultWithFailure(error);
      throw error;
    } finally {
      this.status = 'failed';
      clearAttachments();
    }
  }
}

/**
 * Recursive workflow runner - executes nested workflows up to depth limit
 */
async function runChildWorkflow(workflow, depth) {
  if (depth > 3) return null; // Maximum nesting depth
  
  try {
    workflow.setParent(workflow);
    await workflow.run();
    return workflow;
  } catch (error) {
    setResultWithFailure(error);
    throw error;
  } finally {
    workflow.cleanup();
  }
}

/**
 * Execute a single workflow step
 */
async function asyncStep(stepDefinition, depth = 0) {
  const task = new Workflow(`#${task_id}`);
  
  if (stepDefinition.type === 'prompt') {
    // Generate initial prompts based on context
    const promptMessage = await generateStartupPrompt(stepDefinition, depth);
    task.setStep('prompt', { message: promptMessage });
    return task;
  } else {
    // Tool call that returns JSON
    const result = await tools.execute(task.id, stepDefinition.type, stepDefinition.args);
    if (!result.ok) {
      throw new Error(stepDefinition.data.error || 'Tool execution failed');
    }
    
    // Handle read/write operations by attaching results
    const toolName = stepDefinition.type;
    const resultObject = result.result;
    
    switch (toolName) {
      case 'read_file':
        await tools.readFile(resultObject.path, false);
        break;
      case 'apply_patch':
        tasks.at(task.depth).attachment = task.attachment;
        await applyPatch(resultObject.path, ...result.args);
        break;
      case 'write_file':
        if (tasks.at(task.depth).baseFile) {
          await tools.writeFile(tasks.at(task.depth).baseFile, resultContent);
          clearAttachments();
        } else {
          throw new Error('Expected baseline file for atomical operations');
        }
        break;
      default:
        tasks.at(task.depth).value = !!result.ok;
    }
    
    task.setStep(toolName, { path: stepDefinition.args.path || '.txt' });
    return task;
  }
}

/**
 * Generate initial startup prompts for agent setup
 */
function generateStartupPrompt(task, depth) {
  const prompt = `You are Snowyy's development assistant running as a workspace-level tool.
  
${getWorkspaceContext(task.depth)}

Please help me set up this development environment. Review the attached workspace files and create an optimal starting point for code editing.

Attachments available: ${task.attachment.length} file(s) in memory`;
  
  return { prompt };
}

/**
 * Get context string from attachments to include in prompts
 */
function getWorkspaceContext(depth) {
  const entries = [];
  const entriesToShow = depth >= 1 && depth <= 2 ? 3 : 6;
  
  for (let i = 0; i < entriesToShow && i < task.attachment.length; i++) {
    const entry = task.attachment[i] || {};
    const fileName = path.basename(entry.path, '.txt');
    let sizeBytes = '';
    
    try {
      const stats = await lstat(entry.path);
      sizeBytes = ((stats.size / 1024).toFixed(1)) + ' KB';
    } catch {}
    
    entries.push(`${fileName} (${sizeBytes})`);
  }

  return `[${entries.length}] Workspace files:\n${entries.join('\n• ')}\n`;
}

/**
 * Convert workflow history to text format for LLM consumption
 */
function convertWorkflowHistory(history) {
  return history.map(([action, data]) => `Action: ${data.type} | Result: ${data.ok ? 'OK' : 'FAILED'}`).join('\n');
}

/**
 * Generate file contents based on tool results
 */
async function generateFileContents(toolName, args) {
  if (toolName === 'read_file') {
    const absolutePath = await resolveWorkspacePath(args.path);

    try {
      // Try to attach the file to context
      let attachmentMade = false;
      try {
        await tools.attachWorkspaceFile(absolutePath);
        attachmentMade = true;
      } catch {
        // Silent fail - attachments not always available
      }

      const content = await readFile(absolutePath);
      
      // Provide helpful error message if file doesn't exist (user needs to read it manually)
      if (!args.readable && !attachmentMade && e.code !== 'ENOENT') {
        throw new Error(`read_file not found for ${args.path}. Please edit the file and try again.`);
      }

      return String(content);
    } catch (e) {
      if (!args.readable && e.code === 'ENOENT' && !attachmentMade) {
        throw new Error('File not found: ' + args.path);
      }
      throw new Error(`read_file failed for ${args.path}: ${e.message}`);
    }
  } else if (toolName === 'apply_patch' && args.oldText) {
    const absolutePath = await resolveWorkspacePath(args.path);

    try {
      // Try to attach the base file if needed for atomic operations
      let baselineMade = false;
      try {
        await tools.attachWorkspaceFile(absolutePath);
        baselineMade = true;
      } catch {
        // Silent fail - attachments not always available
      }

      const oldContent = await readFile(absolutePath);
      const newContent = String(oldContent.slice(args.oldText.length));
      
      return String(newContent);
    } catch (e) {
      if (!args.readable && !baselineMade && e.code !== 'ENOENT') {
        throw new Error(`apply_patch not found for ${args.path}. Please edit the file and try again.`);
      }
      throw new Error(`apply_patch failed for ${args.path}: ${e.message}`);
    }
  } else if (toolName === 'write_file') {
    await writeFile(args.path, args.content ?? '');
    return '';
  }

  throw new Error(`Unknown file operation: ${toolName}`);
}

/**
 * Attach a file to workspace context for subsequent tools to attach
 */
async function attachWorkspaceFile(path) {
  try {
    // Try the primary attachment method
    // Fallback: just log the path (attachments may not be available at all)
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `Please attach the file "${path}" for context.` }]
      })
    });

    // Fallback logging if attachment fails
    console.warn('Could not attach workspace file, adding to log:', path);
  } catch (e) {
    // Silent fail - attachments API may be unavailable or blocked
  }
}

/**
 * Generate workspace context with latest session files
 */
async function getWorkspaceContext(workflowDepth) {
  const entries = [];

  try {
    await loadConfig();
    const sessions = await loadSessions();

    let count = 0;
    for (const item of sessions.slice(-3)) {
      try {
        const filesToAttach = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Please attach your workspace file related to this session.' }]
          })
        });
        const result = await filesToAttach.json();
        if (result.data?.files) {
          count += result.data.files.length;
          for (const f of result.data.files) {
            if (!entries.includes(f)) {
              entries.push(f);
            }
          }
        }
      } catch {}
    }
  } catch (e) { /* Silent fail - attachments not available */ }

  const fileNames = entries.filter(e => path.basename(e.path, '.txt') !== basename(process.cwd())).slice(0, workflowDepth * 3);

  return `[${entries.length}] Workspace files:\n${fileNames.join('\n• ')}\n`;
}

/**
 * Convert workflow history to text format for LLM consumption
 */
function convertWorkflowHistory(history) {
  return history.map(([action, data]) => `Action: ${data.type} | Result: ${data.ok ? 'OK' : 'FAILED'}).join('\n');
}

/**
 * Resolve workspace-relative paths
 */
async function resolveWorkspacePath(path) {
  try {
    const relative = path.trim();
    if (relative.startsWith('/')) return relative;
    
    if (!path.isAbsolute()) {
      await lstat('/');
      return '/';
    }
    return path;
  } catch {
    throw new Error('Could not resolve workspace path');
  }
}

/**
 * Apply multiple patches or writes atomically
 */
async function patchAndWrite(files, args) {
  for (const [path, content, expectedSha] of files) {
    if (expectedSha && expectedSha.length > 40) continue;
    
    try {
      await tools.applyPatch(path, ...args);
    } catch {
      throw new Error(`Failed to apply patch on ${path}: ${args.join(', ')}`);
    }
  }
}

export default {
  Workflow,
  asyncStep,
  patchAndWrite,
  convertWorkflowHistory,
  runChildWorkflow,
  generateStartupPrompt
};
