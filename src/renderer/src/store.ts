import { useSyncExternalStore } from 'react'
import type {
  AssistantPart,
  BrowserEvent,
  BrowserTab,
  CockpitEvent,
  ConvoEvent,
  CreateSessionOpts,
  GithubLink,
  PermissionDecision,
  PermissionModeId,
  PermissionRequest,
  PreflightCheck,
  SessionRow,
  Settings,
  TodoItem,
  TurnStats,
  UiCommand
} from '../../shared/types'

// ── conversation view model ───────────────────────────────────────────────────

export interface ToolView {
  id: string
  name: string
  input: unknown
  result?: string
  ok?: boolean
  running: boolean
  ts: number
  children: ConvoItem[]
  task?: { description: string; summary?: string; lastTool?: string; totalTokens?: number; done?: boolean }
}

export type ConvoItem =
  | { k: 'user'; key: string; text: string; ts: number }
  | { k: 'context'; key: string; repo: string; n: number; ts: number }
  | { k: 'msg'; key: string; parts: AssistantPart[]; streaming: boolean; ts: number }
  | { k: 'tool'; key: string; tool: ToolView; ts: number }
  | { k: 'perm'; key: string; req: PermissionRequest; resolved?: 'allow' | 'deny'; ts: number }
  | { k: 'turn'; key: string; stats: TurnStats; ts: number }
  | { k: 'banner'; key: string; level: 'info' | 'error'; text: string; ts: number }

export interface ConvoState {
  items: ConvoItem[]
  tools: Map<string, ToolView>
  todos: TodoItem[]
  spinner: string | null
  queue: string[]
  raw: { line: string; ts: number }[]
  model: string | null
  historyLoaded: boolean
  turnStartTs: number | null
  lastStats: TurnStats | null
  streaming: boolean
}

export interface BrowserUiState {
  running: boolean
  starting: boolean
  url: string
  tabs: BrowserTab[]
  activeTabId: string | null
  error: string | null
  frame: { dataUrl: string; w: number; h: number } | null
}

export interface Toast {
  id: number
  level: 'info' | 'error'
  message: string
}

export type Modal =
  | null
  | { m: 'new-session' }
  | { m: 'settings' }
  | { m: 'delete-session'; id: string }
  | { m: 'browser-safety'; id: string }
  | { m: 'link-issue'; id: string }

export type View = { kind: 'welcome' } | { kind: 'board' } | { kind: 'session'; id: string }

export interface AppState {
  booted: boolean
  sessions: SessionRow[]
  view: View
  convos: Record<string, ConvoState>
  browsers: Record<string, BrowserUiState>
  browserPanel: Record<string, boolean>
  drawer: Record<string, boolean>
  settings: Settings | null
  preflight: PreflightCheck[] | null
  toasts: Toast[]
  modal: Modal
}

const emptyConvo = (): ConvoState => ({
  items: [],
  tools: new Map(),
  todos: [],
  spinner: null,
  queue: [],
  raw: [],
  model: null,
  historyLoaded: false,
  turnStartTs: null,
  lastStats: null,
  streaming: false
})

const emptyBrowser = (): BrowserUiState => ({
  running: false,
  starting: false,
  url: '',
  tabs: [],
  activeTabId: null,
  error: null,
  frame: null
})

let keyCounter = 0
const nextKey = (prefix: string): string => `${prefix}-${++keyCounter}`

// ── conversation reducer ──────────────────────────────────────────────────────

