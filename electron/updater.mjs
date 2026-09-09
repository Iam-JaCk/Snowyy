export function createDesktopUpdater({
  autoUpdater, feedUrl, enabled, onDownloaded = async () => {}, logger = console,
  firstDelay = 3_000, interval = 10 * 60 * 1000,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval }
}) {
  let state = { enabled: Boolean(enabled && feedUrl), status: enabled && feedUrl ? 'idle' : 'disabled', releaseName: null, error: null };
  let firstTimer = null;
  let intervalTimer = null;
  let started = false;
  let disposed = false;
  let ready = false;
  const listeners = [];
  const getStatus = () => ({ ...state });
  const fail = (error) => {
    state = { ...state, status: 'error', error: error?.message || String(error) };
    logger.warn(`Snowyy updater: ${state.error}`);
  };

  function checkForUpdates() {
    if (!started || disposed || !state.enabled || ready || ['checking', 'downloading', 'installing'].includes(state.status)) return getStatus();
    state = { ...state, status: 'checking', error: null };
    try {
      autoUpdater.checkForUpdates()?.catch?.(fail);
    } catch (error) {
      fail(error);
    }
    return getStatus();
  }

  function start() {
    if (started || disposed || !state.enabled) return getStatus();
    started = true;
    const on = (name, callback) => {
      autoUpdater.on(name, callback);
      listeners.push([name, callback]);
    };
    on('error', fail);
    on('checking-for-update', () => { state = { ...state, status: 'checking', error: null }; });
    on('update-available', () => { state = { ...state, status: 'downloading' }; });
    on('update-not-available', () => { state = { ...state, status: 'up-to-date', error: null }; });
    on('update-downloaded', (_event, _notes, releaseName) => {
      if (ready) return;
      ready = true;
      state = { ...state, status: 'ready', releaseName: releaseName || null, error: null };
      Promise.resolve().then(() => onDownloaded(getStatus())).catch((error) => {
        logger.warn(`Snowyy update prompt: ${error.message}`);
      });
    });
    try {
      autoUpdater.setFeedURL({ url: feedUrl });
    } catch (error) {
      fail(error);
      state.enabled = false;
      return getStatus();
    }
    firstTimer = timers.setTimeout(checkForUpdates, firstDelay);
    intervalTimer = timers.setInterval(checkForUpdates, interval);
    firstTimer.unref?.();
    intervalTimer.unref?.();
    return getStatus();
  }

  function quitAndInstall() {
    if (!ready || disposed || state.status === 'installing') return false;
    state = { ...state, status: 'installing' };
    try {
      autoUpdater.quitAndInstall();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }

  function dispose() {
    disposed = true;
    if (firstTimer !== null) timers.clearTimeout(firstTimer);
    if (intervalTimer !== null) timers.clearInterval(intervalTimer);
    for (const [name, callback] of listeners) autoUpdater.removeListener(name, callback);
  }

  return { start, checkForUpdates, quitAndInstall, getStatus, dispose };
}
