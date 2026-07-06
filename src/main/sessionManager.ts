import type {
  ConvoEvent,
  CockpitEvent,
  CreateSessionOpts,
  GithubLink,
  PermissionDecision,
  PermissionModeId,
  PermissionRequest,
  PromptImage,
  SessionRow,
  SessionStatus,
  TurnStats
} from '../shared/types'
import { parseIssueRefs } from '../shared/issueRefs'
import { issueTitle, proposeTitle } from '../shared/titleResolve'
import { AgentSession } from './bridge'
import { BrowserManager } from './browserManager'
import { buildIssueContext, inferRepo, resolveIssue } from './github'
import { Store } from './store'
import { generateTitle } from './titleService'
import { loadTranscriptEvents } from './transcripts'

interface PendingPermission {
  req: PermissionRequest
  resolve: (d: PermissionDecision) => void
}

interface QueuedPrompt {
  text: string
  images?: PromptImage[]
}

interface LiveSession {
  agent: AgentSession | null
  queue: QueuedPrompt[]
  pendingPerms: Map<string, PendingPermission>
  turnActive: boolean
  lastResultCost: number
  interrupting: boolean
  sending: boolean
}

export class SessionManager {
  private live = new Map<string, LiveSession>()
  /** Sessions whose next agent start should fork the resumed Claude session. */
  private forkPending = new Set<string>()

  constructor(
    private store: Store,
    private browsers: BrowserManager,
    private broadcast: (e: CockpitEvent) => void
  ) {}

  // ── helpers ───────────────────────────────────────────────────────────────

  private emitConvo(sessionId: string, ev: ConvoEvent): void {
    this.broadcast({ kind: 'convo', sessionId, ev })
  }

  private emitRow(row: SessionRow | null): void {
    if (row) this.broadcast({ kind: 'session-updated', session: row })
  }

  private liveFor(sessionId: string): LiveSession {
    let l = this.live.get(sessionId)
    if (!l) {
      l = {
        agent: null,
        queue: [],
        pendingPerms: new Map(),
        turnActive: false,
        lastResultCost: 0,
        interrupting: false,
        sending: false
      }
      this.live.set(sessionId, l)
    }
    return l
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const row = this.store.getSession(sessionId)
    if (!row || row.status === status) return
    this.emitRow(this.store.updateSession(sessionId, { status }))
  }

  // ── session CRUD ──────────────────────────────────────────────────────────

  listSessions(): SessionRow[] {
    return this.store.listSessions()
  }

  createSession(opts: CreateSessionOpts): SessionRow {
    const row = this.store.createSession(opts)
    this.emitRow(row)
    return row
  }

  /**
   * Branch a session: same repo/model/history, but the next turn continues in
   * a *forked* Claude session — try a second approach without losing the first.
   */
  forkSession(sessionId: string): SessionRow | null {
    const src = this.store.getSession(sessionId)
    if (!src) return null
    const row = this.store.createSession({
      workingDir: src.workingDir,
      model: src.model,
      permissionMode: src.permissionMode,
      browserEnabled: src.browserEnabled
    })
    this.store.updateSession(row.id, {
      title: `${src.title} · fork`.slice(0, 120),
      titleSource: src.titleSource === 'default' ? 'default' : 'manual',
      claudeSessionId: src.claudeSessionId,
      firstPromptSent: src.firstPromptSent
    })
    if (src.link) {
      this.store.setLink({ ...src.link, sessionId: row.id })
    }
    if (src.claudeSessionId) this.forkPending.add(row.id)
    const fresh = this.store.getSession(row.id)
    this.emitRow(fresh)
    return fresh
  }

  deleteSession(sessionId: string): void {
    const l = this.live.get(sessionId)
    if (l) {
      for (const p of l.pendingPerms.values()) p.resolve({ behavior: 'deny', message: 'Session closed' })
      l.pendingPerms.clear()
      l.agent?.close()
      this.live.delete(sessionId)
    }
    this.browsers.deleteProfile(sessionId)
    this.store.deleteSession(sessionId)
    this.broadcast({ kind: 'session-removed', sessionId })
  }

  renameSession(sessionId: string, title: string): void {
    const clean = title.trim()
    if (!clean) return
    this.emitRow(this.store.updateSession(sessionId, { title: clean.slice(0, 120), titleSource: 'manual' }))
  }

  async setModel(sessionId: string, model: string | null): Promise<void> {
    this.emitRow(this.store.updateSession(sessionId, { model }))
    await this.live.get(sessionId)?.agent?.setModel(model)
  }