export function reduceConvo(c: ConvoState, ev: ConvoEvent): ConvoState {
  switch (ev.t) {
    case 'user':
      c.items.push({ k: 'user', key: nextKey('u'), text: ev.text, ts: ev.ts })
      break
    case 'issue-context':
      c.items.push({ k: 'context', key: nextKey('ctx'), repo: ev.repo, n: ev.issueNumber, ts: ev.ts })
      break
    case 'text-start': {
      const last = c.items[c.items.length - 1]
      if (last?.k === 'msg' && last.streaming) {
        last.parts = [...last.parts, { type: ev.kind, text: '' }]
      } else {
        c.items.push({
          k: 'msg',
          key: nextKey('m'),
          parts: [{ type: ev.kind, text: '' }],
          streaming: true,
          ts: ev.ts
        })
      }
      c.streaming = true
      break
    }
    case 'text-delta': {
      let last = c.items[c.items.length - 1]
      if (!(last?.k === 'msg' && last.streaming)) {
        last = { k: 'msg', key: nextKey('m'), parts: [{ type: ev.kind, text: '' }], streaming: true, ts: Date.now() }
        c.items.push(last)
      }
      const msg = last as Extract<ConvoItem, { k: 'msg' }>
      const part = msg.parts[msg.parts.length - 1]
      if (part && part.type === ev.kind) {
        msg.parts = [...msg.parts.slice(0, -1), { type: part.type, text: part.text + ev.delta }]
      } else {
        msg.parts = [...msg.parts, { type: ev.kind, text: ev.delta }]
      }
      c.streaming = true
      break
    }
    case 'assistant': {
      // Finalized message replaces the streaming placeholder (main chain only).
      if (ev.chain === null) {
        const lastIdx = c.items.length - 1
        if (c.items[lastIdx]?.k === 'msg' && (c.items[lastIdx] as { streaming?: boolean }).streaming) {
          c.items.pop()
        }
        c.streaming = false
      }
      const target = ev.chain ? c.tools.get(ev.chain)?.children : c.items
      const bucket = target ?? c.items
      if (ev.parts.length) {
        bucket.push({ k: 'msg', key: nextKey('m'), parts: ev.parts, streaming: false, ts: ev.ts })
      }
      for (const tu of ev.toolUses) {
        const tool: ToolView = {
          id: tu.id,
          name: tu.name,
          input: tu.input,
          running: true,
          ts: ev.ts,
          children: []
        }
        c.tools.set(tu.id, tool)
        bucket.push({ k: 'tool', key: `t-${tu.id}`, tool, ts: ev.ts })
      }
      break
    }
    case 'tool-result': {
      const tool = c.tools.get(ev.toolUseId)
      if (tool) {
        tool.running = false
        tool.ok = ev.ok
        tool.result = ev.content
      }
      break
    }
    case 'todos':
      c.todos = ev.todos
      break
    case 'task-progress': {
      const tool = ev.toolUseId ? c.tools.get(ev.toolUseId) : undefined
      if (tool) {
        tool.task = {
          description: ev.description,
          summary: ev.summary,
          lastTool: ev.lastTool,
          totalTokens: ev.totalTokens,
          done: ev.done
        }
      }
      break
    }
    case 'permission-request':
      c.items.push({ k: 'perm', key: `p-${ev.req.id}`, req: ev.req, ts: ev.req.ts })
      break
    case 'permission-resolved': {
      for (let i = c.items.length - 1; i >= 0; i--) {
        const it = c.items[i]
        if (it.k === 'perm' && it.req.id === ev.requestId) {
          it.resolved = ev.behavior
          break
        }
      }
      break
    }
    case 'turn-start':
      c.turnStartTs = ev.ts
      c.spinner = null
      break
    case 'turn-end':
      c.turnStartTs = null
      c.spinner = null
      c.streaming = false
      c.lastStats = ev.stats
      c.items.push({ k: 'turn', key: nextKey('turn'), stats: ev.stats, ts: ev.ts })
      break
    case 'spinner':
      c.spinner = ev.detail
      break
    case 'init':
      c.model = ev.model
      break
    case 'queue':
      c.queue = ev.pending
      break
    case 'banner':
      c.items.push({ k: 'banner', key: nextKey('b'), level: ev.level, text: ev.text, ts: ev.ts })
      break
    case 'history': {
      const fresh = emptyConvo()
      fresh.historyLoaded = true
      for (const sub of ev.events) reduceConvo(fresh, sub)
      // anything that streamed in while history loaded stays after it
      fresh.items.push(...c.items)
      for (const [k, v] of c.tools) fresh.tools.set(k, v)
      fresh.todos = c.todos.length ? c.todos : fresh.todos
      fresh.queue = c.queue
      fresh.turnStartTs = c.turnStartTs
      fresh.raw = c.raw
      return fresh
    }
    case 'raw':
      c.raw.push({ line: ev.line, ts: ev.ts })
      if (c.raw.length > 400) c.raw.splice(0, c.raw.length - 400)
      break
  }
  return c
}

// ── store ─────────────────────────────────────────────────────────────────────

const api = typeof window !== 'undefined' ? window.cockpit : (null as never)

class CockpitStore {
  state: AppState = {
    booted: false,
    sessions: [],
    view: { kind: 'welcome' },
    convos: {},
    browsers: {},
    browserPanel: {},
    drawer: {},
    settings: null,
    preflight: null,
    toasts: [],
    modal: null
  }

