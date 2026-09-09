import path from 'node:path';
import { lstat } from 'node:fs/promises';

const pathTools = new Set(['list_directory', 'find_files', 'search_text', 'read_file', 'apply_patch', 'write_file', 'insert_text', 'replace_lines', 'delete_lines']);
const editingTools = new Set(['apply_patch', 'write_file', 'insert_text', 'replace_lines', 'delete_lines']);
const mutatingTools = new Set([...editingTools, 'apply_changes', 'rollback_change', 'run_command']);

function samePath(left, right) {
  const a = String(left || '').replaceAll('\\', '/');
  const b = String(right || '').replaceAll('\\', '/');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function mutationTouchesPath(entry, target) {
  if (!entry?.ok || !mutatingTools.has(entry.name)) return false;
  if (entry.name === 'run_command') return true;
  if (samePath(entry.args?.path, target)) return true;
  return Array.isArray(entry.result?.files) && entry.result.files.some((file) => (
    samePath(typeof file === 'string' ? file : file?.path, target)
  ));
}

function latestTrustedRead(state, target) {
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (mutationTouchesPath(entry, target)) return null;
    if (entry?.type === 'tool' && entry.name === 'read_file' && entry.ok === true
      && samePath(entry.result?.path || entry.args?.path, target) && /^[a-f0-9]{64}$/i.test(entry.result?.sha256 || '')) {
      return entry.result;
    }
  }
  return null;
}

function readCoversEdit(read, name, args) {
  if (!read) return false;
  if (name === 'write_file') return read.truncated === false && read.start_line === 1;
  if (name === 'apply_patch') {
    if (typeof args.old_text !== 'string' || !args.old_text) return false;
    return String(read.content || '').replace(/\r\n/g, '\n').includes(args.old_text.replace(/\r\n/g, '\n'));
  }
  const start = name === 'insert_text' ? args.line : args.start_line;
  const end = name === 'insert_text' ? args.line : args.end_line;
  return Number.isInteger(start) && Number.isInteger(end)
    && start >= read.start_line && end <= read.end_line + (name === 'insert_text' ? 1 : 0);
}

export async function normalizeToolArguments(state, name, originalArgs) {
  const args = { ...originalArgs };
  const adjustments = [];
  if (name === 'read_file' && Object.hasOwn(args, 'expected_sha256')) {
    delete args.expected_sha256;
    adjustments.push('Removed expected_sha256 because read_file is read-only.');
  }
  if (name === 'apply_changes' && Array.isArray(args.changes)) {
    args.changes = await Promise.all(args.changes.map(async (change, index) => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) return change;
      const normalized = await normalizeToolArguments(state, 'write_file', change);
      adjustments.push(...normalized.adjustments.map((message) => `changes[${index}]: ${message}`));
      return normalized.args;
    }));
    return { args, adjustments };
  }
  const field = name === 'run_command' ? 'cwd' : pathTools.has(name) ? 'path' : null;
  if (!field || typeof args[field] !== 'string' || !args[field].trim()) return { args, adjustments };
  const originalPath = args[field];
  let requestedPath = originalPath.trim();
  if (requestedPath.startsWith('@') && requestedPath.length > 1) {
    try {
      await lstat(state.registry.sandbox.resolve(requestedPath));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      requestedPath = requestedPath.slice(1);
      adjustments.push('Removed the @ file-mention marker from the path.');
    }
  }
  if (!path.isAbsolute(requestedPath)) {
    const parts = requestedPath.split(/[\\/]+/).filter(Boolean);
    const workspaceName = path.basename(state.workspaceRoot);
    if (parts.length > 1 && parts[0].toLowerCase() === workspaceName.toLowerCase()) {
      try { await lstat(path.join(state.workspaceRoot, parts[0])); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        requestedPath = parts.slice(1).join('/');
        adjustments.push(`Removed redundant workspace prefix ${parts[0]}/ from the path.`);
      }
    }
  }
  const absolute = state.registry.sandbox.resolve(requestedPath);
  args[field] = state.registry.sandbox.relative(absolute);
  if (args[field] !== originalPath && !adjustments.length) adjustments.push('Converted the target to a workspace-relative path.');
  if (editingTools.has(name)) {
    const read = latestTrustedRead(state, args.path);
    if (readCoversEdit(read, name, args) && args.expected_sha256 !== read.sha256) {
      args.expected_sha256 = read.sha256;
      adjustments.push('Used the latest unchanged read_file SHA-256 for this edit.');
    }
  }
  if (name === 'write_file') {
    // Correct the new-file sentinel only after confirming that no file exists.
    await state.registry.sandbox.resolveForWrite(args.path);
    try { await lstat(absolute); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (args.expected_sha256 !== '') {
        args.expected_sha256 = '';
        adjustments.push('Set expected_sha256 to the required empty string for a confirmed new file.');
      }
    }
  }
  return { args, adjustments };
}
