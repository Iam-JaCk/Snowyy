import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveUpdateConfig } from './lib/update-config.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(projectRoot, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
export const updateConfig = resolveUpdateConfig(JSON.parse(await readFile(new URL('./update-config.json', import.meta.url), 'utf8')));
const [owner, name] = updateConfig.repository.split('/');

export default {
  packagerConfig: {
    asar: true,
    name: 'Snowyy',
    executableName: 'Snowyy',
    ignore: [
      /^\/\.env$/,
      /^\/\.Snowyy(?:\/|$)/,
      /^\/test(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/\.git(?:\/|$)/,
      /^\/\.github(?:\/|$)/,
      /^\/releases(?:\/|$)/,
      /^\/snowyy_implementations\.md$/
    ]
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      // Persist build-time overrides; installed users do not need environment variables.
      await writeFile(path.join(buildPath, 'update-config.json'), `${JSON.stringify(updateConfig, null, 2)}\n`);
    }
  },
  publishers: owner && name ? [{
    name: '@electron-forge/publisher-github',
    config: {
      repository: { owner, name },
      draft: process.env.SNOWYY_GITHUB_DRAFT !== '0',
      prerelease: false
    }
  }] : [],
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'snowyy',
        setupExe: 'Snowyy-Setup.exe',
        shortcutName: 'Snowyy',
        noMsi: true
      }
    }
  ]
};
