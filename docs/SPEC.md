# Dev Cockpit — Design Spec

> A desktop app that wraps Claude Code in a mission-control UI: terminal integration,
> auto-titled sessions, GitHub issue linking, a multi-session board, and a shared
> browser the AI drives (via Playwright MCP) while the human watches and steers via chat.

This document is written to be handed to Claude Code as the working brief. Sections
marked **Decided** are settled; sections marked **Open** need a call before/while building.

---

## 1. Concept

One window that turns Claude Code from a terminal tool into a cockpit for AI-assisted
development. Three pillars:

1. **Terminal + agent integration** — structured, multi-session, with auto-generated
   titles and GitHub issue linking.
2. **Mission control** — a board across all active sessions showing which issue each
   one owns, its task checklist, the tools it has run, and a live thumbnail of its browser.
3. **Shared browser loop** — the agent drives the app under development through the
   Playwright MCP; the human sees the same live browser and directs via chat, closing
   the build → test → fix loop without copy-pasting errors.

---

## 2. Architecture overview

Three layers.

**UI layer (renderer)**
- Session list / sidebar
- Conversation view (renders the structured agent stream, not raw TTY bytes)
- Prompt input + editable title bar
- Mission-control board
- Embedded live browser panel

**Core services (main process)**
- Session manager (+ SQLite persistence)
- Claude Code bridge (stream-json I/O)
- Title service (auto-naming)
- GitHub service (issue lookup)
- Mission-control projector (derives board state from the agent stream)

**External integrations**
- Claude Agent SDK (the headless Claude Code engine)
- A fast model via the Anthropic API (title generation)
- GitHub API (issue metadata)
- Playwright MCP (browser automation)

---

## 3. Core service: the Claude Code bridge — **Decided**

Do **not** run `claude` inside a raw pty and screen-scrape the bytes. Drive it through
the **Claude Agent SDK** in bidirectional streaming mode, which hands back structured
messages instead of terminal soup. This single decision is what makes auto-titling,
mission control, and issue linking clean instead of hacky.

- Use `--input-format stream-json --output-format stream-json` for persistent,
  multi-turn sessions.
- Each result carries a `session_id`. Persist it — that ID **is** the session row.
- Resume any session later with `--resume <session_id>`. Suspend/reopen comes for free.
- The bridge's job: pump user prompts in, route structured output messages
  (assistant text, `tool_use` events, tool results) out to the renderer.

The "terminal" the user sees is a *rendered view* of this structured stream. Optionally
offer a raw shell pane (xterm.js + node-pty) for power users, but it is not the primary
surface.

---

## 4. Sessions & auto-titling — **Decided**

When the user submits their **first prompt** in a session:

1. Forward it to the bridge as normal.
2. In parallel, hand a copy to the **title service**, which calls a fast, cheap model
   (e.g. Claude Haiku) with a tight system prompt:
   *"Return a 3–6 word title, sentence case, no quotes, no trailing punctuation."*
3. Write the result to the session row; the sidebar updates.

Rules:
- **Async** — never block the terminal/agent on title generation.
- **Key off the raw prompt text**, not the agent's response, so the title appears almost
  instantly and costs no agent tokens.
- Titles are **manually editable**.

---

## 5. GitHub issue linking — **Decided**

Detect issue references three ways: a pasted URL, `#123`, or `owner/repo#123`.
Resolve via the `gh` CLI if installed (free, already authenticated); fall back to Octokit.
Fetch the issue title + state.

**Title precedence** (highest wins):

| Priority | Source | Rendered as |
|----------|--------|-------------|
| 1 | User-edited manual title | the user's text |
| 2 | Linked GitHub issue | `#142 · Login redirect loops on Safari` |
| 3 | AI-generated title (from first prompt) | e.g. `Fix Safari login redirect` |
| 4 | Default | `Untitled session` |

Show the issue number as a badge regardless of which title wins.

**Bonus:** when an issue is linked, inject its body + comments into the session as
starting context so the agent begins already knowing the bug.

---

## 6. Mission control — **Decided** (derive, don't duplicate)

The board is a **projection over the agent stream**, not a separate tracker that can
drift out of sync. Subscribe to what Claude Code already emits:

- `tool_use` events → which tools ran and finished
- the agent's built-in todo/task tool → the live checklist with checkmarks
- session status → running / waiting-for-input / done / error
- the GitHub service → the linked issue

