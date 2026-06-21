import { Globe, Power, RotateCw, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import type { BrowserInputEvent, SessionRow } from '../../../shared/types'
import { store, type AppState } from '../store'
import { cx } from '../util'

/**
 * Embedded live view of the session's shared browser: a CDP screencast the
 * human can click, scroll, and type into — the same Chromium the agent
 * drives through the Playwright MCP.
 */
export function BrowserPanel({ state, row }: { state: AppState; row: SessionRow }): ReactNode {
  const b = state.browsers[row.id]
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const frame = b?.frame

  const sendInput = (ev: BrowserInputEvent): void => {
    if (!frame) return
    window.cockpit.browserInput(row.id, ev, frame.w, frame.h)
  }

  const norm = (e: React.MouseEvent): { x: number; y: number } => {
    const el = imgRef.current!
    const r = el.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    }
  }

  const mouse = (kind: 'down' | 'up' | 'move') => (e: React.MouseEvent) => {
    if (!frame) return
    if (kind === 'move' && e.buttons === 0) return
    const { x, y } = norm(e)
    sendInput({
      t: 'mouse',
      kind,
      x,
      y,
      button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
      clickCount: kind === 'move' ? 0 : e.detail || 1
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.length === 1) return // keep app shortcuts
    e.preventDefault()
    const mods = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      sendInput({ t: 'text', text: e.key })
    } else {
      sendInput({ t: 'key', key: e.key, code: e.code, kind: 'down', modifiers: mods })
      sendInput({ t: 'key', key: e.key, code: e.code, kind: 'up', modifiers: mods })
    }
  }

  return (
    <aside className="browser-panel">
      <div className="browser-bar">
        <Globe size={13} className="dim" />
        <form
          className="browser-url"
          onSubmit={(e) => {
            e.preventDefault()
            if (urlDraft != null && urlDraft.trim()) {
              void window.cockpit.browserNavigate(row.id, urlDraft.trim())
              setUrlDraft(null)
            }
          }}
        >
          <input
            value={urlDraft ?? b?.url ?? ''}
            placeholder="http://localhost:3000"
            spellCheck={false}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => setUrlDraft(null)}
          />
        </form>
        <button
          className="icon-btn"
          title="Reload"
          onClick={() => b?.url && void window.cockpit.browserNavigate(row.id, b.url)}
        >
          <RotateCw size={13} />
        </button>
        <button
          className="icon-btn"
          title={b?.running ? 'Quit this session’s browser' : 'Launch browser'}
          onClick={() => (b?.running ? void window.cockpit.browserClose(row.id) : void window.cockpit.browserOpen(row.id))}
        >
          <Power size={13} className={b?.running ? 'good' : ''} />
        </button>
        <button className="icon-btn" title="Hide panel" onClick={() => store.setBrowserPanel(row.id, false)}>
          <X size={13} />
        </button>
      </div>

      {(b?.tabs.length ?? 0) > 1 && (
        <div className="browser-tabs">
          {b!.tabs.map((t) => (
            <button
              key={t.id}
              className={cx('browser-tab', t.id === b!.activeTabId && 'active')}
              title={t.url}
              onClick={() => void window.cockpit.browserSelectTab(row.id, t.id)}
            >
              {t.title || t.url || 'Tab'}
            </button>
          ))}
        </div>
      )}

      <div className="browser-stage">
        {frame ? (
          <img
            ref={imgRef}
            src={frame.dataUrl}
            alt="Live browser"
            tabIndex={0}
            draggable={false}
            onMouseDown={mouse('down')}
            onMouseUp={mouse('up')}
            onMouseMove={mouse('move')}
            onWheel={(e) => {
              if (!imgRef.current) return
              const r = imgRef.current.getBoundingClientRect()
              sendInput({
                t: 'wheel',
                x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
                y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
                deltaX: e.deltaX,
                deltaY: -e.deltaY
              })
            }}
            onKeyDown={onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          />
        ) : (
          <div className="browser-placeholder">
            {b?.starting ? (
              <>
                <span className="pulse-dot" /> Launching browser…
              </>
            ) : b?.error ? (
              <span className="bad">{b.error}</span>
            ) : (
              <>
                <Globe size={22} className="dim" />
                <p>
                  The agent and you share this browser. It launches automatically when the agent uses a browser tool —
                  or start it now with the power button.
                </p>
                <p className="dim small">Heads-up: pages the agent sees are sent to the model. Use dev/test data only.</p>
              </>
            )}
          </div>
        )}
      </div>
      <div className="browser-foot">
        Click, scroll, and type directly in the preview — it drives the real browser window.
      </div>
    </aside>
  )
}
