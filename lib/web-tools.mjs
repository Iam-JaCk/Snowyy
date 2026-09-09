import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { toolError } from './tool-contracts.mjs';

const MAX_DOWNLOAD_BYTES = 1_000_000;
const USER_AGENT = 'Snowyy-Local-Agent/0.6 (+https://github.com/Iam-JaCk/Snowyy)';

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: ' ' };
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function plainText(html) {
  return decodeEntities(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function parseDuckDuckGoResults(html, maximum = 8) {
  const results = [];
  const links = [...String(html).matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...String(html).matchAll(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/gi)];
  for (let index = 0; index < links.length && results.length < maximum; index += 1) {
    let url = decodeEntities(links[index][1]);
    try {
      const parsed = new URL(url, 'https://duckduckgo.com');
      url = parsed.searchParams.get('uddg') || parsed.href;
    } catch { continue; }
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: plainText(links[index][2]),
      url,
      snippet: snippets[index] ? plainText(snippets[index][1]) : ''
    });
  }
  return results;
}

function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return false;
  const [a, b] = normalized.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function assertPublicUrl(rawUrl, lookupImpl) {
  let url;
  try { url = new URL(rawUrl); } catch {
    throw toolError('INVALID_URL', 'url must be an absolute HTTP or HTTPS URL.', 'Use a complete public URL such as https://example.com/page.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw toolError('INVALID_URL', 'Only public HTTP and HTTPS URLs without credentials are supported.', 'Use a normal public webpage URL.');
  }
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) {
    throw toolError('PRIVATE_URL', 'Local and private network URLs are blocked.', 'Use workspace tools for local files and services.');
  }
  const records = isIP(url.hostname) ? [{ address: url.hostname }] : await lookupImpl(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => isPrivateAddress(address))) {
    throw toolError('PRIVATE_URL', 'Local and private network URLs are blocked.', 'Use a public webpage URL.');
  }
  return url;
}

async function readBoundedBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw toolError('RESPONSE_TOO_LARGE', 'The webpage exceeded the 1 MB download limit.', 'Fetch a smaller or more specific page.');
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

export function createWebTools({ fetchImpl = fetch, lookupImpl = lookup } = {}) {
  async function webSearch({ query, limit = 8 }, { signal } = {}) {
    const endpoint = new URL('https://html.duckduckgo.com/html/');
    endpoint.searchParams.set('q', query);
    const response = await fetchImpl(endpoint, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      signal: requestSignal(signal),
      redirect: 'follow'
    });
    if (!response.ok) throw toolError('WEB_REQUEST_FAILED', `DuckDuckGo returned HTTP ${response.status}.`, 'Try a narrower query or fetch a known page directly.');
    const results = parseDuckDuckGoResults(await readBoundedBody(response), limit);
    return { query, results, result_count: results.length };
  }

  async function fetchUrl({ url: rawUrl, max_chars: maximumCharacters = 30_000 }, { signal } = {}) {
    let url = await assertPublicUrl(rawUrl, lookupImpl);
    let response;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetchImpl(url, {
        headers: { Accept: 'text/html, text/plain, application/json, application/xml;q=0.9', 'User-Agent': USER_AGENT },
        signal: requestSignal(signal), redirect: 'manual'
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw toolError('TOO_MANY_REDIRECTS', 'The webpage redirected too many times.', 'Fetch the final public URL directly.');
      await response.body?.cancel();
      url = await assertPublicUrl(new URL(location, url).href, lookupImpl);
    }
    if (!response.ok) throw toolError('WEB_REQUEST_FAILED', `The webpage returned HTTP ${response.status}.`, 'Check the URL or use web_search to find another source.');
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!/(?:text\/|application\/(?:json|xml|xhtml\+xml))/.test(contentType)) {
      throw toolError('UNSUPPORTED_CONTENT', `Unsupported webpage content type: ${contentType || 'unknown'}.`, 'Fetch an HTML, text, JSON, or XML page.');
    }
    const raw = await readBoundedBody(response);
    const content = contentType.includes('html') || /<html\b/i.test(raw) ? plainText(raw) : raw.trim();
    return {
      url: url.href,
      content_type: contentType || 'text/plain',
      content: content.slice(0, maximumCharacters),
      truncated: content.length > maximumCharacters
    };
  }

  return { webSearch, fetchUrl };
}