Render, per active session/issue: owning agent, task list with progress, tool log, and a
live browser thumbnail. Because it reads the same stream the agent produces, the board
can never misreport what was actually done.

Implementation shape: a reducer that consumes the multiplexed streams of all sessions and
emits board state. Define the event→state mapping explicitly (see Open Questions).

---

## 7. Browser loop — **Decided** (with one upgrade to spec)

### How the AI touches the browser
Use the **Playwright MCP** (`@playwright/mcp`). Install into Claude Code with:

```bash
claude mcp add playwright npx @playwright/mcp@latest
```

Why this and not raw Playwright scripts:
- Operates on the **accessibility tree**, not pixels — every interactive element gets a
  stable `ref`, so actions are deterministic instead of guessed from a screenshot.
- Cheap: ~200–400 tokens per snapshot vs thousands for raw DOM/screenshots.
- 40+ tools (navigation, forms, network, console, tracing); login state persists.
- Opens **headed by default**, so there is a visible browser — that *is* the human's view.

### The loop
```
Human (chat) → Claude Code (agent) → Playwright MCP → Browser (your live app)
                     ↑                                          |
                     └──── observations: a11y snapshot, console, network ──┘
Human also watches the live browser and can take over.
```

The agent writes code, restarts the dev server, drives the app through a flow, pulls
console errors + failed network calls back as observations, fixes, repeats — while the
human watches and interjects in chat.

### Upgrade: make it ONE shared browser — **Open** (recommended)
The default gives a separate headed Chromium window. The better design: launch a single
Chromium with remote debugging, embed its live view in mission control (CDP screencast or
an Electron `BrowserView`), and have the Playwright MCP attach to that **same** instance
over CDP (`connectOverCDP`). Then AI and human share one surface and the human can grab
the mouse mid-task. Confirm this is worth the extra plumbing for v1.

### Hard constraint — **Decided**
Everything the agent sees through the browser (page content, console, form data) is sent
to the API. **Dev/test environments with test data only.** Bake this into the tool's
permissions, not a footnote.

---

## 8. Tech stack — **Decided for v1**

- **Shell:** Electron. The Agent SDK is first-class TypeScript/Node, so it runs in the
  main process with zero sidecar plumbing; IPC carries the stream to the renderer.
  (Tauri is leaner but forces the SDK into a Node sidecar — defer.)
- **Terminal rendering (optional raw pane):** xterm.js + node-pty.
- **Persistence:** SQLite.
- **Browser automation:** Playwright MCP.
- **Titles:** Anthropic API, a fast/cheap model.

---

## 9. Data model — **Decided** (starting point)

Keep it small. Don't store transcripts — Claude Code keeps its own JSONL; reference by
`session_id`.

```
sessions
  id                TEXT PK
  claude_session_id TEXT        -- from the Agent SDK stream
  title             TEXT
  title_source      TEXT        -- manual | issue | ai | default
  working_dir       TEXT
  status            TEXT        -- idle | running | waiting | done | error
  created_at        INTEGER
  updated_at        INTEGER

github_links
  session_id   TEXT FK -> sessions.id
  repo         TEXT        -- owner/repo
  issue_number INTEGER
  issue_title  TEXT
  state        TEXT        -- open | closed
```

---

## 10. Suggested build order

1. Claude Code bridge over the Agent SDK stream-json protocol; render the stream in a
   basic conversation view. (Everything hangs off this.)
2. Session manager + SQLite; create/list/resume sessions.
3. Title service (first-prompt → async title).
4. GitHub linking + precedence rule.
5. Mission-control projector + board.
6. Playwright MCP integration; single-session browser loop.
7. Shared-browser-over-CDP upgrade + embedded live view.

---

## 11. Open questions

- **Bridge ↔ renderer message contract:** exact event shapes flowing from the SDK stream
  to the UI. Needed before serious UI work.
- **Mission-control event model:** the precise mapping from raw stream events
  (`tool_use`, todo updates, status, issue link) to board state.
- **Shared browser:** commit to the single-instance-over-CDP design for v1, or ship the
  separate headed window first and upgrade later?
- **Multi-agent concurrency:** how many sessions run at once, and how is the board's live
  browser thumbnail sourced per session?
