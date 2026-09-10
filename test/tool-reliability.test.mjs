import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createToolRegistry } from '../lib/tools.mjs';
import { textHash } from '../lib/workspace-text.mjs';
import { systemPrompt } from '../lib/agent-instructions.mjs';
import { normalizeToolArguments } from '../lib/tool-arguments.mjs';

async function fixture(t, content = 'one\ntwo\nthree\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snowyy-tool-reliability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'note.txt'), content);
  return { root, registry: createToolRegistry(root), content, hash: textHash(content) };
}

test('schemas reject malformed and misspelled arguments before any edit', async (t) => {
  const { root, registry, content, hash } = await fixture(t);
  for (const [name, args] of [
    ['insert_text', { path: 'note.txt', line: 2, expected_sha256: hash }],
    ['replace_lines', { path: 'note.txt', start_line: 1, end_line: 1, new_text: null, expected_sha256: hash }],
    ['write_file', { path: 'note.txt', content: 'oops', expected_sha256: hash, append: true }],
    ['apply_changes', { changes: [{ path: 'note.txt', content: 123, expected_sha256: hash }] }],
    ['read_file', { path: 'note.txt', start_line: '2' }],
    ['read_file', { path: 'note.txt', start_line: 1.5 }],
    ['find_files', { query: '', limit: 0 }],
    ['run_command', { executable: 'node', args: Array(41).fill('arg') }],
    ['read_file', []]
  ]) {
    await assert.rejects(registry.execute(name, args), (error) => error.code === 'INVALID_ARGUMENTS');
  }
  await assert.rejects(registry.execute('toString', {}), (error) => error.code === 'UNKNOWN_TOOL');
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), content);
});

test('existing files distinguish missing, invalid and stale edit hashes', async (t) => {
  const { registry, hash } = await fixture(t);
  await assert.rejects(
    registry.execute('write_file', { path: 'note.txt', content: 'replacement', expected_sha256: '' }),
    (error) => error.code === 'EXPECTED_HASH_REQUIRED'
  );
  await assert.rejects(
    registry.execute('write_file', { path: 'note.txt', content: 'replacement', expected_sha256: 'sha256:made-up' }),
    (error) => error.code === 'INVALID_FILE_HASH'
  );
  await assert.rejects(
    registry.execute('write_file', { path: 'note.txt', content: 'replacement', expected_sha256: 'a'.repeat(64) }),
    (error) => error.code === 'FILE_CHANGED'
  );
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('reads support larger files with honest pagination, raw content and full-file hashes', async (t) => {
  const content = ('x'.repeat(100) + '\r\n').repeat(4000);
  const { registry, hash } = await fixture(t, content);
  const first = await registry.execute('read_file', { path: 'note.txt' });
  assert.equal(first.total_lines, 4000);
  assert.equal(first.end_line, 400);
  assert.equal(first.next_start_line, 401);
  assert.equal(first.truncated, true);
  assert.equal(first.sha256, hash);
  assert.equal(first.content, ('x'.repeat(100) + '\r\n').repeat(400));
  const last = await registry.execute('read_file', { path: 'note.txt', start_line: 3999, end_line: 5000 });
  assert.equal(last.end_line, 4000);
  assert.equal(last.next_start_line, null);
  for (const range of [{ start_line: 4001 }, { start_line: 20, end_line: 10 }]) {
    await assert.rejects(registry.execute('read_file', { path: 'note.txt', ...range }), (error) => error.code === 'INVALID_LINE_RANGE');
  }
});

test('find_files supports familiar globs and pagination; list_directory exposes the next page', async (t) => {
  const { root, registry } = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'a.mjs'), '');
  await writeFile(path.join(root, 'src', 'b.mjs'), '');
  await writeFile(path.join(root, 'node_modules', 'ignored.mjs'), '');
  const first = await registry.execute('find_files', { query: '**/*.mjs', limit: 1 });
  assert.deepEqual(first.files, ['a.mjs']);
  assert.equal(first.next_offset, 1);
  const next = await registry.execute('find_files', { query: '**/*.mjs', limit: 1, offset: first.next_offset });
  assert.deepEqual(next.files, ['src/b.mjs']);
  assert.equal(next.truncated, false);
  assert.equal((await registry.execute('find_files', { query: '*.mjs' })).files.length, 2);
  const listing = await registry.execute('list_directory', { limit: 1 });
  assert.equal(listing.next_offset, 1);
  assert.equal((await registry.execute('list_directory', { limit: 1, offset: 1 })).entries[0].name, 'a.mjs');
});

