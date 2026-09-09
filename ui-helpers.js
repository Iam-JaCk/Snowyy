(function attachSnowyyUiHelpers(global) {
  'use strict';

  function pathText(value) {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  function workspaceLabel(workspacePath) {
    const safePath = pathText(workspacePath);
    return safePath.split(/[\\/]/).filter(Boolean).at(-1) || safePath;
  }

  function mentionPathParts(filePath) {
    const safePath = pathText(filePath);
    const parts = safePath.split(/[\\/]/);
    return {
      name: parts.pop() || safePath,
      parent: parts.join('/') || 'workspace root'
    };
  }

  function fileLanguage(filePath) {
    const extension = pathText(filePath).split('.').pop()?.toLowerCase();
    return ({
      js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript React', jsx: 'JavaScript React',
      json: 'JSON', md: 'Markdown', css: 'CSS', html: 'HTML', xml: 'XML', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
      py: 'Python', lua: 'Lua', luau: 'Luau', java: 'Java', c: 'C', h: 'C Header', cpp: 'C++', hpp: 'C++ Header',
      rs: 'Rust', go: 'Go', sql: 'SQL', sh: 'Shell', ps1: 'PowerShell'
    })[extension] || 'Plain Text';
  }

  function fileIconLabel(filePath, isDirectory) {
    if (isDirectory) return '▸';
    const safePath = pathText(filePath);
    const extension = safePath.split('.').pop();
    return extension && extension !== safePath ? extension.slice(0, 4).toUpperCase() : 'FILE';
  }

  global.SnowyyUiHelpers = { pathText, workspaceLabel, mentionPathParts, fileLanguage, fileIconLabel };
})(globalThis);
