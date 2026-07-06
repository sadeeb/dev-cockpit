import {
  Braces,
  ChevronDown,
  CircleDot,
  GitBranch,
  GitPullRequestArrow,
  Globe,
  Link2,
  Unlink
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MODEL_CHOICES, PERMISSION_MODES, type SessionRow } from '../../../shared/types'
import { store, type AppState } from '../store'
import { cx, fmtCost, shortPath } from '../util'
import { BrowserPanel } from './BrowserPanel'
import { ChangesPanel } from './ChangesPanel'
import { Composer } from './Composer'
import { Conversation } from './Conversation'

function StatusPill({ status }: { status: SessionRow['status'] }): ReactNode {
  const label: Record<string, string> = {
    idle: 'Idle',
    running: 'Running',
    waiting: 'Needs you',
    done: 'Done',
    error: 'Error'
  }
  return (
    <span className={cx('status-pill', status)}>
      <span className="dot" />
      {label[status] ?? status}
    </span>
  )
}

function TitleEditor({ row }: { row: SessionRow }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(row.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setValue(row.title)
  }, [row.title, editing])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  if (!editing) {
    return (
      <button className="title-text" title="Click to rename" onClick={() => setEditing(true)}>
        {row.title}
        {row.titleSource === 'ai' && <span className="title-tag">auto</span>}
      </button>
    )
  }
  const save = (): void => {
    setEditing(false)
    if (value.trim() && value.trim() !== row.title) store.rename(row.id, value.trim())
  }
  return (
    <input
      ref={inputRef}
      className="title-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

function IssueBadge({ row }: { row: SessionRow }): ReactNode {
  if (!row.link) {
    return (
      <button className="issue-badge add" title="Link a GitHub issue" onClick={() => store.openModal({ m: 'link-issue', id: row.id })}>
        <Link2 size={12} /> Link issue
      </button>
    )
  }
  const { link } = row
  return (
    <span className={cx('issue-badge', link.state)}>
      <button
        className="issue-open"
        title={`${link.repo}#${link.issueNumber} — open on GitHub`}
        onClick={() => void window.cockpit.openExternal(link.url)}
      >
        {link.state === 'open' ? <CircleDot size={12} /> : <GitPullRequestArrow size={12} />}
        #{link.issueNumber}
        <span className="issue-state">{link.state}</span>
      </button>
      <button className="issue-unlink" title="Unlink issue" onClick={() => store.unlinkIssue(row.id)}>
        <Unlink size={11} />
      </button>
    </span>
  )
}

function Select<T extends string | null>({
  value,
  options,
  onChange,
  danger
}: {
  value: T
  options: { id: T; label: string; hint?: string; danger?: boolean }[]
  onChange: (v: T) => void
  danger?: boolean
}): ReactNode {
  const current = options.find((o) => o.id === value) ?? options[0]
  return (
    <div className={cx('pill-select', danger && current.danger && 'danger')}>
      <select
        value={String(value)}
        title={current.hint}
        onChange={(e) => {
          const opt = options.find((o) => String(o.id) === e.target.value)
          if (opt) onChange(opt.id)
        }}
      >
        {options.map((o) => (
          <option key={String(o.id)} value={String(o.id)} title={o.hint}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={11} />
    </div>
  )
}

function EventDrawer({ sessionId, state }: { sessionId: string; state: AppState }): ReactNode {
  const convo = state.convos[sessionId]
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  })
  return (
    <div className="drawer">
      <div className="drawer-head">
        Raw agent events
        <span className="dim">{convo?.raw.length ?? 0} lines (newest last)</span>
      </div>
      <div className="drawer-body" ref={ref}>
        {(convo?.raw ?? []).map((r, i) => (
          <div className="drawer-line" key={i}>
            {r.line}
          </div>
        ))}
        {!convo?.raw.length && <div className="dim pad">Events will appear once the agent runs.</div>}
      </div>
    </div>
  )
}

export function SessionView({ state, row }: { state: AppState; row: SessionRow }): ReactNode {
  const convo = state.convos[row.id] ?? {
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
  }
  const browserOpen = state.browserPanel[row.id] ?? false
  const drawerOpen = state.drawer[row.id] ?? false
  const changesOpen = state.changesPanel[row.id] ?? false

  return (
    <div className="session-view">
      <header className="session-head">
        <div className="session-head-main">
          <TitleEditor row={row} />
          <div className="session-meta">
            <IssueBadge row={row} />
            <span className="meta-path" title={row.workingDir}>
              {shortPath(row.workingDir, window.cockpit.meta.home)}
            </span>
            {row.totalCostUsd > 0 && <span className="meta-cost">{fmtCost(row.totalCostUsd)}</span>}
          </div>
        </div>
        <div className="session-controls">
          <StatusPill status={row.status} />
          <Select
            value={row.model}
            options={MODEL_CHOICES}
            onChange={(m) => store.setModel(row.id, m)}
          />
          <Select
            value={row.permissionMode}
            options={PERMISSION_MODES}
            onChange={(m) => store.setPermissionMode(row.id, m)}
            danger
          />
          <button
            className={cx('icon-btn', row.browserEnabled && 'active')}
            title={row.browserEnabled ? 'Browser tools enabled — click to disable' : 'Enable browser tools (Playwright)'}
            onClick={() => store.toggleBrowser(row.id, !row.browserEnabled)}
          >
            <Globe size={15} />
          </button>
          <button
            className={cx('icon-btn', changesOpen && 'active')}
            title="Working-tree changes (diff, commit, discard)"
            onClick={() => store.setChangesPanel(row.id, !changesOpen)}
          >
            <GitBranch size={15} />
          </button>
          <button
            className={cx('icon-btn', drawerOpen && 'active')}
            title="Raw agent event stream"
            onClick={() => store.setDrawer(row.id, !drawerOpen)}
          >
            <Braces size={15} />
          </button>
        </div>
      </header>

      <div className="session-body">
        <div className="session-center">
          <Conversation convo={convo} row={row} />
          <Composer row={row} convo={convo} insert={state.composerInsert[row.id]} />
        </div>
        {row.browserEnabled && browserOpen && <BrowserPanel state={state} row={row} />}
        {changesOpen && <ChangesPanel row={row} />}
        {drawerOpen && <EventDrawer sessionId={row.id} state={state} />}
      </div>
    </div>
  )
}
