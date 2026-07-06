import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'
import type {
  GithubLink,
  PermissionModeId,
  SessionRow,
  SessionStatus,
  Settings,
  TitleSource
} from '../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  defaultWorkingDir: '',
  defaultModel: null,
  defaultPermissionMode: 'default',
  allowedOrigins: '',
  browserSafetyAcked: false,
  chromePath: '',
  sendOnEnter: true,
  notifications: true,
  permissionRules: []
}

interface Backend {
  exec(sql: string): void
  run(sql: string, ...params: unknown[]): void
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined
}

/** node:sqlite backend (Electron's bundled Node ≥22 ships it). */
function sqliteBackend(file: string): Backend {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file)
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params)
  }
}

/**
 * JSON-file fallback with the same surface the Store needs. Only used when
 * node:sqlite is unavailable; data shape mirrors the SQLite schema.
 */
function jsonBackend(file: string): Backend {
  interface Data {
    sessions: Record<string, unknown>[]
    github_links: Record<string, unknown>[]
    settings: Record<string, string>
  }
  const empty: Data = { sessions: [], github_links: [], settings: {} }
  let data: Data = empty
  if (file !== ':memory:' && existsSync(file)) {
    try {
      data = { ...empty, ...JSON.parse(readFileSync(file, 'utf8')) }
    } catch {
      data = empty
    }
  }
  const save = () => {
    if (file === ':memory:') return
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file)
  }
  // A micro interpreter for exactly the queries Store issues.
  return {
    exec: () => {},
    run: (sql, ...p) => {
      if (sql.startsWith('INSERT INTO sessions')) {
        data.sessions.push({
          id: p[0], claude_session_id: p[1], title: p[2], title_source: p[3], working_dir: p[4],
          status: p[5], model: p[6], permission_mode: p[7], browser_enabled: p[8],
          first_prompt_sent: p[9], total_cost_usd: p[10], created_at: p[11], updated_at: p[12]
        })
      } else if (sql.startsWith('UPDATE sessions SET')) {
        // generic single-row update: last param is id
        const id = p[p.length - 1]
        const row = data.sessions.find((s) => s.id === id)
        if (row) {
          const cols = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1])
          cols.forEach((c, i) => (row[c] = p[i]))
        }
      } else if (sql.startsWith('DELETE FROM sessions')) {
        data.sessions = data.sessions.filter((s) => s.id !== p[0])
      } else if (sql.startsWith('INSERT OR REPLACE INTO github_links')) {
        data.github_links = data.github_links.filter((l) => l.session_id !== p[0])
        data.github_links.push({
          session_id: p[0], repo: p[1], issue_number: p[2], issue_title: p[3],
          state: p[4], url: p[5], context_injected: p[6]
        })
      } else if (sql.startsWith('UPDATE github_links')) {
        const row = data.github_links.find((l) => l.session_id === p[p.length - 1])
        if (row) row.context_injected = p[0]
      } else if (sql.startsWith('DELETE FROM github_links')) {
        data.github_links = data.github_links.filter((l) => l.session_id !== p[0])
      } else if (sql.startsWith('INSERT OR REPLACE INTO settings')) {
        data.settings[String(p[0])] = String(p[1])
      }
      save()
    },
    all: (sql) => {
      if (sql.includes('FROM sessions')) {
        return [...data.sessions].sort(
          (a, b) => Number(b.updated_at) - Number(a.updated_at)
        ) as never
      }
      if (sql.includes('FROM github_links')) return data.github_links as never
      if (sql.includes('FROM settings')) {
        return Object.entries(data.settings).map(([key, value]) => ({ key, value })) as never
      }
      return []
    },
    get: (sql, ...p) => {
      if (sql.includes('FROM sessions')) return data.sessions.find((s) => s.id === p[0]) as never
      if (sql.includes('FROM github_links')) {
        return data.github_links.find((l) => l.session_id === p[0]) as never
      }
      if (sql.includes('FROM settings')) {
        const v = data.settings[String(p[0])]
        return v === undefined ? undefined : ({ value: v } as never)
      }
      return undefined
    }
  }
}

export class Store {
  private db: Backend
  readonly backendName: string
  private lastCreateTs = 0

