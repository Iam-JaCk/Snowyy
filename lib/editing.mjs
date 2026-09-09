import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lineStarts, readWorkspaceText } from './workspace-text.mjs';
import { toolError } from './tool-contracts.mjs';

const MAX_WRITE_CHARS = 500_000;
const workspaceWrites = new Map();

function hash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function boundedDiff(before, after) {
  if (before === after) return 'No textual changes.';
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const output = [`@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`];
  oldLines.slice(contextStart, prefix).forEach((line) => output.push(` ${line}`));
  oldLines.slice(prefix, oldEnd).forEach((line) => output.push(`-${line}`));
  newLines.slice(prefix, newEnd).forEach((line) => output.push(`+${line}`));
  const contextSuffix = oldLines.slice(oldEnd, Math.min(oldLines.length, oldEnd + 3));
  contextSuffix.forEach((line) => output.push(` ${line}`));
  if (output.length > 500) return `${output.slice(0, 500).join('\n')}\n… diff truncated …`;
  return output.join('\n');
}

export const editingToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Replace one unique exact block copied from read_file. Best for targeted edits. Replacement is literal, not a unified diff. Use more surrounding context if the block occurs more than once.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        old_text: { type: 'string', description: 'Exact raw, unnumbered text copied from read_file. Use an empty string only when creating a new file.' },
        new_text: { type: 'string', maxLength: MAX_WRITE_CHARS, description: 'Required literal replacement text. Use an empty string to delete old_text.' },
        expected_sha256: { type: 'string', description: 'Optional full-file SHA-256 from read_file to refuse edits if any part of the file has changed.' }
      }, required: ['path', 'old_text', 'new_text'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a complete file. For a new file, expected_sha256 must be exactly the empty string. Existing files require the exact latest SHA-256 from read_file. Never invent a hash or use a sha256: prefix. Requires approval.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Complete new UTF-8 file content.' },
        expected_sha256: { type: 'string', description: 'Use exactly an empty string (\"\") for a new file. For an existing file, use the exact 64-character hash returned by the latest read_file call.' }
      }, required: ['path', 'content', 'expected_sha256'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_text',
      description: 'Insert complete lines before a one-based line, or append at total_lines + 1. A trailing newline in text is accepted without adding an extra blank line. Requires the latest read_file SHA-256.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Workspace-relative path of an existing file that was just read.' }, line: { type: 'integer', minimum: 1, description: 'One-based line before which text is inserted.' }, text: { type: 'string', description: 'Raw UTF-8 text to insert.' }, expected_sha256: { type: 'string', description: 'Exact 64-character hash returned by the latest read_file call.' }
      }, required: ['path', 'line', 'text', 'expected_sha256'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_lines',
      description: 'Replace an inclusive line range using the latest read_file SHA-256. A trailing newline in new_text is accepted; empty new_text deletes the range.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Workspace-relative path of an existing file that was just read.' }, start_line: { type: 'integer', minimum: 1, description: 'First one-based line to replace, inclusive.' }, end_line: { type: 'integer', minimum: 1, description: 'Last one-based line to replace, inclusive.' }, new_text: { type: 'string', description: 'Complete replacement text for the selected line range.' }, expected_sha256: { type: 'string', description: 'Exact 64-character hash returned by the latest read_file call.' }
      }, required: ['path', 'start_line', 'end_line', 'new_text', 'expected_sha256'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_lines',
      description: 'Delete an inclusive line range using the latest read_file SHA-256. Requires approval.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Workspace-relative path of an existing file that was just read.' }, start_line: { type: 'integer', minimum: 1, description: 'First one-based line to delete, inclusive.' }, end_line: { type: 'integer', minimum: 1, description: 'Last one-based line to delete, inclusive.' }, expected_sha256: { type: 'string', description: 'Exact 64-character hash returned by the latest read_file call.' }
      }, required: ['path', 'start_line', 'end_line', 'expected_sha256'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_changes',
      description: 'Atomically replace multiple complete files. Every existing file needs its latest read_file SHA-256. Requires approval.',
      parameters: { type: 'object', properties: {
        changes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' }, content: { type: 'string', description: 'Complete new UTF-8 file content.' }, expected_sha256: { type: 'string', description: 'Use exactly an empty string for a new file; otherwise use the exact latest read_file hash.' }
        }, required: ['path', 'content', 'expected_sha256'], additionalProperties: false } }
      }, required: ['changes'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rollback_change',
      description: 'Roll back a recent Snowyy edit transaction if files have not changed since it ran. Requires approval.',
      parameters: { type: 'object', properties: { transaction_id: { type: 'string', description: 'Exact transaction_id returned by the edit operation being rolled back.' } }, required: ['transaction_id'], additionalProperties: false }
    }
  }
];