test('search_text finds literal code, returns line locations and reports skipped binary files', async (t) => {
  const { root, registry } = await fixture(t, 'alpha\nLiteral .* [x] token\nTOKEN again\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 255, 1]));
  const literal = await registry.execute('search_text', { query: '.* [x]' });
  assert.equal(literal.matches.length, 1);
  assert.equal(literal.matches[0].path, 'note.txt');
  assert.equal(literal.matches[0].line, 2);
  assert.equal(literal.matches[0].column, 9);
  assert.equal(literal.skipped_files, 1);
  assert.equal(literal.skipped_paths[0].code, 'BINARY_FILE');
  assert.equal((await registry.execute('search_text', { query: 'token', case_sensitive: true, path: 'note.txt' })).matches.length, 1);
  const limited = await registry.execute('search_text', { query: 'token', limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  await assert.rejects(registry.execute('search_text', { query: 'x', path: '../' }), (error) => error.code === 'SANDBOX_VIOLATION');
});

test('apply_patch inserts dollar sequences literally and rejects overlapping matches', async (t) => {
  const { root, registry } = await fixture(t, 'marker\n');
  const replacement = "literal $& $$ $' $` ${value}";
  await registry.execute('apply_patch', { path: 'note.txt', old_text: 'marker', new_text: replacement });
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), replacement + '\n');
  await writeFile(path.join(root, 'note.txt'), 'aaaa');
  await assert.rejects(registry.execute('apply_patch', { path: 'note.txt', old_text: 'aaa', new_text: 'b' }), (error) => error.code === 'PATCH_AMBIGUOUS' && /more surrounding/.test(error.suggestion));
});

test('line edits accept trailing newlines without adding blank lines and empty replacement deletes', async (t) => {
  const { root, registry, hash } = await fixture(t, 'one\r\ntwo\r\nthree\r\n');
  await registry.execute('insert_text', { path: 'note.txt', line: 2, text: 'inserted\n', expected_sha256: hash });
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'one\r\ninserted\r\ntwo\r\nthree\r\n');
  const current = await registry.execute('read_file', { path: 'note.txt' });
  await registry.execute('replace_lines', { path: 'note.txt', start_line: 2, end_line: 3, new_text: 'replacement\n', expected_sha256: current.sha256 });
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'one\r\nreplacement\r\nthree\r\n');
  const changed = await registry.execute('read_file', { path: 'note.txt' });
  await registry.execute('replace_lines', { path: 'note.txt', start_line: 1, end_line: 3, new_text: '', expected_sha256: changed.sha256 });
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), '');
});

test('concurrent edits with the same original hash cannot silently overwrite each other', async (t) => {
  const { root, registry, hash } = await fixture(t);
  const second = createToolRegistry(root);
  const outcomes = await Promise.allSettled([
    registry.execute('write_file', { path: 'note.txt', content: 'first', expected_sha256: hash }),
    second.execute('write_file', { path: 'note.txt', content: 'second', expected_sha256: hash })
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((result) => result.status === 'rejected').reason.code, 'FILE_CHANGED');
});

test('a mid-transaction write failure restores earlier writes', async (t) => {
  const { root, registry } = await fixture(t);
  await assert.rejects(registry.execute('apply_changes', { changes: [
    { path: 'created', content: 'this is a file', expected_sha256: '' },
    { path: 'created/child.txt', content: 'cannot be created under a file', expected_sha256: '' }
  ] }));
  await assert.rejects(access(path.join(root, 'created')), (error) => error.code === 'ENOENT');
});

test('approval previews refuse patches after an unrelated part of the file changes', async (t) => {
  const { root, registry } = await fixture(t);
  const args = { path: 'note.txt', old_text: 'two', new_text: 'TWO' };
  const approvedPreview = await registry.preview('apply_patch', args);
  await writeFile(path.join(root, 'note.txt'), 'one\ntwo\nchanged elsewhere\n');
  await assert.rejects(registry.execute('apply_patch', args, { approvedPreview }), (error) => error.code === 'FILE_CHANGED');
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'one\ntwo\nchanged elsewhere\n');
});

test('command failures remain failures and preserve the end of long error output', async (t) => {
  const { registry } = await fixture(t);
  const result = await registry.execute('run_command', { executable: 'node', args: ['-e', 'process.stderr.write("x".repeat(40000) + "FINAL ERROR"); process.exitCode = 7;'] });
  assert.equal(result.ok, false);
  assert.equal(result.exit_code, 7);
  assert.equal(result.code, 'COMMAND_FAILED');
  assert.equal(result.truncated, true);
  assert.ok(result.stderr.endsWith('FINAL ERROR'));
  assert.ok(result.stderr.length < 31_000);
});

