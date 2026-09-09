# Snowyy

Snowyy is a local, provider-neutral LLM terminal that can inspect a workspace, propose edits, and run approved developer commands.

## Start

Requirements for development: Node.js 22.12 or newer and an OpenAI-compatible model endpoint.

Install development dependencies once:

```powershell
npm install
```

```powershell
npm start
```

Open <http://127.0.0.1:4173>. Use the model selector to configure the endpoint and choose from the models reported by Ollama or another compatible provider. Refresh the list after changing the Base URL; **Other model…** remains available for endpoints that do not advertise models. Provider settings live in server memory; API keys are not written to browser storage or project files.

Use the workspace control at the bottom of the sidebar to enter an absolute directory or open the native Windows folder picker. Every new session is attached to the active workspace. Reopening a saved session restores its original workspace automatically.

Type `@` in the composer to search for a workspace file. Choose a result with the mouse, `Enter`, or `Tab`; Snowyy inserts the path into the message and attaches the file as context. Use the arrow keys to move through results and `Escape` to close the menu.

The Files button opens a split workspace explorer and editor. Browse folders on the left, search paths as you type, and open a file in the line-numbered viewer on the right. Select **Edit** to make a direct change, then save with the button or `Ctrl+S`. Saves use the file's latest SHA-256 and are refused if another process changed it after it was opened; JSON and JavaScript saves also receive the same syntax validation used by agent edits. Previews over 1,000 lines remain read-only to prevent accidental partial-file overwrites.

The Sessions heading in the sidebar collapses the saved-session list and remembers that preference. Tool traces and the assistant commentary around them are persisted in timeline order, so reopening a session keeps pre-tool comments above tool cards and completion comments below them.

Snowyy defaults to Ollama's compatibility endpoint:

```text
Base URL: http://127.0.0.1:11434/v1
Model:    snowyy-qwen3-vl
```

For another compatible provider, enter its `/v1` base URL, a tool-capable model name, and an API key when required.

OpenRouter example:

```text
Base URL: https://openrouter.ai/api/v1
Model:    your-provider/your-tool-capable-model
API key:  your OpenRouter key
```

Always open Snowyy from the Node server at <http://127.0.0.1:4173>. Opening `index.html` directly or using a generic static/Live Server leaves the `/api/*` routes unavailable and can return an HTML page where the UI expects JSON.

## Desktop application

Run Snowyy in its Electron window during development:

```powershell
npm run desktop
```

Build the Windows x64 application and Squirrel installer:

```powershell
npm run make
```

The installer is written to `out/make/squirrel.windows/x64/Snowyy-Setup.exe`. The unpacked portable build is under `out/Snowyy-win32-x64/`. Electron launches the Snowyy server on a private random loopback port, uses a native folder picker, and stores sessions in `%APPDATA%\Snowyy\.Snowyy\sessions.json`. Provider configuration and API keys remain memory-only.

### Automatic Windows updates

Snowyy uses Electron's built-in Squirrel updater. Installed copies check shortly
after launch and every ten minutes, download newer releases in the background,
and offer **Restart and update** or **Later**. Choosing Later keeps the update
ready for the next launch. Sessions remain in the existing user-data directory.
Development, portable, and unconfigured builds do not check for updates.
XAMPP, Apache, and MySQL are not required.

#### GitHub Releases

Set a public release repository in `update-config.json`:

```json
{
  "repository": "Iam-JaCk/Snowyy",
  "url": ""
}
```

