import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import electron from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { getUpdateFeedUrl, resolveUpdateConfig } from '../lib/update-config.mjs';
import { createDesktopUpdater } from './updater.mjs';

const { app, BrowserWindow, autoUpdater, dialog, shell } = electron;

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));
let mainWindow = null;
let snowyyServer = null;
const smokeTest = process.env.SNOWYY_SMOKE_TEST === '1' || process.argv.includes('--smoke-test');
let desktopUpdater = null;

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    show: false,
    title: 'Snowyy',
    backgroundColor: '#0b0d0c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const allowedOrigin = new URL(url).origin;
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin !== allowedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  if (!smokeTest) window.once('ready-to-show', () => window.show());
  if (smokeTest) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await window.webContents.executeJavaScript(`({
            hasComposer: Boolean(document.querySelector('#composerForm')),
            hasGoals: Boolean(document.querySelector('#goalPanel')),
            obsoleteToolLimit: Boolean(document.querySelector('#maxToolRoundsInput')),
            hasSession: typeof activeSessionId === 'string' && activeSessionId.length > 0,
            rendererReady: typeof renderGoals === 'function' && typeof controlCommand === 'function'
          })`);
          if (!result.hasComposer || !result.hasGoals || result.obsoleteToolLimit || !result.hasSession || !result.rendererReady) {
            throw new Error(`Renderer smoke check failed: ${JSON.stringify(result)}`);
          }
          console.log(`Snowyy renderer smoke check passed: ${JSON.stringify(result)}`);
          app.quit();
        } catch (error) {
          console.error(error);
          app.exit(1);
        }
      }, 600);
    });
  }
  window.on('closed', () => { mainWindow = null; });
  window.loadURL(url);
  return window;
}

function isSquirrelInstallation() {
  if (!app.isPackaged || process.platform !== 'win32') return false;
  const updateExecutable = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  return existsSync(updateExecutable);
}

async function configureAutoUpdates() {
  let feedUrl = null;
  try {
    const savedConfig = JSON.parse(await readFile(new URL('../update-config.json', import.meta.url), 'utf8'));
    feedUrl = getUpdateFeedUrl(resolveUpdateConfig(savedConfig), { version: app.getVersion() });
  } catch (error) {
    console.warn(`Snowyy update configuration: ${error.message}`);
  }
  const installed = isSquirrelInstallation();
  if (installed) app.setAppUserModelId('com.squirrel.snowyy.Snowyy');
  desktopUpdater = createDesktopUpdater({
    autoUpdater,
    feedUrl,
    enabled: !smokeTest && installed,
    firstDelay: process.argv.includes('--squirrel-firstrun') ? 10_000 : 3_000,
    onDownloaded: async ({ releaseName }) => {
      const options = {
        type: 'info',
        title: 'Snowyy update ready',
        message: `Snowyy ${releaseName || 'update'} has been downloaded.`,
        detail: 'Restart Snowyy now to install it. Your sessions and workspace settings will be preserved.',
        buttons: ['Restart and update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      };
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 0) return;
      if (snowyyServer?.listening) {
        let restarted = false;
        const restart = () => {
          if (restarted) return;
          restarted = true;
          clearTimeout(fallback);
          desktopUpdater.quitAndInstall();
        };
        const fallback = setTimeout(() => {
          snowyyServer?.closeAllConnections?.();
          restart();
        }, 1_500).unref();
        snowyyServer.close(restart);
      } else {
        desktopUpdater.quitAndInstall();
      }
    }
  });
  desktopUpdater.start();
}

async function launchSnowyy() {
  if (!app.isPackaged) {
    try { process.loadEnvFile(path.join(projectDirectory, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await configureAutoUpdates();
  process.env.PORT = '0';
  process.env.SESSION_STORE_PATH = path.join(app.getPath('userData'), '.Snowyy', 'sessions.json');
  process.env.SNOWYY_APP_VERSION = app.getVersion();
  process.env.SNOWYY_RUNTIME_CHANNEL = app.isPackaged ? (isSquirrelInstallation() ? 'installed' : 'portable') : 'development';
  process.env.SNOWYY_UPDATES_ENABLED = desktopUpdater.getStatus().enabled ? '1' : '0';
  if (!process.env.WORKSPACE_ROOT) {
    process.env.WORKSPACE_ROOT = app.isPackaged ? app.getPath('documents') : projectDirectory;
  }

  const { startSnowyyServer } = await import('../server.mjs');
  const started = await startSnowyyServer({
    port: 0,
    getUpdateStatus: desktopUpdater.getStatus,
    pickFolder: async () => {
      const options = {
        title: 'Open a Snowyy workspace',
        properties: ['openDirectory', 'createDirectory']
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0];
    }
  });
  snowyyServer = started.server;
  mainWindow = createWindow(started.url);
}

const hasInstanceLock = !squirrelStartup && app.requestSingleInstanceLock();
if (squirrelStartup || !hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(launchSnowyy).catch((error) => {
    dialog.showErrorBox('Snowyy could not start', error.message);
    app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow && snowyyServer?.listening) {
      const address = snowyyServer.address();
      if (typeof address === 'object' && address) mainWindow = createWindow(`http://127.0.0.1:${address.port}`);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    desktopUpdater?.dispose();
    if (snowyyServer?.listening) snowyyServer.close();
  });
}
