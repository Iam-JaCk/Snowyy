import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopUpdater } from '../electron/updater.mjs';
import { getUpdateFeedUrl, resolveUpdateConfig } from '../lib/update-config.mjs';

function fixture(options = {}) {
  const native = new EventEmitter();
  const calls = { checks: 0, installs: 0, prompts: 0, cleared: [], warnings: [] };
  native.setFeedURL = ({ url }) => { calls.url = url; };
  native.checkForUpdates = () => { calls.checks += 1; };
  native.quitAndInstall = () => { calls.installs += 1; };
  const timers = {
    setTimeout: (callback, delay) => { calls.first = { callback, delay }; return calls.first; },
    setInterval: (callback, delay) => { calls.repeat = { callback, delay }; return calls.repeat; },
    clearTimeout: (timer) => calls.cleared.push(timer),
    clearInterval: (timer) => calls.cleared.push(timer)
  };
  const updater = createDesktopUpdater({
    autoUpdater: native, feedUrl: 'https://updates.example.com/win32/x64', enabled: true,
    onDownloaded: () => { calls.prompts += 1; }, logger: { warn: (message) => calls.warnings.push(message) },
    timers, ...options
  });
  return { native, updater, calls };
}

test('GitHub feed uses the installed version and architecture; custom HTTPS feed takes precedence', () => {
  const config = resolveUpdateConfig({ repository: 'snowyy-app/releases' }, {});
  assert.equal(getUpdateFeedUrl(config, { version: '0.6.12', platform: 'win32', arch: 'x64' }),
    'https://update.electronjs.org/snowyy-app/releases/win32-x64/0.6.12');
  const overridden = resolveUpdateConfig(config, { SNOWYY_UPDATE_URL: 'https://updates.example.com/feed///' });
  assert.equal(getUpdateFeedUrl(overridden, { version: '0.6.12' }), 'https://updates.example.com/feed');
  assert.equal(getUpdateFeedUrl({}, { version: '1.0.0' }), null);
  assert.equal(resolveUpdateConfig({ repository: 'a/b' }, { SNOWYY_UPDATE_REPOSITORY: 'c/d' }).repository, 'c/d');
  assert.equal(resolveUpdateConfig({ repository: 'a/b' }, { SNOWYY_UPDATE_REPOSITORY: '' }).repository, 'a/b');
});

test('feed config rejects credentials, unsafe transports and invalid repositories', () => {
  for (const url of ['file:///tmp/updates', 'http://updates.example.com', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com/#release', 'not a URL']) {
    assert.throws(() => resolveUpdateConfig({ url }, {}));
  }
  assert.throws(() => resolveUpdateConfig({ repository: 'https://github.com/a/b' }, {}));
  assert.equal(resolveUpdateConfig({ url: 'http://127.0.0.1:4174/feed' }, {}).url, 'http://127.0.0.1:4174/feed');
});

test('development, portable and unconfigured installs never contact an update server', () => {
  for (const options of [{ enabled: false }, { feedUrl: null }]) {
    const { updater, calls } = fixture(options);
    assert.equal(updater.start().status, 'disabled');
    updater.checkForUpdates();
    assert.equal(calls.checks, 0);
    assert.equal(calls.url, undefined);
    assert.equal(calls.first, undefined);
    assert.equal(updater.quitAndInstall(), false);
  }
});

test('checks run after first-launch delay and periodically, without overlapping downloads', () => {
  const { updater, calls, native } = fixture({ firstDelay: 10_000 });
  updater.start();
  updater.start();
  assert.equal(calls.first.delay, 10_000);
  assert.equal(calls.repeat.delay, 600_000);
  calls.first.callback();
  calls.repeat.callback();
  assert.equal(calls.checks, 1);
  assert.equal(updater.getStatus().status, 'checking');
  native.emit('update-available');
  calls.repeat.callback();
  assert.equal(calls.checks, 1);
  native.emit('update-not-available');
  assert.equal(updater.getStatus().status, 'up-to-date');
  calls.repeat.callback();
  assert.equal(calls.checks, 2);
  updater.dispose();
  assert.deepEqual(calls.cleared, [calls.first, calls.repeat]);
  assert.equal(native.listenerCount('update-downloaded'), 0);
  updater.checkForUpdates();
  assert.equal(calls.checks, 2);
});

test('offline checks recover on a later attempt, including native throws and rejected promises', async () => {
  const { updater, calls, native } = fixture();
  updater.start();
  native.checkForUpdates = () => { throw new Error('Offline'); };
  assert.equal(updater.checkForUpdates().error, 'Offline');
  native.checkForUpdates = () => Promise.reject(new Error('Connection refused'));
  updater.checkForUpdates();
  await new Promise(setImmediate);
  assert.equal(updater.getStatus().error, 'Connection refused');
  native.checkForUpdates = () => { calls.checks += 1; };
  updater.checkForUpdates();
  native.emit('error', new Error('Download failed'));
  assert.equal(updater.getStatus().status, 'error');
  updater.checkForUpdates();
  native.emit('update-not-available');
  assert.equal(updater.getStatus().error, null);
  assert.equal(calls.checks, 2);
});

test('Later retains a ready update, does not download or prompt twice, and installs only once', async () => {
  const { updater, native, calls } = fixture();
  updater.start();
  assert.equal(updater.quitAndInstall(), false);
  updater.checkForUpdates();
  native.emit('update-downloaded', {}, '', '0.6.12');
  native.emit('update-downloaded', {}, '', '0.6.12');
  await new Promise(setImmediate);
  assert.equal(updater.getStatus().releaseName, '0.6.12');
  assert.equal(updater.getStatus().status, 'ready');
  assert.equal(calls.prompts, 1);
  assert.equal(calls.installs, 0);
  calls.repeat.callback();
  assert.equal(calls.checks, 1);
  assert.equal(updater.quitAndInstall(), true);
  assert.equal(updater.quitAndInstall(), false);
  assert.equal(calls.installs, 1);
});

test('feed setup failure disables scheduling without crashing the app', () => {
  const { updater, native, calls } = fixture();
  native.setFeedURL = () => { throw new Error('Invalid feed'); };
  assert.equal(updater.start().enabled, false);
  assert.equal(updater.getStatus().error, 'Invalid feed');
  assert.equal(calls.first, undefined);
  updater.checkForUpdates();
  assert.equal(calls.checks, 0);
});
