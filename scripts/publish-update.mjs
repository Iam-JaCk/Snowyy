import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveUpdateConfig } from '../lib/update-config.mjs';
import { stageUpdate } from '../lib/update-release.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

try {
  try { process.loadEnvFile(path.join(projectRoot, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const config = resolveUpdateConfig(JSON.parse(await readFile(path.join(projectRoot, 'update-config.json'), 'utf8')));
  const artifactRoot = path.join(projectRoot, 'out', 'make', 'squirrel.windows', 'x64');
  const feedRoot = path.resolve(process.env.SNOWYY_UPDATE_PUBLISH_DIR || path.join(projectRoot, 'releases', 'win32', 'x64'));
  const { releasesBytes } = await stageUpdate({ artifactRoot, feedRoot, version: packageJson.version });
  console.log(`Staged Snowyy ${packageJson.version} update artifacts in ${feedRoot}`);

  // Staging files does not require a running web server.
  if (process.argv.includes('--verify')) {
    if (!config.url) throw new Error('Set a custom update URL before using --verify.');
    const response = await fetch(`${config.url}/RELEASES`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Feed verification returned HTTP ${response.status}.`);
    if (!Buffer.from(await response.arrayBuffer()).equals(releasesBytes)) throw new Error('Served RELEASES does not match the staged manifest.');
    console.log('Verified the hosted update manifest.');
  }
} catch (error) {
  console.error(`Update staging failed: ${error.message}`);
  process.exitCode = 1;
}
