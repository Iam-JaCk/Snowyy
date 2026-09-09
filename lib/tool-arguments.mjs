import path from 'node:path';
import { lstat } from 'node:fs/promises';

const pathTools = new Set(['list_directory', 'find_files', 'search_text', 'read_file', 'apply_patch', 'write_file', 'insert_text', 'replace_lines', 'delete_lines']);

export async function normalizeToolArguments(state, name, originalArgs) {
  const args = { ...originalArgs };
  const adjustments = [];
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