  constructor(dir: string) {
    const inMemory = dir === ':memory:'
    if (!inMemory) mkdirSync(dir, { recursive: true })
    try {
      this.db = sqliteBackend(inMemory ? ':memory:' : path.join(dir, 'cockpit.db'))
      this.backendName = 'sqlite'
    } catch (e) {
      console.warn('node:sqlite unavailable, using JSON store:', e)
      this.db = jsonBackend(inMemory ? ':memory:' : path.join(dir, 'cockpit.json'))
      this.backendName = 'json'
    }
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL,
        working_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        permission_mode TEXT NOT NULL,
        browser_enabled INTEGER NOT NULL DEFAULT 0,
        first_prompt_sent INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_links (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_title TEXT NOT NULL,
        state TEXT NOT NULL,
        url TEXT NOT NULL,
        context_injected INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    // Sessions that were live when the app last quit are not live anymore.
    this.db.run(
      `UPDATE sessions SET status = ? WHERE id IN (SELECT id FROM sessions WHERE status IN ('running','waiting'))`,
      'idle'
    )
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  private rowToSession(r: Record<string, unknown>): SessionRow {
    return {
      id: String(r.id),
      claudeSessionId: (r.claude_session_id as string | null) || null,
      title: String(r.title),
      titleSource: String(r.title_source) as TitleSource,
      workingDir: String(r.working_dir),
      status: String(r.status) as SessionStatus,
      model: (r.model as string | null) || null,
      permissionMode: String(r.permission_mode) as PermissionModeId,
      browserEnabled: !!Number(r.browser_enabled),
      firstPromptSent: !!Number(r.first_prompt_sent),
      totalCostUsd: Number(r.total_cost_usd) || 0,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      link: this.getLink(String(r.id))
    }
  }

  listSessions(): SessionRow[] {
    return this.db
      .all(`SELECT * FROM sessions ORDER BY updated_at DESC`)
      .map((r) => this.rowToSession(r))
  }

  getSession(id: string): SessionRow | null {
    const r = this.db.get(`SELECT * FROM sessions WHERE id = ?`, id)
    return r ? this.rowToSession(r) : null
  }

  createSession(opts: {
    workingDir: string
    model: string | null
    permissionMode: PermissionModeId
    browserEnabled: boolean
  }): SessionRow {
    // Monotonic so rapid creations keep a stable sidebar order.
    const now = Math.max(Date.now(), this.lastCreateTs + 1)
    this.lastCreateTs = now
    const id = randomUUID()
    this.db.run(
      `INSERT INTO sessions (id, claude_session_id, title, title_source, working_dir, status, model, permission_mode, browser_enabled, first_prompt_sent, total_cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, null, 'Untitled session', 'default', opts.workingDir, 'idle',
      opts.model, opts.permissionMode, opts.browserEnabled ? 1 : 0, 0, 0, now, now
    )
    return this.getSession(id)!
  }

  updateSession(
    id: string,
    patch: Partial<{
      claudeSessionId: string | null
      title: string
      titleSource: TitleSource
      status: SessionStatus
      model: string | null
      permissionMode: PermissionModeId
      browserEnabled: boolean
      firstPromptSent: boolean
      totalCostUsd: number
    }>
  ): SessionRow | null {
    const colMap: Record<string, string> = {
      claudeSessionId: 'claude_session_id',
      title: 'title',
      titleSource: 'title_source',
      status: 'status',
      model: 'model',
      permissionMode: 'permission_mode',
      browserEnabled: 'browser_enabled',
      firstPromptSent: 'first_prompt_sent',
      totalCostUsd: 'total_cost_usd'
    }
    const sets: string[] = []
    const params: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      const col = colMap[k]
      if (!col) continue
      sets.push(`${col} = ?`)
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
    }
    sets.push(`updated_at = ?`)
    params.push(Date.now())
    params.push(id)
    this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params)
    return this.getSession(id)
  }

  deleteSession(id: string): void {
    this.db.run(`DELETE FROM github_links WHERE session_id = ?`, id)
    this.db.run(`DELETE FROM sessions WHERE id = ?`, id)
  }

  // ── github links ──────────────────────────────────────────────────────────

  getLink(sessionId: string): GithubLink | null {
    const r = this.db.get(`SELECT * FROM github_links WHERE session_id = ?`, sessionId)
    if (!r) return null
    return {
      sessionId: String(r.session_id),
      repo: String(r.repo),
      issueNumber: Number(r.issue_number),
      issueTitle: String(r.issue_title),
      state: String(r.state) as 'open' | 'closed',
      url: String(r.url),
      contextInjected: !!Number(r.context_injected)
    }
  }

  setLink(link: GithubLink): void {
    this.db.run(
      `INSERT OR REPLACE INTO github_links (session_id, repo, issue_number, issue_title, state, url, context_injected)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      link.sessionId, link.repo, link.issueNumber, link.issueTitle,
      link.state, link.url, link.contextInjected ? 1 : 0
    )
  }

  markContextInjected(sessionId: string): void {
    this.db.run(`UPDATE github_links SET context_injected = ? WHERE session_id = ?`, 1, sessionId)
  }

  removeLink(sessionId: string): void {
    this.db.run(`DELETE FROM github_links WHERE session_id = ?`, sessionId)
  }

  // ── settings ──────────────────────────────────────────────────────────────

  getSettings(): Settings {
    const out = { ...DEFAULT_SETTINGS }
    for (const row of this.db.all<{ key: string; value: string }>(`SELECT key, value FROM settings`)) {
      try {
        ;(out as Record<string, unknown>)[row.key] = JSON.parse(row.value)
      } catch {
        /* skip bad row */
      }
    }
    return out
  }

  setSettings(patch: Partial<Settings>): Settings {
    for (const [k, v] of Object.entries(patch)) {
      this.db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, k, JSON.stringify(v))
    }
    return this.getSettings()
  }
}
