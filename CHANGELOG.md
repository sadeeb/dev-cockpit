# Changelog

All notable changes to Argus are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-07

### Added

- **One-click PR review**: the new-session modal's Workspace section gains "Review a pull request". Enter `#123` or paste the PR URL; Argus fetches `pull/<n>/head` from origin (fork PRs included) into a managed worktree, opens the session there, and links the PR. Re-reviewing after new pushes picks up the latest head; deleting the session cleans the worktree up.

### Changed

- The "Own branch + worktree" checkbox became a three-way Workspace choice: use the folder directly, new branch + worktree, or review a PR.

## [1.0.0] - 2026-07-07

First public release, MIT-licensed. Renamed from Dev Cockpit to **Argus**.

### Added

- **Embedded co-piloted browser**: per-session headless Chromium screencast inside the app; the Playwright MCP attaches to the same instance over CDP, so human and agent share one browser surface
- **Console drawer**: captures `console.*`, uncaught exceptions, and failed network requests; auto-opens on page errors; lines click straight into the chat composer
- **Point-at-element**: click anything in the browser preview to drop its selector, text, and a cropped screenshot into the composer
- **Image input**: paste screenshots into the composer; sent to the agent as image blocks
- **Changes panel**: live working-tree view with status chips, expandable diffs, per-file discard, and commit-all
- **Git worktree per session**: isolated branch + worktree so parallel sessions don't collide, with a guarded Merge back action
- **Process panel**: run dev servers inside the session with live tails, group kill, and click-line-to-chat
- **Session forking**: branch a conversation into a copy that inherits full history
- **Persistent permission rules**: "Always, for this repo" survives restarts; rules editable in Settings
- **Native notifications + dock badge** for sessions that need attention while the window is unfocused
- **⌘K command palette**: fuzzy jump to sessions, panel toggles, and actions
- **Fable** in the model picker alongside Default/Opus/Sonnet/Haiku
- Delete X on board cards and sidebar sessions; confetti on plan completion; per-session cost sparkline
- macOS packaging (`npm run dist` → `Argus.app`) with the Argus eye icon; one-time data migration from the Dev Cockpit identity

### Changed

- Full visual redesign: cream paper, near-black ink, flat primary color blocks, numbered session cards, black pill buttons, graph-paper backdrops (reference: units.gr)
- The shared browser now launches headless; the in-app panel is the only surface (no separate desktop window)
- All UI copy rewritten without em dashes

## [0.1.0] - 2026-06-13

### Added

- Initial Dev Cockpit v1: multi-session board driven purely from the agent stream, structured conversation view (markdown, tool cards, diffs, todo checklists), auto-titled sessions, GitHub issue linking with context injection, per-session models and permission modes, permission prompt cards, session persistence and resume via Claude Code transcripts, shared visible-window browser with CDP screencast
