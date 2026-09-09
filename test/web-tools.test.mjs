import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebTools, parseDuckDuckGoResults } from '../lib/web-tools.mjs';

test('DuckDuckGo results are decoded into stable source records', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Example &amp; Guide</a>
    <div class="result__snippet">A <b>useful</b> result.</div>`;
  assert.deepEqual(parseDuckDuckGoResults(html), [{
    title: 'Example & Guide', url: 'https://example.com/guide', snippet: 'A useful result.'
  }]);
});

test('web tools block private targets and return bounded readable public text', async () => {
  const requests = [];
  const web = createWebTools({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response('<html><style>no</style><body><h1>Hello</h1><p>Public page</p></body></html>', {
        status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
  });
  await assert.rejects(web.fetchUrl({ url: 'http://127.0.0.1/private' }), (error) => error.code === 'PRIVATE_URL');
  const result = await web.fetchUrl({ url: 'https://example.com/page', max_chars: 1_000 });
  assert.equal(requests[0], 'https://example.com/page');
  assert.match(result.content, /Hello\s+Public page/);
  assert.equal(result.truncated, false);
});
