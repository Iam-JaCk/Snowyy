import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

try {
  const { updateConfig } = await import('../forge.config.mjs');
  if (!updateConfig.repository) throw new Error('Set repository in update-config.json or SNOWYY_UPDATE_REPOSITORY before publishing to GitHub.');
  if (updateConfig.url) throw new Error('Clear the custom update URL before publishing to GitHub so installed copies use GitHub Releases.');
  if (!process.env.GITHUB_TOKEN?.trim()) throw new Error('Set GITHUB_TOKEN in your publishing environment. Installed users do not need a token.');
  const require = createRequire(import.meta.url);
  const child = spawn(process.execPath, [require.resolve('@electron-forge/cli/dist/electron-forge.js'), 'publish', '--platform=win32', '--arch=x64'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', windowsHide: true
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error(`GitHub publishing failed: ${error.message}`);
  process.exitCode = 1;
}
