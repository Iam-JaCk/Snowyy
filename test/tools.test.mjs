import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createToolRegistry } from '../lib/tools.mjs';

async function temporaryWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), 'snowyy-tools-'));
}

test('read tools inspect only the configured workspace', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, 'src'));
  const source = 'one\ntwo\nthree\n';
  await writeFile(path.join(workspace, 'src', 'app.js'), source, 'utf8');
  const registry = createToolRegistry(workspace);

  const listing = await registry.execute('list_directory', { path: '.' });
  assert.equal(listing.entries[0].name, 'src');
  assert.equal(listing.entries[0].type, 'directory');

  const found = await registry.execute('find_files', { query: 'app', path: '.' });
  assert.deepEqual(found.files, ['src/app.js']);

  const allFiles = await registry.execute('find_files', { query: '', path: '.' });
  assert.deepEqual(allFiles.files, ['src/app.js']);

  const read = await registry.execute('read_file', { path: 'src/app.js', start_line: 2, end_line: 3 });
  assert.equal(read.content, 'two\nthree\n');
  assert.equal(read.sha256, createHash('sha256').update(source).digest('hex'));
});

test('Windows workspace aliases and path casing resolve inside the same sandbox', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows path comparison only.');
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, 'note.txt'), 'visible\n');
  const registry = createToolRegistry(workspace.toUpperCase());
  const read = await registry.execute('read_file', { path: 'note.txt' });
  assert.equal(read.content, 'visible\n');
});

test('path traversal is rejected', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = createToolRegistry(workspace);

  await assert.rejects(
    registry.execute('read_file', { path: '../outside.txt' }),
    (error) => error.code === 'SANDBOX_VIOLATION'
  );
  await assert.rejects(
    registry.execute('apply_patch', { path: '../outside.txt', old_text: '', new_text: 'nope' }),
    (error) => error.code === 'SANDBOX_VIOLATION'
  );
});

test('new writes cannot escape through a symlinked parent', async (t) => {
  const workspace = await temporaryWorkspace();
  const outside = await temporaryWorkspace();
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  try {
    await symlink(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Creating symlinks is not permitted on this machine.');
    throw error;
  }
  const registry = createToolRegistry(workspace);
  await assert.rejects(
    registry.execute('apply_patch', { path: 'linked/escape.txt', old_text: '', new_text: 'nope' }),
    (error) => error.code === 'SANDBOX_VIOLATION'
  );
});

test('approved tools edit exact text and run argument-only commands', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, 'note.txt'), 'hello world\n', 'utf8');
  const registry = createToolRegistry(workspace);

  assert.equal(registry.get('apply_patch').approval, true);
  assert.equal(registry.get('write_file').approval, true);
  assert.equal(registry.get('run_command').approval, true);
  const edit = await registry.execute('apply_patch', { path: 'note.txt', old_text: 'world', new_text: 'Snowyy' });
  assert.equal(edit.files[0].created, false);
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'hello Snowyy\n');

  const command = await registry.execute('run_command', { executable: 'node', args: ['-e', 'console.log("tool-ok")'] });
  assert.equal(command.exit_code, 0);
  assert.equal(command.stdout.trim(), 'tool-ok');
});

test('patches tolerate newline style differences and require explicit new_text', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, 'windows.txt');
  await writeFile(file, 'first\r\nsecond\r\nthird\r\n', 'utf8');
  const registry = createToolRegistry(workspace);

  const result = await registry.execute('apply_patch', {
    path: 'windows.txt',
    old_text: 'second\nthird',
    new_text: 'changed\nfinal'
  });
  assert.equal(await readFile(file, 'utf8'), 'first\r\nchanged\r\nfinal\r\n');
  await assert.rejects(
    registry.execute('apply_patch', { path: 'windows.txt', old_text: 'changed' }),
    /new_text is required/
  );
});

