import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { parseReleases, stageUpdate } from '../lib/update-release.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snowyy-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, 'artifacts');
  const feedRoot = path.join(root, 'feed');
  await mkdir(artifactRoot);
  await mkdir(feedRoot);
  const name = 'snowyy-1.2.3-full.nupkg';
  const payload = Buffer.from('test release payload');
  const sha1 = createHash('sha1').update(payload).digest('hex');
  const manifest = `${sha1} ${name} ${payload.length}\r\n`;
  await writeFile(path.join(artifactRoot, name), payload);
  await writeFile(path.join(artifactRoot, 'RELEASES'), manifest);
  await writeFile(path.join(artifactRoot, 'Snowyy-Setup.exe'), 'installer');
  return { artifactRoot, feedRoot, version: '1.2.3', name, payload, manifest };
}

test('staging validates and copies every manifest package without a running web server', async (t) => {
  const data = await fixture(t);
  await stageUpdate(data);
  assert.equal(await readFile(path.join(data.feedRoot, 'RELEASES'), 'utf8'), data.manifest);
  assert.deepEqual(await readFile(path.join(data.feedRoot, data.name)), data.payload);
  assert.equal(await readFile(path.join(data.feedRoot, 'Snowyy-Setup.exe'), 'utf8'), 'installer');
  await stageUpdate(data);
  assert.equal((await readdir(data.feedRoot)).some((file) => file.endsWith('.tmp')), false);
});

test('a corrupt package leaves the previously published manifest untouched', async (t) => {
  const data = await fixture(t);
  await writeFile(path.join(data.feedRoot, 'RELEASES'), 'previous release');
  await writeFile(path.join(data.artifactRoot, data.name), Buffer.alloc(data.payload.length));
  await assert.rejects(stageUpdate(data), /hash mismatch/);
  assert.equal(await readFile(path.join(data.feedRoot, 'RELEASES'), 'utf8'), 'previous release');
});

test('missing referenced delta packages and mismatched versions cannot be published', async (t) => {
  const data = await fixture(t);
  await assert.rejects(stageUpdate({ ...data, version: '1.2.4' }), /does not reference/);
  await writeFile(path.join(data.artifactRoot, 'RELEASES'), data.manifest + data.manifest.replace('-full', '-delta'));
  await assert.rejects(stageUpdate(data), /ENOENT/);
  assert.deepEqual(await readdir(data.feedRoot), []);
});

test('published versions cannot be silently replaced with different bytes', async (t) => {
  const data = await fixture(t);
  await writeFile(path.join(data.feedRoot, data.name), 'previous content');
  await assert.rejects(stageUpdate(data), /Bump the version/);
  assert.equal(await readFile(path.join(data.feedRoot, data.name), 'utf8'), 'previous content');
});

test('manifest parser rejects traversal, URLs for staging, duplicates and invalid sizes', () => {
  const hash = 'a'.repeat(40);
  for (const name of ['../outside.nupkg', '..\\outside.nupkg', '/outside.nupkg', 'C:\\outside.nupkg', 'https://example.com/pkg.nupkg']) {
    assert.throws(() => parseReleases(`${hash} ${name} 10`), /safe/);
  }
  for (const manifest of ['', 'html', `${hash} test.nupkg 0`, `${hash} test.nupkg 10\n${hash} TEST.nupkg 10`]) {
    assert.throws(() => parseReleases(manifest));
  }
  assert.equal(parseReleases(`${hash} https://github.com/a/b/releases/download/v1/pkg.nupkg 10`, { allowUrls: true }).length, 1);
});
