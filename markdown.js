(function attachSnowyyMarkdown(global) {
  'use strict';

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function normalizeStructure(markdown) {
    return String(markdown).split('```').map((segment, index) => {
      if (index % 2) return segment;
      return segment
        .replace(/\s+(?=\d+\.\s+\*\*)/g, '\n')
        .replace(/\s+(?=[-*]\s+\*\*)/g, '\n');
    }).join('```');
  }

  function inlineMarkdown(value) {
    const code = [];
    let output = escapeHtml(value).replace(/`([^`\n]+)`/g, (_match, content) => {
      const token = `SNOWYYINLINECODE${code.length}TOKEN`;
      code.push(`<code>${content}</code>`);
      return token;
    });
    output = output
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    code.forEach((replacement, index) => {
      output = output.replace(`SNOWYYINLINECODE${index}TOKEN`, replacement);
    });
    return output;
  }

  function render(markdown) {
    const lines = normalizeStructure(markdown).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let paragraph = [];
    let listType = null;
    let listItems = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      blocks.push(`<p>${inlineMarkdown(paragraph.join(' ').trim())}</p>`);
      paragraph = [];
    }

    function flushList() {
      if (!listItems.length) return;
      blocks.push(`<${listType}>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${listType}>`);
      listItems = [];
      listType = null;
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = line.match(/^\s*```([^\s`]*)\s*$/);
      if (fence) {
        flushParagraph();
        flushList();
        const language = fence[1] || 'text';
        const content = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          content.push(lines[index]);
          index += 1;
        }
        blocks.push(`<div class="markdown-code"><div class="markdown-code-header"><span>${escapeHtml(language)}</span><button type="button" data-copy-code>Copy</button></div><pre><code>${escapeHtml(content.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(heading[1].length + 2, 6);
        blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? 'ul' : 'ol';
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        listItems.push((unordered || ordered)[1]);
        continue;
      }
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        blocks.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) {
        flushParagraph();
        flushList();
        blocks.push('<hr>');
        continue;
      }
      flushList();
      paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    return blocks.join('');
  }

  function renderInto(container, markdown) {
    container.innerHTML = render(markdown);
  }

  global.SnowyyMarkdown = { escapeHtml, normalizeStructure, render, renderInto };
})(globalThis);
