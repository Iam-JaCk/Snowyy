import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createPathSandbox } from './path-sandbox.mjs';
import { createEditingRegistry, editingToolDefinitions, summarizeEditingCall } from './editing.mjs';
import { toolError, validateToolArguments } from './tool-contracts.mjs';
import { lineStarts, readWorkspaceText, textHash } from './workspace-text.mjs';
import { ALLOWED_EXECUTABLES, runWorkspaceCommand } from './commands.mjs';
import { createWebTools } from './web-tools.mjs';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.Snowyy', '.forge', 'dist', 'build', 'out', 'coverage', '.next']);
const MAX_READ_OUTPUT_BYTES = 200_000;
const directoryPath = { type: 'string', description: 'Workspace-relative directory. Defaults to .' };
const limit = { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum results per call.' };
const offset = { type: 'integer', minimum: 0, maximum: 10_000, description: 'Pagination offset. Use next_offset from the previous result. Defaults to 0.' };
const define = (name, description, properties, required = []) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } }
});

export const toolDefinitions = [
  define('list_directory', 'List one directory, with pagination. Read-only. Common build and dependency directories are omitted.', { path: directoryPath, limit, offset }),
  define('find_files', 'Find file paths by case-insensitive substring or glob (*, **, ?). Searches names, not contents; use search_text for code. Read-only.', {
    query: { type: 'string', maxLength: 500, description: 'Path substring or glob, e.g. provider or **/*.mjs. Empty string lists all files.' },
    path: directoryPath, limit, offset
  }, ['query']),
  define('search_text', 'Find literal text inside UTF-8 workspace files. Returns matching lines and columns for follow-up read_file calls. Read-only; symlinks and common build/dependency directories are skipped.', {
    query: { type: 'string', minLength: 1, maxLength: 300, description: 'Literal text to search for, not a regular expression. A single line only.' },
    path: { type: 'string', description: 'Workspace-relative file or starting directory. Defaults to .' },
    file_query: { type: 'string', maxLength: 500, description: 'Optional path substring or glob, e.g. **/*.js.' },
    case_sensitive: { type: 'boolean', description: 'Defaults to false.' }, limit
  }, ['query']),
  define('read_file', 'Read raw UTF-8 lines and the full-file SHA-256. Supports files up to 2 MB and returns up to 1,000 lines / 200 KB per call. Continue with next_start_line when present. Read-only.', {
    path: { type: 'string', minLength: 1, description: 'Workspace-relative file path.' },
    start_line: { type: 'integer', minimum: 1, description: 'First line, inclusive. Defaults to 1.' },
    end_line: { type: 'integer', minimum: 1, description: 'Last line, inclusive. Defaults to start + 399. Capped at EOF and start + 999.' }
  }, ['path']),
  define('web_search', 'Search the public web with DuckDuckGo. Returns titles, URLs, and short snippets for follow-up fetch_url calls. Read-only.', {
    query: { type: 'string', minLength: 1, maxLength: 500, description: 'Specific search query.' },
    limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum results. Defaults to 8.' }
  }, ['query']),
  define('fetch_url', 'Fetch one public HTTP or HTTPS page as bounded readable text. Local and private network addresses are blocked. Read-only.', {
    url: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Absolute public webpage URL.' },
    max_chars: { type: 'integer', minimum: 1_000, maximum: 100_000, description: 'Maximum returned characters. Defaults to 30000.' }
  }, ['url']),
  define('list_goals', 'List the current session goals and their status. Read-only.', {}),
  define('create_goal', 'Create a persistent goal for work that spans several steps or turns. The goal is shown below the chat.', {
    title: { type: 'string', minLength: 1, maxLength: 64, description: 'Short, concrete objective.' }
  }, ['title']),
  define('update_goal', 'Rename a session goal or mark it active/complete.', {
    goal_id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1, maxLength: 64 },
    status: { type: 'string', enum: ['active', 'complete'] }
  }, ['goal_id']),
  define('delete_goal', 'Remove a session goal that is no longer useful.', {
    goal_id: { type: 'string', minLength: 1 }
  }, ['goal_id']),
  define('run_command', 'Run a command with a literal argument array, subject to session approval settings. Put the program in executable and only its arguments in args. Example: {"executable":"npx","args":["tsc","--noEmit"]}. No shell pipelines or redirection. Inspect ok, exit_code, stdout and stderr; nonzero exits and timeouts are failures.', {
    executable: { type: 'string', enum: ALLOWED_EXECUTABLES, description: 'Program to run, such as node, npm, npx, git, rg, python, or powershell. This field is required.' },
    args: { type: 'array', items: { type: 'string' }, maxItems: 40, description: 'Only program arguments, as separate array entries. Do not repeat the executable here. Defaults to [].' },
    cwd: directoryPath,
    timeout_ms: { type: 'integer', minimum: 1000, maximum: 60000, description: 'Timeout in milliseconds. Defaults to 20000.' }
  }, ['executable']),
  ...editingToolDefinitions
];

