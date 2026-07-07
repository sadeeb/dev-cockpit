import { Check, CircleDot, LayoutGrid, MonitorPlay, Plus, Sparkles, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { store, type AppState } from '../store'

export function PreflightList({ state }: { state: AppState }): ReactNode {
  if (!state.preflight) return <div className="dim">Checking your environment…</div>
  return (
    <ul className="preflight">
      {state.preflight.map((c) => (
        <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
          <span className="preflight-icon">{c.ok ? <Check size={13} /> : <X size={13} />}</span>
          <div>
            <div className="preflight-label">{c.label}</div>
            <div className="preflight-detail">{c.ok ? c.detail : (c.hint ?? c.detail)}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function Welcome({ state }: { state: AppState }): ReactNode {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="brand-mark large" aria-hidden>
          <span /><span /><span /><span />
        </div>
        <h1>Argus</h1>
        <p className="welcome-tag">
          Your flight deck for Claude Code: run a squadron of sessions, wire in GitHub issues, and co-pilot a live
          browser with the agent. Strap in.
        </p>

        <button className="btn primary big" onClick={() => store.openModal({ m: 'new-session' })}>
          <Plus size={16} /> Start your first mission
        </button>

        <div className="welcome-tips">
          <div className="tip">
            <Sparkles size={15} />
            <b>Auto-titled sessions</b>
            <span>Your first prompt names the session instantly. Edit anytime.</span>
          </div>
          <div className="tip">
            <CircleDot size={15} />
            <b>Issue-aware</b>
            <span>Paste an issue URL or #123 and the agent starts knowing the bug.</span>
          </div>
          <div className="tip">
            <LayoutGrid size={15} />
            <b>Mission control</b>
            <span>One board for every session: checklist, tools, status, cost.</span>
          </div>
          <div className="tip">
            <MonitorPlay size={15} />
            <b>Co-piloted browser</b>
            <span>The agent flies your app in an embedded browser. Grab the stick anytime and beam console logs into the chat.</span>
          </div>
        </div>

        <div className="welcome-preflight">
          <h3>Environment</h3>
          <PreflightList state={state} />
        </div>
      </div>
    </div>
  )
}