export function createEditingRegistry(sandbox) {
  const history = new Map();
  async function fileState(userPath, allowMissing = false) {
    const absolute = await sandbox.resolveForWrite(userPath);
    try {
      await access(absolute, fsConstants.F_OK);
      const canonical = await sandbox.resolveExisting(userPath);
      const stat = await lstat(canonical);
      if (!stat.isFile()) throw new Error(`${userPath} is not a file.`);
      const content = await readWorkspaceText(canonical, userPath);
      return { path: sandbox.relative(canonical), absolute: canonical, exists: true, content, sha256: hash(content) };
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return { path: userPath, absolute, exists: false, content: '', sha256: '' };
      throw error;
    }
  }

  function checkExpected(state, expected) {
    if (typeof expected !== 'string') throw new Error('expected_sha256 is required. Read the file immediately before editing.');
    if (!state.exists && expected !== '') throw new Error('New files require an empty expected_sha256.');
    if (state.exists && state.sha256 !== expected.toLowerCase()) throw toolError('FILE_CHANGED', `File changed since it was read: ${state.path}.`, 'Call read_file again and rebuild the edit from the current content and hash.');
  }

  async function prepareWhole({ path: userPath, content, expected_sha256: expected }) {
    if (!userPath || typeof content !== 'string') throw new Error('path and content are required.');
    if (content.length > MAX_WRITE_CHARS) throw new Error('Content exceeds the 500 KB write limit.');
    const state = await fileState(userPath, true);
    checkExpected(state, expected);
    return { ...state, after: content };
  }

  async function preparePatch({ path: userPath, old_text: oldText, new_text: newText, expected_sha256: expected }) {
    if (!userPath || typeof oldText !== 'string') throw new Error('path and old_text are required.');
    if (typeof newText !== 'string') throw new Error('new_text is required. Use an empty string only to delete old_text.');
    const state = await fileState(userPath, oldText === '');
    if (expected !== undefined) checkExpected(state, expected);
    if (!state.exists && oldText !== '') throw new Error('New files require empty old_text.');
    if (state.exists && oldText === '') throw new Error('old_text cannot be empty for an existing file.');
    let after;
    if (!state.exists) after = newText;
    else {
      const normalized = state.content.replace(/\r\n/g, '\n');
      const normalizedOld = oldText.replace(/\r\n/g, '\n');
      const first = normalized.indexOf(normalizedOld);
      if (first === -1) throw toolError('PATCH_NOT_FOUND', 'old_text did not match the file.', 'Read the relevant lines again and copy exact raw text without line-number prefixes.');
      if (normalized.indexOf(normalizedOld, first + 1) !== -1) throw toolError('PATCH_AMBIGUOUS', 'old_text matched more than once.', 'Include more surrounding unchanged lines so old_text identifies exactly one location.');
      // Map normalized offsets back to the original text, preserving other line endings.
      const originalOffset = (offset) => {
        let original = 0;
        for (let i = 0; i < offset; i += 1) {
          original += state.content[original] === '\r' && state.content[original + 1] === '\n' ? 2 : 1;
        }
        return original;
      };
      const newline = state.content.includes('\r\n') ? '\r\n' : '\n';
      const replacement = newText.replace(/\r\n/g, '\n').replace(/\n/g, newline);
      // String.replace treats $&, $`, $' and $$ as replacement operators.
      after = state.content.slice(0, originalOffset(first)) + replacement + state.content.slice(originalOffset(first + normalizedOld.length));
    }
    return { ...state, after };
  }

  async function prepareLines(name, args) {
    const state = await fileState(args.path);
    checkExpected(state, args.expected_sha256);
    const newline = state.content.includes('\r\n') ? '\r\n' : '\n';
    const starts = lineStarts(state.content);
    const normalize = (text) => text.replace(/\r\n/g, '\n').replace(/\n/g, newline);
    let after;
    if (name === 'insert_text') {
      if (typeof args.text !== 'string') throw toolError('INVALID_ARGUMENTS', 'text is required and must be a string.', 'Supply the literal text to insert.');
      const maximum = state.content ? starts.length + 1 : 1;
      if (!Number.isInteger(args.line) || args.line < 1 || args.line > maximum) throw toolError('INVALID_LINE_RANGE', `line must be between 1 and ${maximum}.`, 'Read the file again to obtain its current line numbers.');
      const position = starts[args.line - 1] ?? state.content.length;
      let inserted = normalize(args.text);
      if (inserted && position === state.content.length && state.content && !state.content.endsWith('\n')) inserted = newline + inserted;
      if (inserted && (position < state.content.length || state.content.endsWith('\n')) && !inserted.endsWith('\n')) inserted += newline;
      after = state.content.slice(0, position) + inserted + state.content.slice(position);
    } else {
      const start = args.start_line;
      const end = args.end_line;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > starts.length) throw toolError('INVALID_LINE_RANGE', `Line range must be between 1 and ${starts.length}.`, 'Read the file again and use an inclusive range of existing lines.');
      if (name !== 'delete_lines' && typeof args.new_text !== 'string') throw toolError('INVALID_ARGUMENTS', 'new_text is required and must be a string.', 'Supply the literal replacement text.');
      let replacement = name === 'delete_lines' ? '' : normalize(args.new_text);
      if (replacement && (end < starts.length || state.content.endsWith('\n')) && !replacement.endsWith('\n')) replacement += newline;
      after = state.content.slice(0, starts[start - 1]) + replacement + state.content.slice(starts[end] ?? state.content.length);
    }
    return { ...state, after };
  }

  async function prepare(name, args) {
    if (name === 'apply_patch') return [await preparePatch(args)];
    if (name === 'write_file') return [await prepareWhole(args)];
    if (['insert_text', 'replace_lines', 'delete_lines'].includes(name)) return [await prepareLines(name, args)];
    if (name === 'apply_changes') {
      if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 20) throw new Error('changes must contain 1–20 files.');
      const prepared = [];
      for (const change of args.changes) prepared.push(await prepareWhole(change));
      if (new Set(prepared.map((item) => process.platform === 'win32' ? item.absolute.toLowerCase() : item.absolute)).size !== prepared.length) throw new Error('A transaction cannot contain the same path twice.');
      return prepared;
    }
    throw new Error(`Unknown editing tool: ${name}`);
  }

  async function checkSyntax(file) {
    const extension = path.extname(file.absolute).toLowerCase();
    if (extension === '.json') {
      JSON.parse(file.after.replace(/^\uFEFF/, ''));
      return { checked: true, status: 'valid', tool: 'JSON.parse', ok: true };
    }
    if (!['.js', '.mjs', '.cjs'].includes(extension)) return { checked: false, status: 'unverified', ok: null };
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--check', file.absolute], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(0, 2000); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const ok = code === 0 && !timedOut;
        resolve({ checked: true, status: ok ? 'valid' : 'invalid', tool: 'node --check', ok, message: timedOut ? 'Syntax checker timed out.' : stderr });
      });
      child.on('error', (error) => { clearTimeout(timer); resolve({ checked: false, status: 'unverified', tool: 'node --check', ok: false, message: error.message }); });
    });
  }

  async function restore(files) {
    for (const file of files) {
      if (file.exists) await writeFile(file.absolute, file.content, 'utf8');
      else await rm(file.absolute, { force: true });
    }
  }

  async function commit(name, args, { approvedPreview, signal } = {}) {
    signal?.throwIfAborted();
    if (name === 'rollback_change') return rollback(args);
    const files = await prepare(name, args);
    if (approvedPreview?.kind === 'diff') {
      if (approvedPreview.files.length !== files.length || files.some((file) => !approvedPreview.files.some((preview) => preview.path === file.path && preview.before_sha256 === file.sha256))) {
        throw toolError('FILE_CHANGED', 'A file changed after the edit preview was approved.', 'Read the current file and request approval for a fresh preview.');
      }
    }
    for (const file of files) {
      if (file.after.length > MAX_WRITE_CHARS) throw toolError('WRITE_TOO_LARGE', 'Edited content exceeds the 500 KB character limit.', 'Keep the resulting file within the text-edit limit.');
      const current = await fileState(file.path, true);
      if (current.sha256 !== file.sha256 || current.exists !== file.exists) throw toolError('FILE_CHANGED', `File changed while preparing the edit: ${file.path}.`, 'Read the current file and rebuild the edit.');
    }
    const validations = [];
    const written = [];
    try {
      for (const file of files) {
        signal?.throwIfAborted();
        await mkdir(path.dirname(file.absolute), { recursive: true });
        written.push(file);
        await writeFile(file.absolute, file.after, 'utf8');
      }
      for (const file of files) {
        const validation = await checkSyntax(file);
        validations.push({ path: file.path, ...validation });
        if (validation.ok === false) throw toolError('SYNTAX_INVALID', `Syntax validation failed for ${file.path}: ${validation.message || 'unknown error'}`, 'The edit was rolled back. Correct the syntax before retrying.');
      }
    } catch (error) {
      await restore(written);
      throw error;
    }
    const transactionId = randomUUID();
    history.set(transactionId, files.map((file) => ({ ...file, afterHash: hash(file.after) })));
    while (history.size > 30) history.delete(history.keys().next().value);
    return { transaction_id: transactionId, files: files.map((file) => ({ path: sandbox.relative(file.absolute), created: !file.exists, bytes: Buffer.byteLength(file.after), previous_sha256: file.sha256 || null, sha256: hash(file.after) })), validation: validations };
  }

  async function rollback({ transaction_id: transactionId }) {
    const files = history.get(transactionId);
    if (!files) throw new Error('Rollback transaction was not found or has expired.');
    for (const file of files) {
      const current = await fileState(file.path, true);
      if (!current.exists || current.sha256 !== file.afterHash) throw new Error(`${file.path} changed after the transaction; rollback was refused.`);
    }
    await restore(files);
    history.delete(transactionId);
    return { rolled_back: transactionId, files: files.map((file) => file.path) };
  }

  async function preview(name, args) {
    if (name === 'rollback_change') return { kind: 'rollback', transaction_id: args.transaction_id, diff: 'Restore files from the selected Snowyy transaction.' };
    const files = await prepare(name, args);
    return {
      kind: 'diff',
      files: files.map((file) => ({ path: sandbox.relative(file.absolute), diff: boundedDiff(file.content, file.after), before_sha256: file.sha256, after_sha256: hash(file.after) }))
    };
  }

  function execute(name, args, context) {
    const key = process.platform === 'win32' ? sandbox.root.toLowerCase() : sandbox.root;
    const previous = workspaceWrites.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => commit(name, args, context));
    workspaceWrites.set(key, operation);
    return operation.finally(() => { if (workspaceWrites.get(key) === operation) workspaceWrites.delete(key); });
  }

  return { execute, preview };
}

export function summarizeEditingCall(name, args = {}) {
  if (name === 'apply_changes') return { title: `Edit ${args.changes?.length || 0} files`, detail: 'Atomic multi-file transaction', risk: 'write' };
  if (name === 'rollback_change') return { title: 'Rollback change', detail: args.transaction_id || '', risk: 'write' };
  const target = args.path || 'file';
  const details = name === 'apply_patch' ? `${String(args.old_text || '').length} → ${String(args.new_text || '').length} characters`
    : name === 'write_file' ? `${String(args.content || '').length} characters`
      : name === 'insert_text' ? `Insert at line ${args.line}`
        : `Lines ${args.start_line}–${args.end_line}`;
  return { title: `${name.replaceAll('_', ' ')} · ${target}`, detail: details, risk: 'write' };
}
