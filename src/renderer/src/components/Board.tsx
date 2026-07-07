import { CircleDot, Globe, ListTodo, Plus, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { SessionRow } from '../../../shared/types'
import { store, type AppState, type ConvoItem, type ConvoState } from '../store'
import { baseName, cx, fmtCost, timeAgo } from '../util'

/**
 * Mission control (spec §6): a pure projection over each session's event
 * stream - status, live checklist, tool ticker, browser thumbnail. Because it
 * reads the same stream the agent produces, it can't misreport what happened.
 */

function toolTicker(convo: ConvoState | undefined): { name: string; ok?: boolean; running: boolean }[] {
  if (!convo) return []
  const tools: { name: string; ok?: boolean; running: boolean }[] = []
  for (let i = convo.items.length - 1; i >= 0 && tools.length < 3; i--) {
    const it: ConvoItem = convo.items[i]
    if (it.k === 'tool') {
      tools.unshift({ name: friendlyTool(it.tool.name), ok: it.tool.ok, running: it.tool.running })
    }
  }
  return tools
}

function friendlyTool(name: string): string {
  if (name.startsWith('mcp__playwright__')) return name.replace('mcp__playwright__browser_', 'browser ').replace(/_/g, ' ')
  if (name.startsWith('mcp__')) return name.replace(/^mcp__(\w+)__/, '$1 ').replace(/_/g, ' ')
  const map: Record<string, string> = { Bash: 'shell', TodoWrite: 'plan', Read: 'read', Edit: 'edit', Write: 'write', Grep: 'search', Glob: 'find', Task: 'subagent' }
  return map[name] ?? name.toLowerCase()
}

function lastLine(convo: ConvoState | undefined): string {
  if (!convo) return ''
  for (let i = convo.items.length - 1; i >= 0; i--) {
    const it = convo.items[i]
    if (it.k === 'msg') {
      const text = it.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim()
      if (text) return text.replace(/[#*`>]/g, '').slice(0, 140)
    }
    if (it.k === 'banner' && it.level === 'error') return it.text
  }
  return ''
}

function Elapsed({ since }: { since: number }): ReactNode {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.floor((Date.now() - since) / 1000)
  return <span>{s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`}</span>
}

function Card({ state, row }: { state: AppState; row: SessionRow }): ReactNode {
  const convo = state.convos[row.id]
  const frame = state.browsers[row.id]?.frame
  const todos = convo?.todos ?? []
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  const ticker = toolTicker(convo)
  const pendingPerm = convo?.items.some((it) => it.k === 'perm' && !it.resolved)

  return (
    <div
      className={cx('card', row.status)}
      role="button"
      tabIndex={0}
      onClick={() => store.selectSession(row.id)}
      onKeyDown={(e) => e.key === 'Enter' && store.selectSession(row.id)}
    >
      <button
        className="card-delete"
        data-tip="Delete session"
        onClick={(e) => {
          e.stopPropagation()
          store.openModal({ m: 'delete-session', id: row.id })
        }}
      >
        <X size={13} />
      </button>
      <div className="card-head">
        <span className={cx('status-pill', row.status)}>
          <span className="dot" />
          {row.status === 'waiting' ? 'Needs you' : row.status}
          {row.status === 'running' && convo?.turnStartTs ? <Elapsed since={convo.turnStartTs} /> : null}
        </span>
        {row.link && (
          <span className={cx('card-issue', row.link.state)}>
            <CircleDot size={11} />#{row.link.issueNumber}
          </span>
        )}
        <span className="card-dir">{baseName(row.workingDir)}</span>
      </div>

      <div className="card-title">{row.title}</div>

      {todos.length > 0 ? (
        <div className="card-todos">
          <div className="card-todos-head">
            <ListTodo size={12} />
            <span>
              {done}/{todos.length}
            </span>
            <span className="todo-strip-bar">
              <span style={{ width: `${(done / todos.length) * 100}%` }} />
            </span>
          </div>
          {current && <div className="card-current">▸ {current.activeForm || current.content}</div>}
        </div>
      ) : (
        lastLine(convo) && <div className="card-line">{lastLine(convo)}</div>
      )}

      {pendingPerm && <div className="card-perm">⚠ Waiting for your approval</div>}

      {ticker.length > 0 && (
        <div className={cx('card-ticker', row.status === 'running' && 'live')}>
          <div className="ticker-track">
            {/* live marquee loops the list; keyframe slides one full copy width */}
            {(row.status === 'running' ? [...ticker, ...ticker] : ticker).map((t, i) => (
              <span key={i} className={cx('tick', t.running && 'running', t.ok === false && 'failed')}>
                {t.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={cx('card-thumb', !frame && 'empty')}>
        {frame ? (
          <img src={frame.dataUrl} alt="" draggable={false} />
        ) : (
          <Globe size={16} />
        )}
      </div>

      <div className="card-foot">
        <span>{timeAgo(row.updatedAt)}</span>
        {row.totalCostUsd > 0 && <span>{fmtCost(row.totalCostUsd)}</span>}
      </div>
    </div>
  )
}

const SPARK_COLORS = ['c-blue', 'c-yellow', 'c-orange', 'c-green', 'c-purple']

function CostSpark({ state }: { state: AppState }): ReactNode {
  const costs = state.sessions.map((s) => ({ title: s.title, cost: s.totalCostUsd }))
  const total = costs.reduce((a, b) => a + b.cost, 0)
  if (total <= 0) return null
  const max = Math.max(...costs.map((c) => c.cost))
  return (
    <div className="cost-spark">
      <div className="spark-bars">
        {costs.map((c, i) => (
          <span
            key={i}
            className={cx('spark-bar', SPARK_COLORS[i % SPARK_COLORS.length])}
            title={`${c.title}: ${fmtCost(c.cost)}`}
            style={{ height: `${Math.max(12, (c.cost / max) * 100)}%` }}
          />
        ))}
      </div>
      <span className="spark-total">{fmtCost(total)} today’s flying</span>
    </div>
  )
}

export function Board({ state }: { state: AppState }): ReactNode {
  return (
    <div className="board-wrap">
      <div className="board-head">
        <div>
          <h1>Mission Control</h1>
          <p className="dim">
            All birds in the air: every session, its checklist, tools, and live browser at a glance.
          </p>
        </div>
        <CostSpark state={state} />
      </div>
      <div className="board">
        {state.sessions.map((s) => (
          <Card key={s.id} state={state} row={s} />
        ))}
        <button className="card new" onClick={() => store.openModal({ m: 'new-session' })}>
          <Plus size={18} />
          New session
        </button>
      </div>
    </div>
  )
}
