import type { CockpitEvent, ConvoEvent } from '../shared/types'
import { Store } from './store'

/**
 * Demo seeder (COCKPIT_DEMO=1): populates an in-memory store with three
 * sessions and replays a scripted stream so the UI can be exercised — and
 * screenshotted — without burning agent tokens.
 */
export function runDemo(store: Store, broadcast: (e: CockpitEvent) => void): void {
  const a = store.createSession({
    workingDir: '/Users/dev/acme-web',
    model: null,
    permissionMode: 'default',
    browserEnabled: true
  })
  const b = store.createSession({
    workingDir: '/Users/dev/reports-service',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    browserEnabled: false
  })
  const c = store.createSession({
    workingDir: '/Users/dev/cli-tools',
    model: 'haiku',
    permissionMode: 'default',
    browserEnabled: false
  })

  store.updateSession(a.id, { title: '#142 · Login redirect loops on Safari', titleSource: 'issue', status: 'running', firstPromptSent: true, totalCostUsd: 0.4182 })
  store.setLink({ sessionId: a.id, repo: 'acme/acme-web', issueNumber: 142, issueTitle: 'Login redirect loops on Safari', state: 'open', url: 'https://github.com/acme/acme-web/issues/142', contextInjected: true })
  store.updateSession(b.id, { title: 'Add CSV export to reports', titleSource: 'ai', status: 'waiting', firstPromptSent: true, totalCostUsd: 0.1071 })
  store.updateSession(c.id, { title: 'Refactor settings storage', titleSource: 'ai', status: 'done', firstPromptSent: true, totalCostUsd: 0.0455 })

  const convo = (sessionId: string, ev: ConvoEvent): void => broadcast({ kind: 'convo', sessionId, ev })
  const now = Date.now()

  // Session A — mid-flight with todos, tools, and streaming text
  convo(a.id, { t: 'user', text: 'Fix #142 — login redirect loops forever on Safari. Repro: log in from /pricing, Safari 17.', ts: now - 95000 })
  convo(a.id, { t: 'issue-context', repo: 'acme/acme-web', issueNumber: 142, ts: now - 94000 })
  convo(a.id, { t: 'turn-start', ts: now - 93000 })
  const demoTodos = [
    { content: 'Reproduce the redirect loop in Safari', status: 'completed' as const },
    { content: 'Inspect session cookie flags in auth middleware', status: 'completed' as const },
    { content: 'Patch SameSite handling for cross-site callback', status: 'in_progress' as const, activeForm: 'Patching SameSite handling' },
    { content: 'Verify login flow in the shared browser', status: 'pending' as const },
    { content: 'Run the auth test suite', status: 'pending' as const }
  ]
  convo(a.id, {
    t: 'assistant', id: 'demo-a1', chain: null,
    parts: [{ type: 'text', text: 'Reading the issue, this smells like a cookie `SameSite` problem — Safari drops the session cookie on the cross-site redirect back from the auth provider. Let me confirm in the auth middleware.' }],
    toolUses: [{ id: 'tool-todo-1', name: 'TodoWrite', input: { todos: demoTodos } }],
    ts: now - 90000
  })
  convo(a.id, { t: 'tool-result', toolUseId: 'tool-todo-1', ok: true, content: 'Todos updated', ts: now - 89500 })
  convo(a.id, { t: 'todos', todos: demoTodos, ts: now - 89000 })
  convo(a.id, {
    t: 'assistant', id: 'demo-a2', chain: null, parts: [],
    toolUses: [{ id: 'tool-read-1', name: 'Read', input: { file_path: '/Users/dev/acme-web/src/middleware/auth.ts' } }],
    ts: now - 80000
  })
  convo(a.id, { t: 'tool-result', toolUseId: 'tool-read-1', ok: true, content: 'export function sessionCookie(res: Response) {\n  res.cookie("acme_session", token, {\n    httpOnly: true,\n    sameSite: "strict",\n    secure: true,\n  })\n}', ts: now - 79000 })
  convo(a.id, {
    t: 'assistant', id: 'demo-a3', chain: null,
    parts: [{ type: 'text', text: 'Found it — `sameSite: "strict"` drops the cookie on the OAuth callback redirect. Switching to `lax`, which still protects POSTs but survives top-level navigations.' }],
    toolUses: [{
      id: 'tool-edit-1', name: 'Edit',
      input: {
        file_path: '/Users/dev/acme-web/src/middleware/auth.ts',
        old_string: '    httpOnly: true,\n    sameSite: "strict",\n    secure: true,',
        new_string: '    httpOnly: true,\n    sameSite: "lax",\n    secure: true,'
      }
    }],
    ts: now - 60000
  })
  convo(a.id, { t: 'tool-result', toolUseId: 'tool-edit-1', ok: true, content: 'The file /Users/dev/acme-web/src/middleware/auth.ts has been updated.', ts: now - 58000 })
  convo(a.id, {
    t: 'assistant', id: 'demo-a4', chain: null, parts: [],
    toolUses: [{ id: 'tool-bash-1', name: 'Bash', input: { command: 'npm run dev', description: 'Restart the dev server' } }],
    ts: now - 45000
  })
  convo(a.id, { t: 'tool-result', toolUseId: 'tool-bash-1', ok: true, content: '> acme-web@2.4.1 dev\n> next dev\n\n▲ Ready on http://localhost:3000', ts: now - 41000 })
  convo(a.id, {
    t: 'assistant', id: 'demo-a5', chain: null, parts: [],
    toolUses: [{ id: 'tool-pw-1', name: 'mcp__playwright__browser_navigate', input: { url: 'http://localhost:3000/pricing' } }],
    ts: now - 30000
  })
  convo(a.id, { t: 'tool-result', toolUseId: 'tool-pw-1', ok: true, content: 'Navigated to http://localhost:3000/pricing', ts: now - 28000 })
  convo(a.id, { t: 'text-start', kind: 'text', ts: now - 5000 })
  convo(a.id, { t: 'text-delta', kind: 'text', delta: 'Dev server is up and the pricing page loads in the shared browser. Now walking through the full login flow to confirm the redirect lands back on ' })

  // Session B — waiting on a permission
  convo(b.id, { t: 'user', text: 'Add a CSV export button to the monthly report page. Stream the download, don\'t buffer the whole file.', ts: now - 200000 })
  convo(b.id, { t: 'turn-start', ts: now - 199000 })
  convo(b.id, {
    t: 'assistant', id: 'demo-b1', chain: null,
    parts: [{ type: 'text', text: 'Plan: add a `/reports/:id/export.csv` endpoint that streams rows with a cursor, then wire a button into the report toolbar. Starting with the endpoint and a test.' }],
    toolUses: [{ id: 'tool-write-b', name: 'Write', input: { file_path: '/Users/dev/reports-service/src/routes/export.ts', content: 'import { Router } from "express"\n// …40 more lines' } }],
    ts: now - 190000
  })
  convo(b.id, { t: 'tool-result', toolUseId: 'tool-write-b', ok: true, content: 'File created successfully.', ts: now - 188000 })
  convo(b.id, {
    t: 'permission-request',
    req: {
      id: 'demo-perm-1', sessionId: b.id, toolName: 'Bash',
      input: { command: 'npm test -- --filter export', description: 'Run the export endpoint tests' },
      title: 'Claude wants to run: npm test -- --filter export',
      displayName: 'Run shell command', isPlan: false, ts: now - 12000
    }
  })

  // Session C — finished turn
  convo(c.id, { t: 'user', text: 'Move CLI settings from scattered JSON files into a single ~/.config/devtools/config.toml with migration.', ts: now - 1000000 })
  convo(c.id, { t: 'turn-start', ts: now - 999000 })
  convo(c.id, {
    t: 'assistant', id: 'demo-c1', chain: null,
    parts: [{ type: 'text', text: 'Done. Consolidated 4 JSON files into `config.toml`, added a one-shot migration on first run, and kept a `--legacy-config` escape hatch.\n\n- `src/config.rs` — new TOML loader with serde\n- `src/migrate.rs` — copies old values, backs up originals\n- tests cover fresh installs and both migration paths' }],
    toolUses: [],
    ts: now - 940000
  })
  convo(c.id, { t: 'turn-end', ts: now - 935000, stats: { ok: true, costUsd: 0.0455, durationMs: 64000, numTurns: 9, inputTokens: 48211, outputTokens: 3120 } })
  store.updateSession(c.id, { status: 'done' })

  broadcast({ kind: 'sessions', sessions: store.listSessions() })
}
