import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { getUpdateFeedUrl } from '../lib/update-config.mjs';

const execute = promisify(execFile);

test('packaging embeds build-time update source without leaking publishing credentials', async (t) => {
  const buildPath = await mkdtemp(path.join(os.tmpdir(), 'snowyy-update-build-'));
  t.after(() => rm(buildPath, { recursive: true, force: true }));
  const configUrl = new URL('../forge.config.mjs', import.meta.url).href;
  await execute(process.execPath, ['--input-type=module', '-e', `
    const { default: config } = await import(${JSON.stringify(configUrl)});
    await config.hooks.packageAfterCopy(config, process.env.SNOWYY_TEST_BUILD_PATH);
    const publisher = config.publishers[0];
    if (!publisher.config.draft || publisher.config.repository.owner !== 'release-owner') throw new Error('Invalid publisher');
  `], {
    windowsHide: true,
    env: { ...process.env, SNOWYY_UPDATE_REPOSITORY: 'release-owner/snowyy', SNOWYY_UPDATE_URL: 'https://updates.example.com/win32/x64', SNOWYY_TEST_BUILD_PATH: buildPath, GITHUB_TOKEN: 'test-publishing-secret' }
  });
  const content = await readFile(path.join(buildPath, 'update-config.json'), 'utf8');
  const saved = JSON.parse(content);
  assert.deepEqual(saved, { repository: 'release-owner/snowyy', url: 'https://updates.example.com/win32/x64' });
  assert.equal(content.includes('test-publishing-secret'), false);
  assert.equal(getUpdateFeedUrl(saved, { version: '1.2.3', platform: 'win32', arch: 'x64' }),
    'https://updates.example.com/win32/x64');
});

test('tag release workflow uses a scoped ephemeral token and pinned actions', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /permissions:\s*\n\s+contents: write/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /SNOWYY_GITHUB_DRAFT: '0'/);
  assert.doesNotMatch(workflow, /secrets\.[A-Za-z0-9_]+/);

  const actionRefs = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionRefs.length > 0);
  for (const ref of actionRefs) assert.match(ref, /^[0-9a-f]{40}$/);
});

test('publisher can make a public release only when explicitly requested', async () => {
  const configUrl = new URL('../forge.config.mjs', import.meta.url).href;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `
    const { default: config } = await import(${JSON.stringify(configUrl)});
    process.stdout.write(String(config.publishers[0].config.draft));
  `], {
    windowsHide: true,
    env: { ...process.env, SNOWYY_UPDATE_REPOSITORY: 'release-owner/snowyy', SNOWYY_GITHUB_DRAFT: '0' }
  });
  assert.equal(stdout, 'false');
});