test('write_file uses read hashes to prevent stale whole-file overwrites', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, 'whole.txt');
  await writeFile(file, 'before\n', 'utf8');
  const registry = createToolRegistry(workspace);
  const initial = await registry.execute('read_file', { path: 'whole.txt' });

  const result = await registry.execute('write_file', {
    path: 'whole.txt',
    content: 'after\n',
    expected_sha256: initial.sha256
  });
  assert.equal(await readFile(file, 'utf8'), 'after\n');
  assert.equal(result.files[0].previous_sha256, initial.sha256);
  await assert.rejects(
    registry.execute('write_file', { path: 'whole.txt', content: 'stale\n', expected_sha256: initial.sha256 }),
    /File changed since it was read/
  );
});

test('line tools preview changes and transactions roll back atomically', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(path.join(workspace, 'b.txt'), 'alpha\n', 'utf8');
  const registry = createToolRegistry(workspace);
  const a = await registry.execute('read_file', { path: 'a.txt' });
  const preview = await registry.preview('replace_lines', { path: 'a.txt', start_line: 2, end_line: 2, new_text: 'TWO', expected_sha256: a.sha256 });
  assert.match(preview.files[0].diff, /-two/);
  assert.match(preview.files[0].diff, /\+TWO/);
  const lineEdit = await registry.execute('replace_lines', { path: 'a.txt', start_line: 2, end_line: 2, new_text: 'TWO', expected_sha256: a.sha256 });
  assert.equal(await readFile(path.join(workspace, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');

  const currentA = await registry.execute('read_file', { path: 'a.txt' });
  const b = await registry.execute('read_file', { path: 'b.txt' });
  const transaction = await registry.execute('apply_changes', { changes: [
    { path: 'a.txt', content: 'changed a\n', expected_sha256: currentA.sha256 },
    { path: 'b.txt', content: 'changed b\n', expected_sha256: b.sha256 }
  ] });
  assert.equal(transaction.files.length, 2);
  await registry.execute('rollback_change', { transaction_id: transaction.transaction_id });
  assert.equal(await readFile(path.join(workspace, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');
  assert.equal(await readFile(path.join(workspace, 'b.txt'), 'utf8'), 'alpha\n');
  assert.ok(lineEdit.transaction_id);
});

test('syntax validation restores an invalid JSON edit', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, 'data.json');
  await writeFile(file, '{"ok":true}\n', 'utf8');
  const registry = createToolRegistry(workspace);
  const read = await registry.execute('read_file', { path: 'data.json' });
  await assert.rejects(
    registry.execute('write_file', { path: 'data.json', content: '{invalid', expected_sha256: read.sha256 }),
    /Unexpected token|Expected property name/
  );
  assert.equal(await readFile(file, 'utf8'), '{"ok":true}\n');
});

test('unsupported syntax types are reported as unverified', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = createToolRegistry(workspace);
  const result = await registry.execute('write_file', { path: 'Program.cs', content: 'public class Program {}\n', expected_sha256: '' });
  assert.deepEqual(result.validation, [{ path: 'Program.cs', checked: false, status: 'unverified', ok: null }]);
});

test('run_command stops its child process when the request is cancelled', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = createToolRegistry(workspace);
  const controller = new AbortController();
  const started = Date.now();
  const pending = registry.execute('run_command', { executable: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], timeout_ms: 15000 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.timed_out, false);
});

test('a running command exposes a targeted stop control', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = createToolRegistry(workspace);
  let command;
  const pending = registry.execute('run_command', {
    executable: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], timeout_ms: 15000
  }, { onCommandStart: (value) => { command = value; } });
  for (let attempt = 0; attempt < 20 && !command; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(command?.pid);
  await command.control('stop');
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.code, 'COMMAND_STOPPED');
});

test('a running command can pause and resume without consuming its full timeout', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = createToolRegistry(workspace);
  let command;
  let output = '';
  const pending = registry.execute('run_command', {
    executable: 'node', args: ['-e', 'let n=0; setInterval(() => console.log(++n), 40)'], timeout_ms: 10000
  }, {
    onCommandStart: (value) => { command = value; },
    onCommandOutput: ({ chunk }) => { output += chunk; }
  });
  for (let attempt = 0; attempt < 40 && output.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(command?.pid);
  await command.control('pause');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const pausedOutput = output;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(output, pausedOutput);
  await command.control('resume');
  for (let attempt = 0; attempt < 30 && output === pausedOutput; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.notEqual(output, pausedOutput);
  await command.control('stop');
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.timed_out, false);
});