  async setPermissionMode(sessionId: string, mode: PermissionModeId): Promise<void> {
    this.emitRow(this.store.updateSession(sessionId, { permissionMode: mode }))
    await this.live.get(sessionId)?.agent?.setPermissionMode(mode)
  }

  async setBrowserEnabled(sessionId: string, enabled: boolean): Promise<void> {
    this.emitRow(this.store.updateSession(sessionId, { browserEnabled: enabled }))
    const l = this.liveFor(sessionId)
    if (enabled) {
      const cfg = await this.browsers.mcpServerConfig(sessionId, this.store.getSettings().allowedOrigins)
      await l.agent?.setMcpServers(cfg).catch(() => {})
      void this.browsers.ensure(sessionId).catch(() => {})
    } else {
      await l.agent?.setMcpServers({}).catch(() => {})
      this.browsers.close(sessionId)
    }
  }

  // ── the agent lifecycle ───────────────────────────────────────────────────

  private async ensureAgent(row: SessionRow): Promise<AgentSession> {
    const l = this.liveFor(row.id)
    if (l.agent) return l.agent

    const mcpServers = row.browserEnabled
      ? await this.browsers.mcpServerConfig(row.id, this.store.getSettings().allowedOrigins)
      : null

    const sessionId = row.id
    l.lastResultCost = 0
    const agent = new AgentSession(
      {
        sessionId,
        cwd: row.workingDir,
        model: row.model,
        permissionMode: row.permissionMode,
        resume: row.claudeSessionId,
        fork: this.forkPending.has(row.id),
        preAllowed: this.store
          .getSettings()
          .permissionRules.filter((r) => r.dir === row.workingDir || r.dir === '')
          .map((r) => r.tool),
        mcpServers
      },
      {
        onEvent: (ev) => this.emitConvo(sessionId, ev),
        onClaudeSession: (claudeSessionId) => {
          this.forkPending.delete(sessionId) // the fork happened; new id is ours
          const cur = this.store.getSession(sessionId)
          if (cur && cur.claudeSessionId !== claudeSessionId) {
            this.emitRow(this.store.updateSession(sessionId, { claudeSessionId }))
          }
        },
        onState: (state) => {
          const l2 = this.live.get(sessionId)
          if (state === 'running') this.setStatus(sessionId, 'running')
          else if (state === 'requires_action') this.setStatus(sessionId, 'waiting')
          else if (state === 'idle' && l2 && !l2.turnActive) {
            const cur = this.store.getSession(sessionId)
            if (cur && cur.status === 'running') this.setStatus(sessionId, 'done')
          }
        },
        onResult: (stats) => this.onResult(sessionId, stats),
        onExit: (err) => this.onAgentExit(sessionId, err),
        requestPermission: (req, signal) => this.onPermissionRequest(sessionId, req, signal),
        ensureBrowser: () => this.browsers.ensure(sessionId),
        persistAllow: (toolName) => {
          const rules = this.store.getSettings().permissionRules
          const dir = this.store.getSession(sessionId)?.workingDir ?? ''
          if (!rules.some((r) => r.tool === toolName && r.dir === dir)) {
            this.store.setSettings({
              permissionRules: [...rules, { tool: toolName, dir, createdAt: Date.now() }]
            })
          }
        }
      }
    )
    l.agent = agent
    await agent.start()
    if (row.browserEnabled) void this.browsers.ensure(sessionId).catch(() => {})
    return agent
  }

  private onResult(sessionId: string, stats: TurnStats): void {
    const l = this.liveFor(sessionId)
    const wasInterrupting = l.interrupting
    l.interrupting = false
    l.turnActive = false

    const row = this.store.getSession(sessionId)
    if (row) {
      const delta = Math.max(0, stats.costUsd - l.lastResultCost)
      l.lastResultCost = stats.costUsd
      this.emitRow(
        this.store.updateSession(sessionId, {
          totalCostUsd: row.totalCostUsd + delta,
          status: stats.ok ? 'done' : 'error'
        })
      )
    }
    this.emitConvo(sessionId, {
      t: 'turn-end',
      ts: Date.now(),
      stats: { ...stats, interrupted: wasInterrupting }
    })

    const next = l.queue.shift()
    if (next !== undefined) {
      this.emitConvo(sessionId, { t: 'queue', pending: l.queue.map((q) => q.text) })
      void this.sendPrompt(sessionId, next.text, next.images)
    }
  }

