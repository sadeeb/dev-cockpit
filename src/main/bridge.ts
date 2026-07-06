import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AssistantPart,
  ConvoEvent,
  PermissionDecision,
  PermissionModeId,
  PermissionRequest,
  TodoItem,
  ToolUseStart,
  TurnStats
} from '../shared/types'
import { findNode, getFixedPath } from './env'

const COCKPIT_NOTE =
  'You are running inside Dev Cockpit, a desktop mission-control app that wraps Claude Code. ' +
  'The user watches your work live: the conversation, your task list, tool activity, and — when browser tools ' +
  '(mcp__playwright__*) are available — a shared live browser they can also drive. Keep the TodoWrite task list ' +
  'up to date on multi-step work; it powers the mission-control board.'

/** Async queue used as the streaming-input iterable for the SDK. */
class PushQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private waiters: ((v: IteratorResult<T>) => void)[] = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const w = this.waiters.shift()
    if (w) w({ value, done: false })
    else this.buffer.push(value)
  }

  end(): void {
    this.ended = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

export interface AgentSessionConfig {
  sessionId: string
  cwd: string
  model: string | null
  permissionMode: PermissionModeId
  resume: string | null
  /** With resume: branch into a new Claude session instead of continuing the old one. */
  fork?: boolean
  /** Tool names already trusted for this repo (persisted rules). */
  preAllowed?: string[]
  mcpServers: Record<string, unknown> | null
}

export interface AgentCallbacks {
  onEvent(ev: ConvoEvent): void
  onClaudeSession(claudeSessionId: string): void
  onState(state: 'idle' | 'running' | 'requires_action'): void
  onResult(stats: TurnStats): void
  onExit(error?: Error): void
  /** Show the permission UI; resolves with the user's decision. */
  requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>
  /** Launch the session browser before a Playwright tool is allowed to run. */
  ensureBrowser(): Promise<void>
  /** The user chose "always for this repo" — persist the rule. */
  persistAllow(toolName: string): void
}

export class AgentSession {
  private q: Query | null = null
  private input = new PushQueue<SDKUserMessage>()
  private alwaysAllow = new Set<string>()
  private exited = false
  started = false

  constructor(
    private cfg: AgentSessionConfig,
    private cb: AgentCallbacks
  ) {
    for (const t of cfg.preAllowed ?? []) this.alwaysAllow.add(t)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const node = await findNode()
    const options: Options = {
      cwd: this.cfg.cwd,
      resume: this.cfg.resume ?? undefined,
      forkSession: this.cfg.fork && this.cfg.resume ? true : undefined,
      model: this.cfg.model ?? undefined,
      permissionMode: this.cfg.permissionMode as PermissionMode,
      allowDangerouslySkipPermissions: this.cfg.permissionMode === 'bypassPermissions' ? true : undefined,
      includePartialMessages: true,
      forwardSubagentText: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: COCKPIT_NOTE },
      // AskUserQuestion renders poorly outside the CLI; the agent asks in text instead.
      disallowedTools: ['AskUserQuestion'],
      mcpServers: (this.cfg.mcpServers as Record<string, McpServerConfig> | null) ?? undefined,
      executable: node ? 'node' : undefined,
      env: { ...process.env, PATH: getFixedPath() },
      stderr: (data: string) => {
        const line = data.trim()
        if (line) this.cb.onEvent({ t: 'raw', line: `[stderr] ${line.slice(0, 2000)}`, ts: Date.now() })
      },
      canUseTool: this.canUseTool
    }
    this.q = query({ prompt: this.input, options })
    void this.pump()
  }

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    if (toolName.startsWith('mcp__playwright__')) {
      try {
        await this.cb.ensureBrowser()
      } catch {
        /* tool will surface its own connect error */
      }
    }
    if (this.alwaysAllow.has(toolName)) {
      return { behavior: 'allow', updatedInput: input }
    }
    const isPlan = toolName === 'ExitPlanMode'
    const req: PermissionRequest = {
      id: randomUUID(),
      sessionId: this.cfg.sessionId,
      toolName,
      toolUseId: opts.toolUseID,
      input,
      title: opts.title,
      description: opts.description,
      displayName: opts.displayName,
      isPlan,
      plan: isPlan ? String((input as Record<string, unknown>)?.plan ?? '') : undefined,
      ts: Date.now()
    }
    const decision = await this.cb.requestPermission(req, opts.signal)
    if (decision.behavior === 'allow') {
      if (decision.always || decision.alwaysForRepo) this.alwaysAllow.add(toolName)
      if (decision.alwaysForRepo) this.cb.persistAllow(toolName)
      if (decision.setMode) void this.setPermissionMode(decision.setMode)
      const remember = decision.always || decision.alwaysForRepo
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: remember && opts.suggestions?.length ? opts.suggestions : undefined
      }
    }
    return { behavior: 'deny', message: decision.message || 'The user declined this action.' }
  }

  private async pump(): Promise<void> {
    try {
      for await (const m of this.q!) this.handle(m)
      this.finish()
    } catch (e) {
      this.finish(e instanceof Error ? e : new Error(String(e)))
    }
  }

  private finish(err?: Error): void {
    if (this.exited) return
    this.exited = true
    this.cb.onExit(err)
  }

  private emit(ev: ConvoEvent): void {
    this.cb.onEvent(ev)
  }

  private handle(m: SDKMessage): void {
    this.emitRaw(m)
    switch (m.type) {
      case 'system':
        this.handleSystem(m)
        break
      case 'stream_event': {
        if (m.parent_tool_use_id) break // subagent partials arrive as full messages
        const ev = m.event as { type?: string; content_block?: { type?: string }; delta?: Record<string, unknown> }
        if (ev.type === 'content_block_start') {
          const t = ev.content_block?.type
          if (t === 'text') this.emit({ t: 'text-start', kind: 'text', ts: Date.now() })
          else if (t === 'thinking') this.emit({ t: 'text-start', kind: 'thinking', ts: Date.now() })
        } else if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta') {
            this.emit({ t: 'text-delta', kind: 'text', delta: String(ev.delta.text ?? '') })
          } else if (ev.delta.type === 'thinking_delta') {
            this.emit({ t: 'text-delta', kind: 'thinking', delta: String(ev.delta.thinking ?? '') })
          }
        }
        break
      }
      case 'assistant': {
        const parts: AssistantPart[] = []
        const toolUses: ToolUseStart[] = []
        for (const block of m.message.content ?? []) {
          const b = block as unknown as Record<string, unknown>
          if (b.type === 'text' && String(b.text ?? '').trim()) {
            parts.push({ type: 'text', text: String(b.text) })
          } else if (b.type === 'thinking' && String(b.thinking ?? '').trim()) {
            parts.push({ type: 'thinking', text: String(b.thinking) })
          } else if (b.type === 'tool_use') {
            const tu: ToolUseStart = { id: String(b.id), name: String(b.name), input: b.input }
            toolUses.push(tu)
            if (tu.name === 'TodoWrite') {
              const todos = (tu.input as { todos?: TodoItem[] } | undefined)?.todos
              if (Array.isArray(todos)) this.emit({ t: 'todos', todos, ts: Date.now() })
            }
          }
        }
        if (m.error) {
          this.emit({ t: 'banner', level: 'error', text: `Model error: ${m.error}`, ts: Date.now() })
        }
        if (parts.length || toolUses.length) {
          this.emit({
            t: 'assistant',
            id: String(m.uuid ?? randomUUID()),
            chain: m.parent_tool_use_id,
            parts,
            toolUses,
            ts: Date.now()
          })
        }
        break
      }
      case 'user': {
        const content = (m.message as { content?: unknown }).content
        if (!Array.isArray(content)) break
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b.type === 'tool_result') {
            this.emit({
              t: 'tool-result',
              toolUseId: String(b.tool_use_id ?? ''),
              ok: !b.is_error,
              content: flattenToolResult(b.content).slice(0, 20000),
              ts: Date.now()
            })
          }
        }
        break
      }
      case 'result': {
        const ok = m.subtype === 'success' && !m.is_error
        const usage = (m as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
        const stats: TurnStats = {
          ok,
          costUsd: Number((m as { total_cost_usd?: number }).total_cost_usd ?? 0),
          durationMs: Number((m as { duration_ms?: number }).duration_ms ?? 0),
          numTurns: Number((m as { num_turns?: number }).num_turns ?? 0),
          inputTokens: Number(usage?.input_tokens ?? 0),
          outputTokens: Number(usage?.output_tokens ?? 0),
          errorText: ok ? undefined : describeResultError(m)
        }
        this.cb.onResult(stats)
        break
      }
      default:
        break
    }
  }

  private handleSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    switch (m.subtype) {
      case 'init':
        this.cb.onClaudeSession(m.session_id)
        this.emit({
          t: 'init',
          model: m.model,
          permissionMode: String(m.permissionMode),
          mcp: (m.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status }))
        })
        break
      case 'session_state_changed':
        this.cb.onState((m as { state: 'idle' | 'running' | 'requires_action' }).state)
        break
      case 'status': {
        const s = (m as { status?: string | null }).status
        this.emit({ t: 'spinner', detail: s ?? null })
        break
      }
      case 'task_started':
      case 'task_progress': {
        const t = m as unknown as {
          task_id: string
          tool_use_id?: string
          description?: string
          summary?: string
          last_tool_name?: string
          usage?: { total_tokens?: number }
        }
        this.emit({
          t: 'task-progress',
          taskId: t.task_id,
          toolUseId: t.tool_use_id,
          description: t.description ?? '',
          summary: t.summary,
          lastTool: t.last_tool_name,
          totalTokens: t.usage?.total_tokens,
          ts: Date.now()
        })
        break
      }
      case 'task_notification': {
        const t = m as unknown as { task_id: string; tool_use_id?: string; status?: string; summary?: string }
        this.emit({
          t: 'task-progress',
          taskId: t.task_id,
          toolUseId: t.tool_use_id,
          description: t.summary || `Task ${t.status ?? 'finished'}`,
          done: true,
          ts: Date.now()
        })
        break
      }
      case 'permission_denied': {
        const p = m as unknown as { tool_name?: string; decision_reason?: string }
        this.emit({
          t: 'banner',
          level: 'info',
          text: `Auto-denied ${p.tool_name ?? 'tool'}${p.decision_reason ? ` — ${p.decision_reason}` : ''}`,
          ts: Date.now()
        })
        break
      }
      default:
        break
    }
  }

  private emitRaw(m: SDKMessage): void {
    if (m.type === 'stream_event') return // too chatty for the drawer
    try {
      const line = JSON.stringify(m)
      this.emit({ t: 'raw', line: line.length > 4000 ? line.slice(0, 4000) + '…' : line, ts: Date.now() })
    } catch {
      /* ignore */
    }
  }

  send(text: string, images?: { mediaType: string; data: string }[]): void {
    const content: unknown[] = (images ?? []).map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data }
    }))
    // the API rejects empty text blocks — images can travel alone
    if (text.trim() || content.length === 0) content.push({ type: 'text', text })
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null
    } as SDKUserMessage)
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt()
    } catch {
      /* turn may already be over */
    }
  }

  async setModel(model: string | null): Promise<void> {
    this.cfg.model = model
    try {
      await this.q?.setModel(model ?? undefined)
    } catch {
      /* applies on next session start */
    }
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.cfg.permissionMode = mode
    try {
      await this.q?.setPermissionMode(mode as PermissionMode)
    } catch {
      /* applies on next session start */
    }
  }

  async setMcpServers(servers: Record<string, unknown> | null): Promise<void> {
    this.cfg.mcpServers = servers
    if (!this.q) return
    await this.q.setMcpServers((servers as Record<string, McpServerConfig>) ?? {})
  }

  close(): void {
    this.input.end()
    try {
      this.q?.close()
    } catch {
      /* already closed */
    }
    this.finish()
  }
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as Record<string, unknown>
        if (blk?.type === 'text') return String(blk.text ?? '')
        if (blk?.type === 'image') return '[image]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function describeResultError(m: Record<string, unknown>): string {
  const subtype = String(m.subtype ?? 'error')
  const labels: Record<string, string> = {
    error_max_turns: 'Stopped: maximum turns reached',
    error_max_budget_usd: 'Stopped: budget limit reached',
    error_during_execution: 'The agent hit an error during execution'
  }
  const base = labels[subtype] ?? `Turn ended with ${subtype.replace(/_/g, ' ')}`
  const detail = typeof m.result === 'string' && m.result && m.result !== base ? `: ${m.result.slice(0, 400)}` : ''
  return base + detail
}
