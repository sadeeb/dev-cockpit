// ─────────────────────────────────────────────────────────────────────────────
// Shared contract between the main process (bridge/services) and the renderer.
// This is the "bridge ↔ renderer message contract" from the spec, made explicit.
// ─────────────────────────────────────────────────────────────────────────────

export type TitleSource = 'manual' | 'issue' | 'ai' | 'default'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'
export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface GithubLink {
  sessionId: string
  repo: string // owner/repo
  issueNumber: number
  issueTitle: string
  state: 'open' | 'closed'
  url: string
  contextInjected: boolean
}

export interface SessionRow {
  id: string
  claudeSessionId: string | null
  title: string
  titleSource: TitleSource
  workingDir: string
  status: SessionStatus
  model: string | null // null = Claude Code default
  permissionMode: PermissionModeId
  browserEnabled: boolean
  firstPromptSent: boolean
  totalCostUsd: number
  createdAt: number
  updatedAt: number
  link: GithubLink | null
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface PermissionRequest {
  id: string
  sessionId: string
  toolName: string
  toolUseId?: string
  input: unknown
  /** Pre-rendered prompt sentence from the engine, e.g. "Claude wants to read foo.txt" */
  title?: string
  description?: string
  displayName?: string
  /** True when this is an ExitPlanMode approval — render the plan, offer plan actions */
  isPlan: boolean
  plan?: string
  ts: number
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny'
  /** allow + remember for the rest of this session (per tool name) */
  always?: boolean
  /** optionally switch permission mode after allowing (plan approval) */
  setMode?: PermissionModeId
  /** deny message forwarded to the agent */
  message?: string
}

export interface AssistantPart {
  type: 'text' | 'thinking'
  text: string
}

export interface ToolUseStart {
  id: string
  name: string
  input: unknown
}

export interface TurnStats {
  ok: boolean
  costUsd: number
  durationMs: number
  numTurns: number
  inputTokens: number
  outputTokens: number
  errorText?: string
  interrupted?: boolean
}

// Events that drive a single session's conversation view.
// History replay re-uses the same event vocabulary.
export type ConvoEvent =
  | { t: 'user'; text: string; ts: number }
  | { t: 'issue-context'; repo: string; issueNumber: number; ts: number }
  | { t: 'text-start'; kind: 'text' | 'thinking'; ts: number }
  | { t: 'text-delta'; kind: 'text' | 'thinking'; delta: string }
  | {
      t: 'assistant'
      id: string
      chain: string | null // parent_tool_use_id (subagent nesting)
      parts: AssistantPart[]
      toolUses: ToolUseStart[]
      ts: number
    }
  | { t: 'tool-result'; toolUseId: string; ok: boolean; content: string; ts: number }
  | { t: 'todos'; todos: TodoItem[]; ts: number }
  | { t: 'permission-request'; req: PermissionRequest }
  | { t: 'permission-resolved'; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'turn-start'; ts: number }
  | { t: 'turn-end'; ts: number; stats: TurnStats }
  | { t: 'spinner'; detail: string | null } // compacting / requesting / null
  | {
      t: 'task-progress'
      taskId: string
      toolUseId?: string
      description: string
      summary?: string
      lastTool?: string
      totalTokens?: number
      done?: boolean
      ts: number
    }
  | { t: 'init'; model: string; permissionMode: string; mcp: { name: string; status: string }[] }
  | { t: 'queue'; pending: string[] }
  | { t: 'banner'; level: 'info' | 'error'; text: string; ts: number }
  | { t: 'history'; events: ConvoEvent[] }
  | { t: 'raw'; line: string; ts: number }

export interface BrowserTab {
  id: string
  title: string
  url: string
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
  id: number
  level: ConsoleLevel
  /** 'console' = console.* call, 'exception' = uncaught JS error, 'network' = failed request */
  source: 'console' | 'exception' | 'network'
  text: string
  url?: string
  line?: number
  ts: number
}

export type BrowserEvent =
  | {
      t: 'state'
      running: boolean
      starting?: boolean
      url?: string
      tabs?: BrowserTab[]
      activeTabId?: string
      error?: string
    }
  | { t: 'frame'; dataUrl: string; w: number; h: number }
  | { t: 'console'; entry: ConsoleEntry }
  | { t: 'console-clear' }

export type BrowserInputEvent =
  | {
      t: 'mouse'
      kind: 'down' | 'up' | 'move'
      x: number // 0..1 normalized to frame
      y: number
      button: 'left' | 'right' | 'middle'
      clickCount: number
    }
  | { t: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { t: 'text'; text: string }
  | { t: 'key'; key: string; code: string; kind: 'down' | 'up'; modifiers: number }

export type CockpitEvent =
  | { kind: 'sessions'; sessions: SessionRow[] }
  | { kind: 'session-updated'; session: SessionRow }
  | { kind: 'session-removed'; sessionId: string }
  | { kind: 'convo'; sessionId: string; ev: ConvoEvent }
  | { kind: 'browser'; sessionId: string; ev: BrowserEvent }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  | { kind: 'ui-command'; command: UiCommand }

export type UiCommand =
  | { c: 'new-session' }
  | { c: 'toggle-board' }
  | { c: 'open-settings' }
  | { c: 'select-session-index'; index: number }

export interface GitFileChange {
  path: string
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '?'
  additions: number
  deletions: number
}

export interface GitChanges {
  ok: boolean
  error?: string
  branch: string
  files: GitFileChange[]
}

export interface GitCommitResult {
  ok: boolean
  error?: string
  hash?: string
}

export interface PreflightCheck {
  id: string
  label: string
  ok: boolean
  detail: string
  hint?: string
}

export interface Settings {
  defaultWorkingDir: string
  defaultModel: string | null
  defaultPermissionMode: PermissionModeId
  allowedOrigins: string
  browserSafetyAcked: boolean
  chromePath: string
  sendOnEnter: boolean
}

export interface CreateSessionOpts {
  workingDir: string
  model: string | null
  permissionMode: PermissionModeId
  browserEnabled: boolean
}

export interface ModelChoice {
  id: string | null
  label: string
  hint: string
}

export const MODEL_CHOICES: ModelChoice[] = [
  { id: null, label: 'Default', hint: 'Your Claude Code default model' },
  { id: 'opus', label: 'Opus', hint: 'Most capable, slower' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Balanced speed and capability' },
  { id: 'haiku', label: 'Haiku', hint: 'Fastest, lightweight tasks' }
]

export const PERMISSION_MODES: { id: PermissionModeId; label: string; hint: string; danger?: boolean }[] = [
  { id: 'default', label: 'Ask before actions', hint: 'Approve risky tools as they happen (recommended)' },
  { id: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits run without asking; shell still asks' },
  { id: 'plan', label: 'Plan first', hint: 'Agent proposes a plan before touching anything' },
  { id: 'bypassPermissions', label: 'Full auto', hint: 'Never asks. Trusts every tool — use with care', danger: true }
]

// Renderer → main command surface (implemented over a single invoke channel).
export interface CockpitApi {
  listSessions(): Promise<SessionRow[]>
  createSession(opts: CreateSessionOpts): Promise<SessionRow>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  setModel(sessionId: string, model: string | null): Promise<void>
  setPermissionMode(sessionId: string, mode: PermissionModeId): Promise<void>
  setBrowserEnabled(sessionId: string, enabled: boolean): Promise<void>
  sendPrompt(sessionId: string, text: string): Promise<void>
  cancelQueued(sessionId: string, index: number): Promise<void>
  interrupt(sessionId: string): Promise<void>
  respondPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>
  loadHistory(sessionId: string): Promise<void>
  linkIssue(sessionId: string, ref: string): Promise<{ link?: GithubLink; error?: string }>
  unlinkIssue(sessionId: string): Promise<void>
  chooseDirectory(): Promise<string | null>
  gitChanges(sessionId: string): Promise<GitChanges>
  gitFileDiff(sessionId: string, path: string): Promise<string>
  gitCommit(sessionId: string, message: string): Promise<GitCommitResult>
  gitDiscard(sessionId: string, path: string): Promise<GitCommitResult>
  browserOpen(sessionId: string): Promise<void>
  browserClose(sessionId: string): Promise<void>
  browserNavigate(sessionId: string, url: string): Promise<void>
  browserSelectTab(sessionId: string, tabId: string): Promise<void>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  preflight(): Promise<PreflightCheck[]>
  uiReady(): Promise<void>
  openExternal(url: string): Promise<void>
}

export interface CockpitMeta {
  platform: string
  home: string
  demo: boolean
  demoView: string | null
}

declare global {
  interface Window {
    cockpit: CockpitApi & {
      onEvent(cb: (e: CockpitEvent) => void): () => void
      browserInput(sessionId: string, ev: BrowserInputEvent, frameW: number, frameH: number): void
      meta: CockpitMeta
    }
  }
}
