export function resolveUpdateConfig(config = {}, env = process.env) {
  const repository = (env.SNOWYY_UPDATE_REPOSITORY?.trim() || config.repository || '').trim();
  const url = (env.SNOWYY_UPDATE_URL?.trim() || config.url || '').trim().replace(/\/+$/, '');
  if (repository && !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(repository)) {
    throw new Error('SNOWYY_UPDATE_REPOSITORY must be a GitHub owner/repository pair.');
  }
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('SNOWYY_UPDATE_URL must be an absolute HTTPS URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('SNOWYY_UPDATE_URL must use HTTPS (HTTP is allowed on loopback for testing).');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('SNOWYY_UPDATE_URL must not contain credentials, a query, or a fragment.');
    }
  }
  return { repository, url };
}

export function getUpdateFeedUrl(config, { version, platform = process.platform, arch = process.arch }) {
  const { repository, url } = resolveUpdateConfig(config, {});
  if (url) return url;
  if (!repository) return null;
  return `https://update.electronjs.org/${repository}/${platform}-${arch}/${encodeURIComponent(version)}`;
}