function pathMatches(relativePath, query) {
  const candidate = relativePath.toLowerCase();
  const pattern = query.toLowerCase().replaceAll('\\', '/');
  if (!/[*?]/.test(pattern)) return candidate.includes(pattern);
  let expression = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i += 1;
      if (pattern[i + 1] === '/') { i += 1; expression += '(?:.*/)?'; }
      else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(pattern.includes('/') ? candidate : path.posix.basename(candidate));
}

export function createToolRegistry(workspaceRoot, { web = createWebTools() } = {}) {
  const sandbox = createPathSandbox(workspaceRoot);
  const editing = createEditingRegistry(sandbox);
  const definitions = new Map(toolDefinitions.map((definition) => [definition.function.name, definition]));
  const registry = new Map([
    ['list_directory', { approval: false, execute: listDirectory }],
    ['find_files', { approval: false, execute: findFiles }],
    ['search_text', { approval: false, execute: searchText }],
    ['read_file', { approval: false, execute: readTextFile }],
    ['web_search', { approval: false, execute: (args, context) => web.webSearch(args, context) }],
    ['fetch_url', { approval: false, execute: (args, context) => web.fetchUrl(args, context) }],
    ['list_goals', { approval: false, execute: (_args, context) => context.goals.list() }],
    ['create_goal', { approval: false, execute: (args, context) => context.goals.create(args.title) }],
    ['update_goal', { approval: false, execute: (args, context) => {
      if (args.title === undefined && args.status === undefined) {
        throw toolError('INVALID_ARGUMENTS', 'update_goal requires title or status.', 'Provide the field that should change.');
      }
      return context.goals.update(args.goal_id, { title: args.title, status: args.status });
    } }],
    ['delete_goal', { approval: false, execute: (args, context) => context.goals.remove(args.goal_id) }],
    ['run_command', { approval: true, execute: (args, context) => runWorkspaceCommand(sandbox, args, context) }]
  ]);
  for (const { function: { name } } of editingToolDefinitions) {
    registry.set(name, { approval: true, execute: (args, context) => editing.execute(name, args, context), preview: (args) => editing.preview(name, args) });
  }

  async function directory(userPath) {
    const absolute = await sandbox.resolveExisting(userPath);
    if (!(await lstat(absolute)).isDirectory()) throw toolError('NOT_A_DIRECTORY', `${userPath} is not a directory.`, 'Choose a directory with list_directory, or use read_file for files.');
    return absolute;
  }

  async function listDirectory({ path: userPath = '.', limit: maximum = 200, offset: skip = 0 }) {
    const absolute = await directory(userPath);
    const entries = (await readdir(absolute, { withFileTypes: true }))
      .filter((entry) => !DEFAULT_IGNORES.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const output = await Promise.all(entries.slice(skip, skip + maximum).map(async (entry) => ({
      name: entry.name, path: sandbox.relative(path.join(absolute, entry.name)),
      type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
      size: entry.isFile() ? (await lstat(path.join(absolute, entry.name))).size : null
    })));
    const truncated = skip + output.length < entries.length;
    return { path: sandbox.relative(absolute), entries: output, truncated, next_offset: truncated ? skip + output.length : null };
  }

  async function* walk(absolute, scan, signal) {
    signal?.throwIfAborted();
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch (error) {
      scan.skipped += 1;
      if (scan.skipped_paths.length < 20) scan.skipped_paths.push({ path: sandbox.relative(absolute), code: error.code });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (DEFAULT_IGNORES.has(entry.name) || entry.isSymbolicLink()) continue;
      if (scan.visited >= 10_000) { scan.truncated = true; scan.limitReached = true; return; }
      scan.visited += 1;
      const candidate = path.join(absolute, entry.name);
      if (entry.isDirectory()) yield* walk(candidate, scan, signal);
      else if (entry.isFile()) yield candidate;
    }
  }

  async function findFiles({ query, path: userPath = '.', limit: maximum = 100, offset: skip = 0 }, { signal } = {}) {
    const start = await directory(userPath);
    const scan = { visited: 0, skipped: 0, skipped_paths: [], truncated: false };
    const files = [];
    let matched = 0;
    for await (const absolute of walk(start, scan, signal)) {
      const relative = sandbox.relative(absolute);
      if (!pathMatches(relative, query)) continue;
      if (matched++ < skip) continue;
      if (files.length === maximum) { scan.truncated = true; break; }
      files.push(relative);
    }
    return {
      query, path: sandbox.relative(start), files, truncated: scan.truncated,
      next_offset: scan.truncated && !scan.limitReached ? skip + files.length : null,
      skipped_paths: scan.skipped_paths,
      ...(scan.limitReached ? { suggestion: 'The directory scan reached its limit. Narrow path to a subdirectory before searching again.' } : {})
    };
  }

  async function searchText({ query, path: userPath = '.', file_query: fileQuery = '', case_sensitive: caseSensitive = false, limit: maximum = 100 }, { signal } = {}) {
    if (/[\r\n]/.test(query)) throw toolError('INVALID_ARGUMENTS', 'query must be a single line of literal text.', 'Search for a distinctive phrase or identifier on one line.');
    const start = await sandbox.resolveExisting(userPath);
    const scan = { visited: 0, skipped: 0, skipped_paths: [], truncated: false };
    const files = (await lstat(start)).isDirectory() ? walk(start, scan, signal) : [start];
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches = [];
    let scannedBytes = 0;
    let outputChars = 0;
    let scannedFiles = 0;
    for await (const absolute of files) {
      signal?.throwIfAborted();
      const relative = sandbox.relative(absolute);
      if (!pathMatches(relative, fileQuery)) continue;
      let content;
      try {
        const canonical = await sandbox.resolveExisting(relative);
        content = await readWorkspaceText(canonical, relative);
      } catch (error) {
        scan.skipped += 1;
        if (scan.skipped_paths.length < 20) scan.skipped_paths.push({ path: relative, code: error.code });
        continue;
      }
      scannedBytes += Buffer.byteLength(content);
      if (scannedBytes > 20_000_000) { scan.truncated = true; break; }
      scannedFiles += 1;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index];
        const column = (caseSensitive ? text : text.toLowerCase()).indexOf(needle);
        if (column === -1) continue;
        if (matches.length === maximum || outputChars >= 30_000) { scan.truncated = true; break; }
        const startColumn = Math.max(0, column - 100);
        const excerpt = text.slice(startColumn, startColumn + 500);
        matches.push({ path: relative, line: index + 1, column: column + 1, text: excerpt, text_start_column: startColumn + 1, text_truncated: excerpt.length !== text.length });
        outputChars += excerpt.length;
      }
      if (scan.truncated) break;
    }
    return {
      query, path: sandbox.relative(start), matches, truncated: scan.truncated,
      scanned_files: scannedFiles, skipped_files: scan.skipped, skipped_paths: scan.skipped_paths,
      ...(scan.truncated ? { suggestion: 'Narrow path, file_query or query to inspect the remaining matches.' } : {})
    };
  }

  async function readTextFile({ path: userPath, start_line: start = 1, end_line: requestedEnd }) {
    const absolute = await sandbox.resolveExisting(userPath);
    const content = await readWorkspaceText(absolute, userPath);
    const starts = lineStarts(content);
    if (start > starts.length || (requestedEnd !== undefined && requestedEnd < start)) {
      throw toolError('INVALID_LINE_RANGE', `Requested line range is outside ${userPath} (${starts.length} lines).`, 'Use one-based line numbers with end_line at or after start_line.', { total_lines: starts.length });
    }
    const maximumEnd = Math.min(requestedEnd ?? start + 399, starts.length, start + 999);
    let bytes = 0;
    let end = start - 1;
    for (let line = start; line <= maximumEnd; line += 1) {
      const length = Buffer.byteLength(content.slice(starts[line - 1], starts[line] ?? content.length));
      if (bytes + length > MAX_READ_OUTPUT_BYTES) break;
      bytes += length;
      end = line;
    }
    if (end < start) throw toolError('LINE_TOO_LONG', `Line ${start} exceeds the ${MAX_READ_OUTPUT_BYTES} byte output limit.`, 'Use search_text for a bounded excerpt, or an approved run_command to inspect a smaller slice.');
    return {
      path: sandbox.relative(absolute), start_line: start, end_line: end, total_lines: starts.length,
      sha256: textHash(content), content: content.slice(starts[start - 1], starts[end] ?? content.length),
      truncated: start > 1 || end < starts.length, next_start_line: end < starts.length ? end + 1 : null
    };
  }

  const get = (name) => registry.get(name) || null;
  function validate(name, args = {}) {
    const definition = definitions.get(name);
    if (!definition) throw toolError('UNKNOWN_TOOL', `Unknown tool: ${name}`, 'Use a tool name from the supplied tools list.');
    return validateToolArguments(definition, args);
  }
  async function execute(name, args = {}, context = {}) {
    validate(name, args);
    context.signal?.throwIfAborted();
    return get(name).execute(args, context);
  }
  async function preview(name, args = {}) {
    validate(name, args);
    return get(name).preview?.(args) ?? null;
  }
  return { sandbox, get, validate, execute, preview, definitions: toolDefinitions };
}

export function summarizeToolCall(name, args = {}) {
  if (editingToolDefinitions.some((tool) => tool.function.name === name)) return summarizeEditingCall(name, args);
  if (name === 'run_command') return { title: `Run ${args.executable || 'command'}`, detail: [args.executable, ...(Array.isArray(args.args) ? args.args : [])].join(' '), risk: 'execute' };
  if (name === 'web_search') return { title: 'Search the web', detail: args.query || '', risk: 'read' };
  if (name === 'fetch_url') return { title: 'Fetch webpage', detail: args.url || '', risk: 'read' };
  if (name === 'create_goal') return { title: 'Create goal', detail: args.title || '', risk: 'local' };
  if (name === 'update_goal') return { title: 'Update goal', detail: args.goal_id || '', risk: 'local' };
  if (name === 'delete_goal') return { title: 'Delete goal', detail: args.goal_id || '', risk: 'local' };
  if (name === 'list_goals') return { title: 'List goals', detail: '', risk: 'read' };
  if (name === 'search_text') return { title: `Search ${args.path || '.'}`, detail: args.query || '', risk: 'read' };
  return { title: name, detail: args.path || args.query || '', risk: 'read' };
}
