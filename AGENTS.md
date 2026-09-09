# Repository Guidelines

This document outlines contributor expectations for the Snowyy repository — a local, provider-neutral LLM terminal built as an Electron desktop application.

---

## Project Structure & Module Organization

The codebase follows a clean separation between core functionality, UI rendering, and workflow orchestration:

`
snowyy/
├── app.js                # Main server entry point and message handlers
├── index.html            # Browser UI shell
├── styles.css            # Application styling
├── package.json          # Dependencies and scripts
├── forge.config.mjs      # Electron Forge build configuration
├── .env.example          # Environment variable template
│
├── electron/             # Desktop application module
│   ├── main.mjs          # Electron renderer process entry
│   └── preload.cjs       # Preload script for IPC bindings
│
├── lib/                  # Core functional modules (ES modules)
│   ├── tools.mjs         # File system tool registry and execution
│   ├── provider.mjs      # OpenAI-compatible adapter layer
│   ├── workflows.mjs     # Prebuilt and custom workflow orchestration
│   ├── editing.mjs       # Direct file editing capabilities
│   ├── sessions.mjs      # Session persistence and retrieval
│   └── path-sandbox.mjs  # Path traversal protection utilities
│
├── scripts/              # Build and deployment helpers
│   └── publish-update.mjs
│
├── test/                 # Unit and integration tests
│   ├── tools.test.mjs    # Tool registry tests
│   ├── provider.test.mjs # Provider adapter tests  
│   ├── sessions.test.mjs # Session management tests
│   ├── markdown.test.mjs # UI rendering tests
│   └── ui-helpers.test.mjs
│
├── utils/                # Shared utilities and updaters
│
└── out/                  # Compiled outputs (build artifacts)

---

## Build, Test, and Development Commands

### Quick Start
`powershell
npm install        # Install all dependencies
npm start          # Start the local server (default)
npm dev            # Watch mode for development
npm desktop        # Run the Electron window
npm make           # Build Windows installer (.exe)
`

### Testing
`powershell
npm test           # Run full test suite with native Node.js assertions
npm run update-checks    # Manual update checker testing (local only)
`

### Understanding Each Command
- 
pm install — Installs all dependencies including Electron and Forge
- 
pm start — Launches the server on port 4173 with basic config
- 
pm dev — Watches for changes and auto-restarts during development
- 
pm desktop — Opens Snowyy in an Electron window for desktop testing  
- 
pm make — Creates Windows installer at out/make/squirrel.windows/x64/
- 
pm test — Runs all tests using Node.js native 
ode:test framework with strict assertions

---

## Coding Style & Naming Conventions

### File Types and Imports
- Use **ES modules** (.mjs) for core logic and UI rendering
- Use **CommonJS** (.cjs) for Electron preload scripts requiring global scope
- All imports use import.meta.url for local file resolution in tests

### Module Exports Pattern  
`javascript
// lib/*.mjs — Export modules as functions/objects, not classes by default
export const someFunction = async () => {};
export const SOME_CONSTANT = 42;
export function createToolRegistry(root) { ... }

// lib/*.cjs — Use class exports for Electron IPC bridges
export class PreloadBridge {
  constructor(config) {}
  bindChannel(name, handler) { /* IPC logic */ }
}
`

### File Naming
- **CamelCase** for functions, variables, and constants (camelCase/UPPER_CASE)
- **PascalCase** for classes and event handlers (ClassName/EventHandlerName)
- Module exports use **lowercase function names** by convention

---

## Testing Guidelines

### Test Framework
Uses **Node.js native test framework** (import test from 'node:test') with ssert/strict.

### Naming Convention  
`javascript
test('description of single behavior', async (t) => {
  // Setup...
  const result = await someAsyncOperation();
  assert.equal(result.value, expectedValue);
  t.after(() => cleanup());
});
`

### Testing Patterns
1. **Unit tests** — Test individual modules in isolation with mocked providers
2. **Integration tests** — Test full flows including server and Electron IPC  
3. **Teardown helpers** — Use 	.after() for cleanup (temp directories, server shutdown)
4. **Async fixtures** — Helper functions returning promises for repeated setup

### Example: Temporary Workspace
`javascript
async function temporaryWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), 'snowyy-tools-'));
}

test('read tools inspect only the configured workspace', async (t) => {
  const workspace = await temporaryWorkspace();
  t.after(() => rm(workspace, { recursive: true, force: true }));
  
  // Test code here...
});
`

---

## Commit & Pull Request Guidelines

### Git History Conventions
Based on project patterns, commits follow this semantic convention:

| Type | Format | Example |
|------|--------|---------|
| **feat** | eat: <description> | eat: add edit approval dialog |
| **fix** | ix: <description> | ix: path traversal in tool executor |
| **docs** | docs: <description> | docs: update README setup steps |
| **build** | uild: <description> | uild: reduce bundle size by 15% |
| **chore** | chore: <description> | chore: update dependencies |

### Commit Message Pattern
`
type: subject

Extended description (optional)

Related issue (optional) — [ISSUE#123]
`

### Example Commit
`
feat: add workflow step validation

Add runtime type checking for workflow steps before execution.
Closes [ISSUE-789]
`

### Pull Request Requirements
- ✅ **Description** — Explain what and why, not just how
- ✅ **Related issue** — Link to GitHub issue using [ISSUE-XXX]
- ✅ **Tests** — Include tests for new behavior or modified paths
- ✅ **Breaking changes** — Document if any API/surface area changed
- ✅ **Screenshots** — Attach UI preview images for desktop changes

---

## Security & Configuration Tips

### Path Sandboxing
All file operations respect the configured WORKSPACE_ROOT. Never pass absolute paths to external providers.

### Environment Variables
`powershell
# Recommended development setup
 = "4173"
 = "C:\path\to\your\project"
 = "http://127.0.0.1:11434/v1"
 = "snowyy-qwen3-vl"

npm start
`

### Security Best Practices
1. Never commit .env files — keep them out of .gitignore
2. Use SNOWYY_UPDATE_PUBLISH_DIR for private release distribution
3. Verify file hashes before writing (built into 	ools.mjs)
4. Approved commands run with your user permissions — use containers for sensitive workloads

---

## Agent-Specific Instructions

### Workflow Creation
`javascript
const workflow = Workflow.createPrebuilt('workspace_setup');
workflow.setStep('attachment', { workspacePath: '.workspace/context' });
await workflow.run();
`

### Tool Registration Pattern
`javascript
registry.addTool({
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file inside the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to file' }
      },
      additionalProperties: false
    }
  }
});
`

---

*For questions not addressed here, reference the main [README.md](./README.md) or open an issue.*