  private listeners = new Set<() => void>()
  private toastSeq = 0
  private deltaBuffer: { sessionId: string; ev: ConvoEvent }[] = []
  private deltaTimer: number | null = null

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): AppState => this.state

  private commit(): void {
    this.state = { ...this.state }
    for (const fn of this.listeners) fn()
  }

  // ── boot ────────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    api.onEvent((e) => this.handleEvent(e))
    const [sessions, settings] = await Promise.all([api.listSessions(), api.getSettings()])
    this.state.sessions = sortSessions(sessions)
    this.state.settings = settings
    this.state.booted = true

    const demoView = api.meta.demoView
    if (demoView === 'board') this.state.view = { kind: 'board' }
    else if (demoView === 'session' && sessions[0]) this.state.view = { kind: 'session', id: sessions[0].id }
    else if (sessions.length === 0) this.state.view = { kind: 'welcome' }
    else if (sessions.length === 1) this.state.view = { kind: 'session', id: sessions[0].id }
    else this.state.view = { kind: 'board' }
    this.commit()

    void api.uiReady()
    void api.preflight().then((p) => {
      this.state.preflight = p as PreflightCheck[]
      this.commit()
    })
  }

  // ── event ingestion ─────────────────────────────────────────────────────

  private handleEvent(e: CockpitEvent): void {
    switch (e.kind) {
      case 'sessions':
        this.state.sessions = sortSessions(e.sessions)
        if (e.sessions.length && this.state.view.kind === 'welcome') {
          const dv = api.meta.demoView
          if (dv?.startsWith('session')) {
            const idx = Math.min(Number(dv.split(':')[1] ?? 0) || 0, this.state.sessions.length - 1)
            this.state.view = { kind: 'session', id: this.state.sessions[idx].id }
          } else {
            this.state.view = { kind: 'board' }
          }
        }
        break
      case 'session-updated': {
        const idx = this.state.sessions.findIndex((s) => s.id === e.session.id)
        if (idx >= 0) {
          const next = [...this.state.sessions]
          next[idx] = e.session
          this.state.sessions = next
        } else {
          this.state.sessions = sortSessions([...this.state.sessions, e.session])
        }
        break
      }
      case 'session-removed': {
        this.state.sessions = this.state.sessions.filter((s) => s.id !== e.sessionId)
        delete this.state.convos[e.sessionId]
        delete this.state.browsers[e.sessionId]
        if (this.state.view.kind === 'session' && this.state.view.id === e.sessionId) {
          this.state.view = this.state.sessions.length ? { kind: 'board' } : { kind: 'welcome' }
        }
        break
      }
      case 'convo':
        if (e.ev.t === 'text-delta') {
          this.bufferDelta(e.sessionId, e.ev)
          return
        }
        this.flushDeltas(false)
        this.applyConvo(e.sessionId, e.ev)
        break
      case 'browser':
        this.applyBrowser(e.sessionId, e.ev)
        break
      case 'toast':
        this.pushToast(e.level, e.message)
        break
      case 'ui-command':
        this.handleUiCommand(e.command)
        break
    }
    this.commit()
  }

  /** Streaming deltas are batched to ~30fps so long outputs stay smooth. */
  private bufferDelta(sessionId: string, ev: ConvoEvent): void {
    this.deltaBuffer.push({ sessionId, ev })
    if (this.deltaTimer == null) {
      this.deltaTimer = window.setTimeout(() => this.flushDeltas(true), 33)
    }
  }

  private flushDeltas(commit: boolean): void {
    if (this.deltaTimer != null) {
      window.clearTimeout(this.deltaTimer)
      this.deltaTimer = null
    }
    if (!this.deltaBuffer.length) return
    const batch = this.deltaBuffer
    this.deltaBuffer = []
    for (const { sessionId, ev } of batch) this.applyConvo(sessionId, ev)
    if (commit) this.commit()
  }

  private applyConvo(sessionId: string, ev: ConvoEvent): void {
    const cur = this.state.convos[sessionId] ?? emptyConvo()
    const next = reduceConvo(cur, ev)
    this.state.convos = { ...this.state.convos, [sessionId]: { ...next, items: [...next.items] } }
  }

  private applyBrowser(sessionId: string, ev: BrowserEvent): void {
    const cur = this.state.browsers[sessionId] ?? emptyBrowser()
    let next: BrowserUiState
    if (ev.t === 'frame') {
      next = { ...cur, frame: { dataUrl: ev.dataUrl, w: ev.w, h: ev.h } }
    } else {
      next = {
        ...cur,
        running: ev.running,
        starting: ev.starting ?? false,
        url: ev.url ?? cur.url,
        tabs: ev.tabs ?? cur.tabs,
        activeTabId: ev.activeTabId ?? cur.activeTabId,
        error: ev.error ?? null,
        frame: ev.running || ev.starting ? cur.frame : null
      }
      if (ev.running && this.state.browserPanel[sessionId] === undefined) {
        this.state.browserPanel = { ...this.state.browserPanel, [sessionId]: true }
      }
      if (ev.error) this.pushToast('error', ev.error)
    }
    this.state.browsers = { ...this.state.browsers, [sessionId]: next }
  }

  private handleUiCommand(cmd: UiCommand): void {
    switch (cmd.c) {
      case 'new-session':
        this.state.modal = { m: 'new-session' }
        break
      case 'toggle-board':
        this.state.view = this.state.view.kind === 'board' && this.state.sessions.length
          ? this.state.view
          : { kind: 'board' }
        break
      case 'open-settings':
        this.state.modal = { m: 'settings' }
        break
      case 'select-session-index': {
        const s = this.state.sessions[cmd.index]
        if (s) this.selectSession(s.id)
        break
      }
    }
  }

  pushToast(level: 'info' | 'error', message: string): void {
    const id = ++this.toastSeq
    this.state.toasts = [...this.state.toasts, { id, level, message }]
    this.commit()
    window.setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((t) => t.id !== id)
      this.commit()
    }, 6000)
  }

  // ── actions ─────────────────────────────────────────────────────────────

  selectSession(id: string): void {
    this.state.view = { kind: 'session', id }
    const row = this.state.sessions.find((s) => s.id === id)
    const convo = this.state.convos[id]
    if (row?.firstPromptSent && row.claudeSessionId && !convo?.historyLoaded && !convo?.items.length) {
      this.applyConvo(id, { t: 'history', events: [] }) // mark as loaded; real events replace it
      void api.loadHistory(id)
    }
    this.commit()
  }

  showBoard(): void {
    this.state.view = { kind: 'board' }
    this.commit()
  }

  openModal(modal: Modal): void {
    this.state.modal = modal
    this.commit()
  }

  closeModal(): void {
    this.state.modal = null
    this.commit()
  }

  async createSession(opts: CreateSessionOpts): Promise<void> {
    const row = (await api.createSession(opts)) as SessionRow
    if (opts.browserEnabled) void api.browserOpen(row.id)
    this.state.modal = null
    this.selectSession(row.id)
  }

  async deleteSession(id: string): Promise<void> {
    this.state.modal = null
    this.commit()
    await api.deleteSession(id)
  }

  send(id: string, text: string): void {
    void api.sendPrompt(id, text)
  }

  interrupt(id: string): void {
    void api.interrupt(id)
  }

  cancelQueued(id: string, index: number): void {
    void api.cancelQueued(id, index)
  }

  respondPermission(sessionId: string, requestId: string, decision: PermissionDecision): void {
    void api.respondPermission(sessionId, requestId, decision)
  }

  rename(id: string, title: string): void {
    void api.renameSession(id, title)
  }

  setModel(id: string, model: string | null): void {
    void api.setModel(id, model)
  }

  setPermissionMode(id: string, mode: PermissionModeId): void {
    void api.setPermissionMode(id, mode)
  }

  toggleBrowser(id: string, enabled: boolean): void {
    if (enabled && this.state.settings && !this.state.settings.browserSafetyAcked) {
      this.openModal({ m: 'browser-safety', id })
      return
    }
    void api.setBrowserEnabled(id, enabled)
    if (enabled) {
      this.state.browserPanel = { ...this.state.browserPanel, [id]: true }
      this.commit()
    }
  }

  async ackBrowserSafety(id: string): Promise<void> {
    await this.saveSettings({ browserSafetyAcked: true })
    this.state.modal = null
    void api.setBrowserEnabled(id, true)
    this.state.browserPanel = { ...this.state.browserPanel, [id]: true }
    this.commit()
  }

  setBrowserPanel(id: string, open: boolean): void {
    this.state.browserPanel = { ...this.state.browserPanel, [id]: open }
    this.commit()
    if (open) void api.browserOpen(id)
  }

  setDrawer(id: string, open: boolean): void {
    this.state.drawer = { ...this.state.drawer, [id]: open }
    this.commit()
  }

  async linkIssue(id: string, ref: string): Promise<string | null> {
    const res = (await api.linkIssue(id, ref)) as { link?: GithubLink; error?: string }
    if (res.error) return res.error
    this.state.modal = null
    this.commit()
    return null
  }

  unlinkIssue(id: string): void {
    void api.unlinkIssue(id)
  }

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    this.state.settings = (await api.setSettings(patch)) as Settings
    this.commit()
  }

  async refreshPreflight(): Promise<void> {
    this.state.preflight = (await api.preflight()) as PreflightCheck[]
    this.commit()
  }
}

export const store = new CockpitStore()

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

function sortSessions(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => a.createdAt - b.createdAt)
}
