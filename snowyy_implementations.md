## 1A. Fixes and improvements 0.6.0

- [x]   Make the max context writable, so I can choose what the max context can be.
Examples: {
    128000 = 128k,
    128560 = 128k,
    1300000 = 1.3m,
    1302405 = 1.3m,
}

- [x]   Support attachments and screenshot posting.

- [x]   Add slash commands. Ex: /plan, /context, approve always, etc...

Implemented in Snowyy 0.6.0:

- Context limits accept exact values from 1,000 to 5,000,000 tokens and are saved per session.
- The composer accepts PNG/JPEG/WebP/GIF images, pasted screenshots, and bounded text/code files. Workspace-file context remains available from the Files drawer.
- Commands: `/plan`, `/plan off`, `/context [tokens]`, `/approve always`, `/approve ask`, `/files`, `/settings`, `/new`, and `/help`.

## 1B. Release Candidate Version 0.6.3

- [x]   Improving the file browser/editor functionality and readability, maybe making it similar to Visual Studio Code.

- [x]   AI comments - Currently AI makes a comment before implementing a fix, but post-fix, it comments above the apply_patch, read_file, etc tool use. Instead of under it. Could be because those don't count as "real" and they get deleted after an app restart.

- [x]   Collapsable sessions tab.

Implemented in Snowyy 0.6.3:

- Reworked Files into a wider split explorer/editor with live search, folder navigation, refresh, file-type labels, active/modified states, line numbers, language and cursor status, editing, cancel, and `Ctrl+S` save.
- Direct editor saves use SHA-256 concurrency protection and existing syntax validation. Truncated previews are read-only so a partial file cannot replace the complete source.
- Streamed assistant text now uses a fresh segment after tool cards. Session timelines restore pre-tool and post-tool comments in their original positions after restart.
- The Sessions section is collapsible, displays its session count, and remembers its collapsed state locally.

## 1C. Hotfix 0.6.4

- [x] Fixed workspace switching crashing with `Cannot read properties of null (reading 'split')`. Clearing the previous file preview now uses null-safe path metadata, so the newly selected workspace can load and preview files normally.