  private onAgentExit(sessionId: string, err?: Error): void {
    const l = this.live.get(sessionId)
    if (!l) return
    l.agent = null
    const hadTurn = l.turnActive
    l.turnActive = false
    for (const p of l.pendingPerms.values()) p.resolve({ behavior: 'deny', message: 'Agent stopped' })
    l.pendingPerms.clear()

    const row = this.store.getSession(sessionId)
    if (!row) return
    if (err) {
      this.emitConvo(sessionId, {
        t: 'banner',
        level: 'error',
        text: `Agent process ended unexpectedly: ${err.message}`,
        ts: Date.now()
      })
      this.setStatus(sessionId, 'error')
    } else if (hadTurn || row.status === 'running' || row.status === 'waiting') {
      this.setStatus(sessionId, 'idle')
    }
  }

  private onPermissionRequest(
    sessionId: string,
    req: PermissionRequest,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    const l = this.liveFor(sessionId)
    return new Promise<PermissionDecision>((resolve) => {
      const finish = (d: PermissionDecision): void => {
        if (!l.pendingPerms.has(req.id)) return
        l.pendingPerms.delete(req.id)
        this.emitConvo(sessionId, { t: 'permission-resolved', requestId: req.id, behavior: d.behavior })
        if (l.turnActive && l.pendingPerms.size === 0) this.setStatus(sessionId, 'running')
        resolve(d)
      }
      l.pendingPerms.set(req.id, { req, resolve: finish })
      this.emitConvo(sessionId, { t: 'permission-request', req })
      this.setStatus(sessionId, 'waiting')
      signal.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Interrupted by user' }), {
        once: true
      })
    })
  }

  respondPermission(sessionId: string, requestId: string, decision: PermissionDecision): void {
    if (decision.setMode) {
      this.emitRow(this.store.updateSession(sessionId, { permissionMode: decision.setMode }))
    }
    this.live.get(sessionId)?.pendingPerms.get(requestId)?.resolve(decision)
  }

  // ── prompts ───────────────────────────────────────────────────────────────

  async sendPrompt(sessionId: string, text: string, images?: PromptImage[]): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed && !images?.length) return
    const row = this.store.getSession(sessionId)
    if (!row) return
    const l = this.liveFor(sessionId)

    if (l.turnActive || l.sending) {
      l.queue.push({ text: trimmed, images })
      this.emitConvo(sessionId, { t: 'queue', pending: l.queue.map((q) => q.text) })
      return
    }

    l.sending = true
    try {
      this.emitConvo(sessionId, {
        t: 'user',
        text: trimmed,
        ts: Date.now(),
        images: images?.map((i) => `data:${i.mediaType};base64,${i.data}`)
      })

      // First prompt: kick off async titling (never blocks the agent).
      if (!row.firstPromptSent) {
        this.emitRow(this.store.updateSession(sessionId, { firstPromptSent: true }))
        if (row.titleSource === 'default' && trimmed) this.titleAsync(sessionId, trimmed)
      }

      // Issue linking: detect refs, resolve, inject context ahead of the prompt.
      let prompt = trimmed
      try {
        const context = await this.prepareIssueContext(sessionId, row, trimmed)
        if (context) prompt = `${context}\n\n${trimmed}`
      } catch {
        /* linking is best-effort; never block the prompt */
      }

      const fresh = this.store.getSession(sessionId) ?? row
      const agent = await this.ensureAgent(fresh)
      l.turnActive = true
      this.emitConvo(sessionId, { t: 'turn-start', ts: Date.now() })
      this.setStatus(sessionId, 'running')
      agent.send(prompt, images)
    } catch (e) {
      l.turnActive = false
      this.emitConvo(sessionId, {
        t: 'banner',
        level: 'error',
        text: `Could not start the agent: ${e instanceof Error ? e.message : String(e)}`,
        ts: Date.now()
      })
      this.setStatus(sessionId, 'error')
    } finally {
      l.sending = false
    }
  }

  cancelQueued(sessionId: string, index: number): void {
    const l = this.live.get(sessionId)
    if (!l) return
    l.queue.splice(index, 1)
    this.emitConvo(sessionId, { t: 'queue', pending: l.queue.map((q) => q.text) })
  }

  private titleAsync(sessionId: string, prompt: string): void {
    void generateTitle(prompt)
      .then((title) => {
        const row = this.store.getSession(sessionId)
        if (!row) return
        const next = proposeTitle(row, { title, source: 'ai' })
        if (next) this.emitRow(this.store.updateSession(sessionId, next))
      })
      .catch(() => {})
  }

  /**
   * Returns the issue context block to prepend, when a linked (or newly
   * detected) issue hasn't had its body injected into the session yet.
   */
  private async prepareIssueContext(sessionId: string, row: SessionRow, text: string): Promise<string | null> {
    let link = this.store.getLink(sessionId)

    if (!link) {
      const refs = parseIssueRefs(text)
      if (refs.length === 0) return null
      const ref = refs[0]
      const repo = ref.repo ?? (await inferRepo(row.workingDir))
      if (!repo) return null
      this.emitConvo(sessionId, { t: 'spinner', detail: 'linking issue' })
      const issue = await resolveIssue(repo, ref.number)
      this.emitConvo(sessionId, { t: 'spinner', detail: null })
      if (!issue) return null
      link = this.applyLink(sessionId, issue.repo, issue.number, issue.title, issue.state, issue.url, false)
      const context = buildIssueContext(issue)
      this.store.markContextInjected(sessionId)
      this.emitRow(this.store.getSession(sessionId))
      this.emitConvo(sessionId, { t: 'issue-context', repo: issue.repo, issueNumber: issue.number, ts: Date.now() })
      return context
    }

    if (!link.contextInjected) {
      const issue = await resolveIssue(link.repo, link.issueNumber)
      if (!issue) return null
      this.store.markContextInjected(sessionId)
      this.emitRow(this.store.getSession(sessionId))
      this.emitConvo(sessionId, { t: 'issue-context', repo: link.repo, issueNumber: link.issueNumber, ts: Date.now() })
      return buildIssueContext(issue)
    }
    return null
  }

  private applyLink(
    sessionId: string,
    repo: string,
    issueNumber: number,
    title: string,
    state: 'open' | 'closed',
    url: string,
    contextInjected: boolean
  ): GithubLink {
    const link: GithubLink = { sessionId, repo, issueNumber, issueTitle: title, state, url, contextInjected }
    this.store.setLink(link)
    const row = this.store.getSession(sessionId)
    if (row) {
      const next = proposeTitle(row, { title: issueTitle(link), source: 'issue' })
      if (next) this.store.updateSession(sessionId, next)
    }
    this.emitRow(this.store.getSession(sessionId))
    return link
  }

  async linkIssue(sessionId: string, refText: string): Promise<{ link?: GithubLink; error?: string }> {
    const row = this.store.getSession(sessionId)
    if (!row) return { error: 'Session not found' }
    const refs = parseIssueRefs(refText.trim())
    if (refs.length === 0) return { error: 'No issue reference found. Try #123, owner/repo#123, or a GitHub URL.' }
    const ref = refs[0]
    const repo = ref.repo ?? (await inferRepo(row.workingDir))
    if (!repo) return { error: 'Could not infer the repository — use owner/repo#123 or a full URL.' }
    const issue = await resolveIssue(repo, ref.number)
    if (!issue) return { error: `Could not fetch ${repo}#${ref.number}. Check the number, or run \`gh auth login\` for private repos.` }
    const link = this.applyLink(sessionId, issue.repo, issue.number, issue.title, issue.state, issue.url, false)
    return { link }
  }

  unlinkIssue(sessionId: string): void {
    this.store.removeLink(sessionId)
    const row = this.store.getSession(sessionId)
    if (row && row.titleSource === 'issue') {
      this.store.updateSession(sessionId, { title: 'Untitled session', titleSource: 'default' })
    }
    this.emitRow(this.store.getSession(sessionId))
  }

  // ── misc ──────────────────────────────────────────────────────────────────

  async interrupt(sessionId: string): Promise<void> {
    const l = this.live.get(sessionId)
    if (!l) return
    l.interrupting = true
    for (const p of [...l.pendingPerms.values()]) {
      p.resolve({ behavior: 'deny', message: 'Interrupted by user' })
    }
    await l.agent?.interrupt()
  }

  loadHistory(sessionId: string): void {
    const row = this.store.getSession(sessionId)
    if (!row?.claudeSessionId) return
    const events = loadTranscriptEvents(row.workingDir, row.claudeSessionId)
    if (events.length) this.emitConvo(sessionId, { t: 'history', events })
  }

  shutdown(): void {
    for (const [id, l] of this.live) {
      for (const p of l.pendingPerms.values()) p.resolve({ behavior: 'deny', message: 'App quitting' })
      l.agent?.close()
      this.live.delete(id)
    }
    this.browsers.closeAll()
  }
}
