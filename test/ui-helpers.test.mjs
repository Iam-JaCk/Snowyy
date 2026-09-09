import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function uiHelpers() {
  const source = await readFile(new URL('../ui-helpers.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  return sandbox.SnowyyUiHelpers;
}

test('UI path helpers tolerate cleared and missing preview paths', async () => {
  const helpers = await uiHelpers();
  assert.equal(helpers.fileLanguage(null), 'Plain Text');
  assert.equal(helpers.fileIconLabel(null, false), 'FILE');
  assert.equal(helpers.workspaceLabel(null), '');
  assert.deepEqual({ ...helpers.mentionPathParts(null) }, { name: '', parent: 'workspace root' });
});

test('UI path helpers format workspace and file labels', async () => {
  const helpers = await uiHelpers();
  assert.equal(helpers.workspaceLabel('C:\\projects\\Snowyy'), 'Snowyy');
  assert.equal(helpers.fileLanguage('src/app.js'), 'JavaScript');
  assert.equal(helpers.fileIconLabel('README.md', false), 'MD');
  assert.deepEqual({ ...helpers.mentionPathParts('src/components/editor.js') }, { name: 'editor.js', parent: 'src/components' });
});
