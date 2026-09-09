import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function markdownRenderer() {
  const source = await readFile(new URL('../markdown.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  return sandbox.SnowyyMarkdown;
}

test('Markdown renderer creates readable paragraphs, lists, and inline code', async () => {
  const renderer = await markdownRenderer();
  const output = renderer.render('Summary paragraph.\n\n1. **First** item\n2. Use `read_file`');
  assert.match(output, /<p>Summary paragraph\.<\/p>/);
  assert.match(output, /<ol>/);
  assert.match(output, /<strong>First<\/strong>/);
  assert.match(output, /<code>read_file<\/code>/);
});

test('Markdown renderer repairs inline numbered summaries from models', async () => {
  const renderer = await markdownRenderer();
  const output = renderer.render('Changes include: 1. **Added field** - done 2. **Updated loader** - done');
  assert.match(output, /<p>Changes include:<\/p>/);
  assert.match(output, /<ol><li><strong>Added field<\/strong>/);
  assert.match(output, /<li><strong>Updated loader<\/strong>/);
});

test('Markdown renderer escapes model-provided HTML and fenced code', async () => {
  const renderer = await markdownRenderer();
  const output = renderer.render('<img src=x onerror=alert(1)>\n\n```html\n<script>alert(1)</script>\n```');
  assert.doesNotMatch(output, /<img src=/);
  assert.doesNotMatch(output, /<script>/);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(output, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
