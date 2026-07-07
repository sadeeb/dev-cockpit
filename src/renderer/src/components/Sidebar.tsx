import { ArrowUpRight, LayoutGrid, Plus, Settings, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SessionRow } from '../../../shared/types'
import { store, type AppState } from '../store'
import { baseName, cx, timeAgo } from '../util'

/** Sessions are numbered color blocks, units.gr-rail style - the color is the session's identity. */
const CARD_COLORS = ['c-blue', 'c-yellow', 'c-orange', 'c-green', 'c-purple']

function SessionItem({ row, index, active }: { row: SessionRow; index: number; active: boolean }): ReactNode {
  return (
    <div
      className={cx('side-card', CARD_COLORS[index % CARD_COLORS.length], active && 'active')}
      role="button"
      tabIndex={0}
      onClick={() => store.selectSession(row.id)}
      onKeyDown={(e) => e.key === 'Enter' && store.selectSession(row.id)}
    >
      <div className="side-card-top">
        <span className="side-num">{String(index + 1).padStart(2, '0')}</span>
        <span className={cx('side-dot', row.status)} />
        <button
          className="side-delete"
          title="Delete session"
          onClick={(e) => {
            e.stopPropagation()
            store.openModal({ m: 'delete-session', id: row.id })
          }}
        >
          <X size={13} />
        </button>
        <ArrowUpRight size={14} className="side-arrow" />
      </div>
      <div className="side-card-title" title={row.title}>
        {row.title}
      </div>
      <div className="side-card-sub">
        {row.link && <span className="side-issue">#{row.link.issueNumber}</span>}
        <span>{baseName(row.workingDir)}</span>
        <span className="side-time">{timeAgo(row.updatedAt)}</span>
      </div>
    </div>
  )
}

export function Sidebar({ state }: { state: AppState }): ReactNode {
  const activeId = state.view.kind === 'session' ? state.view.id : null
  const running = state.sessions.filter((s) => s.status === 'running').length
  const waiting = state.sessions.filter((s) => s.status === 'waiting').length

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <span /><span /><span /><span />
        </span>
        <span className="brand-name">Argus</span>
      </div>

      <button
        className={cx('side-nav', state.view.kind === 'board' && 'active')}
        onClick={() => store.showBoard()}
      >
        <LayoutGrid size={15} />
        Mission Control
        {(running > 0 || waiting > 0) && (
          <span className="side-counts">
            {running > 0 && <span className="count running">{running}</span>}
            {waiting > 0 && <span className="count waiting">{waiting}</span>}
          </span>
        )}
      </button>

      <div className="side-section">
        <span>Sessions</span>
        <button className="icon-btn" title="New session (⌘N)" onClick={() => store.openModal({ m: 'new-session' })}>
          <Plus size={15} />
        </button>
      </div>

      <div className="side-list">
        {state.sessions.map((s, i) => (
          <SessionItem key={s.id} row={s} index={i} active={s.id === activeId} />
        ))}
        {state.sessions.length === 0 && (
          <div className="side-empty">
            No sessions yet.
            <button className="btn primary small" onClick={() => store.openModal({ m: 'new-session' })}>
              <Plus size={13} /> New session
            </button>
          </div>
        )}
      </div>

      <div className="side-foot">
        <button className="side-foot-btn" onClick={() => store.openModal({ m: 'settings' })}>
          <Settings size={14} />
          Settings
        </button>
        {state.preflight && state.preflight.some((c) => !c.ok) && (
          <span className="preflight-warn" title="Some checks failed. See Settings">
            !
          </span>
        )}
      </div>
    </nav>
  )
}
