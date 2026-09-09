import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUpdateFeedUrl, resolveUpdateConfig } from '../lib/update-config.mjs';
import { parseReleases } from '../lib/update-release.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function checkForUpdates() {
  const [metadata, savedConfig] = await Promise.all([
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'update-config.json'), 'utf8').then(JSON.parse)
  ]);
  const feedUrl = getUpdateFeedUrl(resolveUpdateConfig(savedConfig), { version: metadata.version, platform: 'win32', arch: 'x64' });
  if (!feedUrl) throw new Error('Configure repository or url in update-config.json before checking for updates.');
  const response = await fetch(`${feedUrl}/RELEASES`, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 204) return { current: metadata.version, packages: [] };
  if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}.`);
  const releases = parseReleases(await response.text(), { allowUrls: true });
  // This is a feed diagnostic. Squirrel compares versions and installs updates.
  return { current: metadata.version, packages: releases.map(({ name }) => name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    try { process.loadEnvFile(path.join(projectRoot, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(JSON.stringify(await checkForUpdates(), null, 2));
  } catch (error) {
    console.error(`Update check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