test('npm and npx run through their Node entry points without a shell', async (t) => {
  const { registry } = await fixture(t);
  for (const executable of ['npm', 'npx']) {
    const result = await registry.execute('run_command', { executable, args: ['--version'] });
    assert.equal(result.ok, true, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  }
});

test('an already cancelled command cannot create a side-effect file', async (t) => {
  const { root, registry } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(registry.execute('run_command', { executable: 'node', args: ['-e', 'require("fs").writeFileSync("unexpected", "oops")'] }, { signal: controller.signal }), (error) => error.name === 'AbortError');
  await assert.rejects(access(path.join(root, 'unexpected')), (error) => error.code === 'ENOENT');
});

test('tool instructions include project guidance and an accurate read-only planning policy', () => {
  const prompt = systemPrompt('C:/private/workspace', { planningOnly: true }, 'Use the existing test runner.');
  assert.match(prompt, /Planning mode/);
  assert.match(prompt, /Use the existing test runner/);
  assert.match(prompt, /as many tool calls as the work requires/);
  assert.match(prompt, /search_text/);
  assert.doesNotMatch(prompt, /C:\/private/);
});

test('nested edits and command directories use the same path normalization without replacing existing hashes', async (t) => {
  const { root, registry, hash } = await fixture(t);
  const state = { registry, workspaceRoot: root };
  const normalized = await normalizeToolArguments(state, 'apply_changes', { changes: [
    { path: '@note.txt', content: 'changed', expected_sha256: hash },
    { path: `${path.basename(root)}/new.txt`, content: 'new', expected_sha256: 'invented' }
  ] });
  assert.equal(normalized.args.changes[0].path, 'note.txt');
  assert.equal(normalized.args.changes[0].expected_sha256, hash);
  assert.equal(normalized.args.changes[1].path, 'new.txt');
  assert.equal(normalized.args.changes[1].expected_sha256, '');
  await writeFile(path.join(root, '@literal.txt'), 'literal');
  assert.equal((await normalizeToolArguments(state, 'read_file', { path: '@literal.txt' })).args.path, '@literal.txt');
  assert.equal((await normalizeToolArguments(state, 'run_command', { executable: 'node', cwd: root })).args.cwd, '.');
});

test('normalization reuses only a covering read hash that no later mutation invalidated', async (t) => {
  const { root, registry, content, hash } = await fixture(t);
  const fullRead = await registry.execute('read_file', { path: 'note.txt' });
  const state = {
    registry,
    workspaceRoot: root,
    timeline: [{ type: 'tool', name: 'read_file', ok: true, args: { path: 'note.txt' }, result: fullRead }]
  };
  const whole = await normalizeToolArguments(state, 'write_file', { path: 'note.txt', content: content.toUpperCase(), expected_sha256: '' });
  assert.equal(whole.args.expected_sha256, hash);
  assert.match(whole.adjustments.join(' '), /latest unchanged read_file SHA-256/);
  const lineEdit = await normalizeToolArguments(state, 'delete_lines', { path: 'note.txt', start_line: 2, end_line: 2, expected_sha256: 'stale' });
  assert.equal(lineEdit.args.expected_sha256, hash);
  const read = await normalizeToolArguments(state, 'read_file', { path: 'note.txt', expected_sha256: hash });
  assert.equal('expected_sha256' in read.args, false);
  assert.match(read.adjustments.join(' '), /read-only/);

  state.timeline.push({ type: 'tool', name: 'write_file', ok: true, args: { path: 'note.txt' }, result: { files: [{ path: 'note.txt', sha256: 'new' }] } });
  const invalidated = await normalizeToolArguments(state, 'write_file', { path: 'note.txt', content: 'later', expected_sha256: '' });
  assert.equal(invalidated.args.expected_sha256, '');
});

test('normalization repairs common command and mixed editing argument shapes', async (t) => {
  const { root, registry, hash } = await fixture(t);
  const state = { registry, workspaceRoot: root, timeline: [] };
  const command = await normalizeToolArguments(state, 'run_command', {
    args: JSON.stringify(['tsc', '--noEmit']), cwd: 'note.txt', timeout_ms: '30000'
  });
  assert.equal(command.args.executable, 'npx');
  assert.deepEqual(command.args.args, ['tsc', '--noEmit']);
  assert.equal(command.args.cwd, '.');
  assert.equal(command.args.timeout_ms, 30_000);
  assert.match(command.adjustments.join(' '), /parent directory/);

  const lines = await normalizeToolArguments(state, 'replace_lines', {
    path: 'note.txt', start_line: '1', end_line: '1', new_text: 'ONE', old_text: 'one', expected_sha256: hash
  });
  assert.equal(lines.args.start_line, 1);
  assert.equal(lines.args.end_line, 1);
  assert.equal('old_text' in lines.args, false);
  assert.match(lines.adjustments.join(' '), /different editing tool/);
});

test('an identical whole-file write reports a no-op without creating a transaction', async (t) => {
  const { registry, content, hash } = await fixture(t);
  const result = await registry.execute('write_file', { path: 'note.txt', content, expected_sha256: hash });
  assert.equal(result.unchanged, true);
  assert.equal(result.files[0].sha256, hash);
  assert.equal('transaction_id' in result, false);
  assert.match(result.message, /Do not repeat/);
});