The configured release repository must be publicly accessible. The updater uses Electron's
[hosted update service](https://github.com/electron/update.electronjs.org) to
discover its published GitHub releases. A private source repository can use a
separate public repository for release assets. Installed users need no GitHub
token or local service.

To publish through GitHub Actions, choose a version higher than **every version
already distributed**, commit the version change, and push its matching tag:

```powershell
# Example: if 0.6.12 was the last distributed version:
npm version 0.6.13 --no-git-tag-version
npm test
git add package.json package-lock.json
git commit -m "chore: release 0.6.13"
git tag v0.6.13
git push origin main --follow-tags
```

The tag workflow tests the project, builds the Squirrel artifacts, and publishes
the GitHub release. It uses GitHub Actions' short-lived repository token with
`contents: write`; no personal access token is stored. The tag must exactly match
the version in `package.json`.

For a manual draft release from a trusted development machine, provide a token
only in that shell:

```powershell
$env:GITHUB_TOKEN = '<temporary token>'
npm run publish:github
```

The publisher builds the installer and uploads `Snowyy-Setup.exe`, the `.nupkg`
packages, and `RELEASES`. Manual publishing creates a draft by default; drafts
are not offered to installed users. Tokens are used only by the publishing
process and are not embedded in the app.

#### Repository secrets

Local `.env` files, private keys, signing certificates, and `secrets` or
`credentials` directories are excluded by `.gitignore`. Keep any optional build
or signing credential in **Repository settings > Secrets and variables >
Actions**, then pass it only to the step that needs it. Do not commit the
credential or its decryption key.

GitHub encrypts Actions secrets at rest and before upload, but public updater
artifacts cannot be encrypted: installed copies must download `RELEASES` and its
`.nupkg` files without a bundled secret. If the application source must remain
private, publish updates from a separate public releases repository. Tools such
as SOPS with age are suitable for encrypted configuration that CI decrypts; they
do not protect data that the installed application itself must decrypt with a
shipped key.

The build embeds the update configuration in the installer.
`SNOWYY_UPDATE_REPOSITORY` and `SNOWYY_UPDATE_URL` provide nonempty build/runtime
overrides. Keep the release source consistent in subsequent builds. With no
source configured, updates stay disabled rather than falling back to localhost.

Install the newly configured `Snowyy-Setup.exe` once to migrate from an older
XAMPP-based installation. Existing installations cannot discover a changed feed
until they receive a build containing it. Subsequent higher versions update
automatically. `npm run update-checks` checks the configured feed from the
developer machine; it does not install or change the application version.

#### Custom hosting

Alternatively, set `url` in `update-config.json` to an HTTPS directory serving a
Squirrel `RELEASES` manifest and its referenced `.nupkg` files. A custom URL takes
precedence over `repository`. HTTP is permitted only on loopback for local tests.
The hosting service must allow installed clients to download the files without
embedded credentials.

```powershell
npm run make
npm run publish:update
```

This stages validated artifacts under `releases/win32/x64`, or
`SNOWYY_UPDATE_PUBLISH_DIR` if set. It checks package sizes and hashes, copies all
referenced packages, and replaces `RELEASES` atomically after the payloads are
ready. Previously published package versions cannot be overwritten with different
content. Upload the staged files to your host, putting `RELEASES` last.

`npm run publish:update -- --verify` additionally verifies that the custom host
serves the staged manifest; use it when the staging directory is already served
by your host. Staging alone does not require any web server to be running.

`/api/config` reports the running version, runtime channel, and updater availability.
`GET /api/updates` reports the current desktop updater state (`disabled`, `idle`,
`checking`, `downloading`, `up-to-date`, `ready`, `installing`, or `error`). Browser
mode reports updates as disabled; it cannot install desktop updates.

## Environment configuration

Copy `.env.example` to `.env`, or set variables before starting:

```powershell
$env:WORKSPACE_ROOT = "C:\path\to\your\project"
$env:LLM_BASE_URL = "http://127.0.0.1:11434/v1"
$env:LLM_MODEL = "snowyy-qwen3-vl"
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | Local HTTP port |
| `WORKSPACE_ROOT` | Snowyy directory | Only workspace exposed to file tools |
| `SESSION_STORE_PATH` | `.Snowyy/sessions.json` | Persistent session metadata and messages |
| `LLM_BASE_URL` | Ollama `/v1` URL | Chat Completions-compatible base URL |
| `LLM_MODEL` | `snowyy-qwen3-vl` | Provider model identifier |
| `LLM_API_KEY` | empty | Optional provider credential |

Environment values take precedence when the server starts. Settings changed in the UI last until the server is restarted.

## Tools and permissions

| Tool | Behavior | Approval |
| --- | --- | --- |
| `list_directory` | Lists up to 200 entries per page with `next_offset` | Automatic |
| `find_files` | Searches up to 10,000 paths by substring or glob; supports pagination | Automatic |
| `search_text` | Searches literal text inside UTF-8 files and returns matching line/column locations | Automatic |
| `read_file` | Reads files up to 2 MB in pages of up to 1,000 lines / 200 KB | Automatic |
| `web_search` | Searches the public web through DuckDuckGo | Automatic |
| `fetch_url` | Fetches a bounded public HTTP/HTTPS page; blocks local and private networks | Automatic |
| `list_goals` | Lists persistent goals for the current session | Automatic |
| `create_goal` | Creates a persistent session goal | Automatic |
| `update_goal` | Renames a goal or marks it active/complete | Automatic |
| `delete_goal` | Removes a session goal | Automatic |
| `apply_patch` | Replaces one exact text block or creates a file | Required |
| `write_file` | Replaces a whole file using a SHA-256 concurrency guard | Required |
| `insert_text` | Inserts text before a hash-guarded line | Required |
| `replace_lines` | Replaces a hash-guarded inclusive line range | Required |
| `delete_lines` | Deletes a hash-guarded inclusive line range | Required |
| `apply_changes` | Applies an atomic multi-file transaction | Required |
| `rollback_change` | Restores an unchanged recent transaction | Required |
| `run_command` | Runs an executable with an argument array | Required |

Paths are resolved against `WORKSPACE_ROOT`. Traversal and symlink escapes are rejected. Commands do not accept shell syntax and are limited to `node`, `npm`, `npx`, `git`, and `rg`.

`read_file` returns raw text without display line-number prefixes and includes the SHA-256 of the complete file. Partial reads report `truncated` and `next_start_line`; out-of-range requests return an error instead of silently reading another line. Binary and non-UTF-8 files cannot be text-edited.

Use `find_files` for filenames and `search_text` for code or text inside files. Both support a starting directory; filename filters accept `*`, `**`, and `?` globs. Content search is literal, skips symlinks and build/dependency directories, and reports truncated results and skipped paths. Narrow the path or query if a search reaches its scan limit.

Snowyy should use `apply_patch` for small unique replacements and `write_file` for complete rewrites. Patch replacement text is literal, including dollar signs; ambiguous matches require more surrounding context. Line edits accept trailing newlines without introducing extra blank lines. Hash-guarded edits reject stale reads, and approved previews are checked again before writing. Concurrent Snowyy edits to the same workspace are serialized, and failed multi-file writes restore earlier writes in that transaction.

Tool arguments are validated before execution or approval. Malformed JSON, unknown arguments, missing values and invalid ranges become structured tool replies with `ok: false`, a `code`, and a recovery `suggestion`, allowing the model to correct its next call. After a stale hash, unmatched patch, or invalid line range, Snowyy requires a fresh `read_file` before another edit. If that read covers the edit and no later operation could have changed the file, Snowyy safely replaces a stale or empty edit hash with the verified read hash; external changes are still refused during preview and execution. Repeating a completed rollback is idempotent and reports `already_rolled_back`. Command results report failure for nonzero exits, cancellation and timeouts, and retain both the beginning and end of long output. Running commands stream output into their tool card and expose Pause, Resume, and Stop controls. On Windows, npm/npx run through their Node entry points without a command shell; Electron's bundled Node runtime also runs syntax checks correctly.

The tool controller recognizes contextual mutation requests such as "edit it," resolves the target from recent tool activity, and removes the UI's `@` mention marker before executing file tools. If a model promises or claims an action without a matching successful tool result, Snowyy performs up to two isolated, temperature-zero recovery rounds with only the required tool exposed. Natural handoffs such as "let me implement this" and reasoning-only stops are recovered even when the model omits the tool's function name. Unsupported syntax types report `unverified`; only an executed checker can report `valid`.

Edit approvals include a line diff. Supported single-file proposals can be adjusted in the review dialog before one-time approval. JSON and Node.js files receive automatic syntax checks; a failed check restores the original content. Successful edit results include a guarded Undo action. Multi-file writes validate every hash before changing anything and roll back the complete transaction on failure.

This is an application-level safety boundary, not an operating-system container. Approved processes still run with your user account's permissions. A container or restricted OS account is the appropriate next hardening step before using untrusted models or repositories.

## Architecture

```text
Browser UI
   │ POST /api/chat
   ▼
SSE agent loop ───────► OpenAI-compatible /chat/completions
   │                               │
   │ tool call                     │ streamed deltas
   ▼                               │
Tool registry ◄────────────────────┘
   │
   ├─ read tool ─────────► execute immediately
   └─ write/command ─────► pause → UI approval → resume
```

Pending approvals expire after ten minutes. Agent runs can use as many tool rounds as the task requires; the Stop button remains available throughout a run.

## Sessions

Sessions are persisted locally and can be created, reopened, or deleted from the sidebar. The first user message becomes the session title. Stored session data contains chat messages, tool history, approval decisions, goals, compaction state, settings, and its workspace path; API keys and live approval capability are never stored there. The server treats this stored history as authoritative, so a stopped or stale browser request cannot replace earlier context.

The ordered session timeline also stores assistant rounds, tool arguments, approval decisions, results, failures, and reported token usage. Reopening a session reconstructs those tool cards. Pending approvals themselves remain intentionally non-persistent and display as interrupted after a restart.

The session store is isolated in `lib/sessions.mjs` and uses an atomic local JSON file. Snowyy does not require XAMPP, Apache, or MySQL.

## Context and workspace controls

The folder button opens a workspace drawer for directory navigation, path search, text preview, and explicit per-prompt workspace context. The composer paperclip accepts bounded text/code files and PNG, JPEG, WebP, or GIF images; screenshots can also be pasted directly into the prompt. Image uploads use the OpenAI-compatible vision message format, so the configured model must support images. Attachments are removed from active context after sending and are not persisted as base64 data in session history.

Each session has a writable context limit from 1,000 to 5,000,000 tokens. Before the history reaches the provider limit, Snowyy asks the configured model for a clean factual summary that preserves objectives, decisions, paths, failures, results, and next steps. The summary and its position are stored and reused on later turns. Values can be changed in Settings or with `/context 128000` (suffixes such as `128k` and `1.3m` also work).

Provider output limits are handled separately from the context window. When a provider reports that a response ended because of its output-token limit, Snowyy requests the continuation and joins it to the same assistant message. If a provider reports a normal stop after only reasoning or after announcing its next action, Snowyy continues automatically; a short prompt such as "Continue" retains the earlier actionable request as its recovery objective. If a stream disconnects without a completion marker, Snowyy reports the interruption and retains every received token in the session. Stored messages and timeline events are not silently removed after a fixed count.

Planning-only mode permits read-only workspace, web, and goal inspection while disabling edits, commands, and goal changes. Approval and tool settings, the context limit, and provider/model selection are remembered and inherited by new sessions. Type `/help` for local commands including `/plan`, `/context`, `/approve always`, `/approve ask`, `/files`, `/settings`, and `/new`. A `SNOWYY.md` file at the workspace root supplies durable project instructions. The Stop button aborts model streaming and saves partial assistant output; a command can also be controlled independently from its tool card.

Assistant responses are rendered as safe streaming Markdown with paragraphs, lists, emphasis, inline code, blockquotes, and fenced code blocks with copy controls. Raw model-provided HTML is escaped. When a compatible provider sends a separate reasoning or thinking field, Snowyy streams it into a collapsible **Model reasoning** panel. The agent may ask a focused question when required information or confirmation is missing. Session goals created by the model appear above the composer and can also be completed or removed there.

## Tests

```powershell
npm test
```

The suite covers path traversal, symlink write escapes, bounded reads and web fetches, exact edits, authoritative session history, durable compaction, unlimited tool rounds, provider reasoning, command stop/pause/resume controls, streamed tool-call assembly, and the complete pause/approve/resume flow.
