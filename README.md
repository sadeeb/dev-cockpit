# Dev Cockpit

A desktop app that turns Claude Code from a terminal tool into a **mission-control cockpit**: structured multi-session conversations, auto-titled sessions, GitHub issue linking, a live board across every active agent, and a **shared browser** the agent drives through the Playwright MCP while you watch — and steer — in real time.

![Mission Control](docs/screenshots/mission-control.png)

## Quickstart

```bash
npm install
npm run dev        # development (hot reload)
# or
npm run build && npm start
```

Requirements (the welcome screen checks all of these for you):

- **Node.js 18+** on your PATH — the agent engine runs on it
- **Claude Code authentication** — either you've logged into `claude` before (subscription/OAuth), or `ANTHROPIC_API_KEY` is set
- **GitHub CLI** (`gh`) — optional, used for issue linking (falls back to the public GitHub API)
- **A Chromium-based browser** — optional, for the shared browser (Chrome/Chromium/Edge/Brave, or `npx playwright install chromium`)

## What it does

| Pillar | How |
|---|---|
| **Terminal + agent integration** | Sessions are driven through the **Claude Agent SDK** in bidirectional streaming mode (`stream-json`), never a scraped TTY. The conversation view renders the structured stream: markdown, collapsible tool cards, red/green edit diffs, live to-do checklists, streaming text. |
| **Auto-titled sessions** | Your first prompt is handed to a fast Haiku call **in parallel** with the agent — the sidebar names itself moments later. Works with both API keys and subscription (OAuth) auth. Titles are click-to-edit; precedence is **manual > issue > AI > default**. |
| **GitHub issue linking** | Type `#123`, `owner/repo#123`, or paste an issue URL — in a prompt or via the *Link issue* button. Resolved via `gh` (falls back to the REST API), shown as a state-colored badge, and the issue body + recent comments are injected into the session so the agent starts already knowing the bug. |
| **Mission control** | A board derived **purely from the agent stream** — it can't drift out of sync. Per session: status (running / needs-you / done / error), checklist progress with the current step, the last tools run, a live browser thumbnail, cost, and elapsed time. Click any card to jump in. |
| **Shared browser loop** | One Chromium per session, launched with remote debugging. The **Playwright MCP attaches to that same instance over CDP**, and the app embeds a live CDP screencast next to the conversation. You can click, scroll, and type in the preview — human and agent literally share one browser. |
| **Permissions you can see** | Tool permission prompts appear as cards in the conversation: *Allow once / Always allow / Deny*, plan-approval cards for plan mode, and per-session permission modes from “ask before actions” to full-auto. |

![Session view](docs/screenshots/session.png)
![Permission prompts](docs/screenshots/permission.png)

## Using it

1. **⌘N** — new session: pick the repo folder, a model (default / Opus / Sonnet / Haiku), a permission mode, and optionally enable the browser.
2. Type what you want built or fixed. Mention an issue (`#123` or a URL) and it links + injects context automatically.
3. **⌘B** — mission control. **⌘1…9** — jump between sessions. **Esc** — stop the agent. Typing while the agent runs **queues** the next instruction.
4. Toggle the globe icon to enable browser tools mid-session (no restart needed — MCP servers attach live). The panel opens automatically when the agent first touches the browser.
5. The braces icon opens a raw event drawer — every structured message from the engine, for the curious.

Sessions persist (SQLite) and **resume**: reopening a session replays its history from Claude Code's own transcript and continues the same conversation via `--resume`.

## The browser safety constraint

Everything the agent sees through the browser — page content, console output, form data — is sent to the model API as it works. **Use dev/test environments with test data only.** The app shows this once before enabling browser tools, and Settings can restrict the agent's reachable origins (passed to the MCP as `--allowed-origins`).

## Architecture

```
┌─ renderer (React) ─────────────────────────────────────────────┐
│ Sidebar · Conversation (structured stream) · Mission Control   │
│ Browser panel (CDP screencast + input forwarding) · Settings   │
└──────────────▲────────────────────────────────────────────────-┘
               │ typed IPC (CockpitEvent / CockpitApi)
┌─ main process ─────────────────────────────────────────────────┐
│ SessionManager — orchestration, status, queueing, permissions  │
│ AgentSession   — Claude Agent SDK, streaming in/out, interrupt │
│ Store          — SQLite (node:sqlite; JSON fallback)           │
│ TitleService   — Haiku via API key, or Agent SDK one-shot      │
│ GitHub         — gh CLI → REST fallback, context builder       │
│ BrowserManager — Chromium launch, CDP screencast, MCP config   │
└────────────────────────────────────────────────────────────────┘
External: Claude Agent SDK (bundled engine) · Anthropic API ·
          GitHub · Playwright MCP (@playwright/mcp over CDP)
```

Data model (SQLite): `sessions` (id, claude_session_id, title, title_source, working_dir, status, model, permission_mode, browser_enabled, total_cost_usd, …) and `github_links` (repo, issue_number, issue_title, state, context_injected). Transcripts are **not** duplicated — they're replayed from Claude Code's own JSONL by `claude_session_id`.

The original design brief lives in [docs/SPEC.md](docs/SPEC.md).

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm run build && npm start` | Production build + run |
| `npm test` | Unit tests (issue parsing, title precedence, diffing) |
| `npm run typecheck` | Strict TypeScript over the whole app |
| `COCKPIT_SMOKE=1 npx electron .` | End-to-end check: real agent turn + async title (uses your Claude auth, ~1¢) |
| `COCKPIT_BROWSER_SMOKE=1 npx electron .` | End-to-end check: Chromium + screencast + Playwright-MCP-over-CDP attach |
| `COCKPIT_DEMO=1 npm run dev` | Seeded demo data, no tokens spent (add `COCKPIT_DEMO_VIEW=board` / `session:0`) |

## Implementation notes & decisions

- **Open question “shared browser: separate window or single instance over CDP?”** — went with the recommended upgrade: the app launches Chromium itself, the MCP attaches with `--cdp-endpoint`, and the embedded view is a CDP screencast with input forwarding. The headed window still exists, so you can always grab the real mouse too.
- **Per-session browsers**: each session gets its own Chromium instance + persistent profile (login state survives restarts; profiles are deleted with the session). That's how the board gets a live thumbnail per session.
- **Live reconfiguration**: model, permission mode, and browser tools all change mid-session through the SDK's control protocol (`setModel`, `setPermissionMode`, `setMcpServers`) — no session restarts.
- **Electron is pinned to v38**: newer Electron's install script requires Node 22+, and this machine runs Node 20. Bump it (and drop the pin) once you're on Node 22+.
- **`AskUserQuestion` is disabled** for the agent — questions arrive as plain text in the conversation, which fits a chat UI better than the CLI's modal.
- **No raw PTY pane** (spec listed it as optional): the raw event drawer covers the power-user need without a native `node-pty` build dependency.
