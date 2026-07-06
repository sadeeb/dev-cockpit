import { MessageSquarePlus, Play, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProcLine, SessionRow } from '../../../shared/types'
import { store, type AppState } from '../store'
import { cx } from '../util'

/**
 * Session-owned background processes: run the dev server here, watch its
 * output live, and click any line (or the last chunk) into the chat. The
 * server-side sibling of the browser console drawer.
 */

function fmtLinesForChat(lines: ProcLine[], command: string): string {
  return `Output from \`${command}\`:\n\`\`\`\n${lines.map((l) => l.line).join('\n')}\n\`\`\`\n`
}

export function ProcessPanel({ state, row }: { state: AppState; row: SessionRow }): ReactNode {
  const ui = state.procs[row.id] ?? { procs: [], lines: [], seeded: false }
  const [cmd, setCmd] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ui.lines.length])

  const start = async (): Promise<void> => {
    const command = cmd.trim()
    if (!command) return
    const res = await window.cockpit.procStart(row.id, command)
    if ('error' in res) store.pushToast('error', res.error)
    else setCmd('')
  }

  const commandOf = (procId: string): string => ui.procs.find((p) => p.id === procId)?.command ?? 'process'

  const sendRecent = (): void => {
    const recent = ui.lines.slice(-25)
    if (!recent.length) return
    store.insertIntoComposer(row.id, fmtLinesForChat(recent, commandOf(recent[recent.length - 1].procId)))
  }

  return (
    <aside className="proc-panel">
      <div className="proc-head">
        <form
          className="proc-cmd"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <input
            value={cmd}
            placeholder="npm run dev"
            spellCheck={false}
            onChange={(e) => setCmd(e.target.value)}
          />
          <button className="icon-btn" type="submit" title="Start process" disabled={!cmd.trim()}>
            <Play size={13} />
          </button>
        </form>
        <button className="icon-btn" title="Drop recent output into the chat" disabled={!ui.lines.length} onClick={sendRecent}>
          <MessageSquarePlus size={13} />
        </button>
        <button
          className="icon-btn"
          title="Clear output"
          disabled={!ui.lines.length}
          onClick={() => void window.cockpit.procClear(row.id)}
        >
          <Trash2 size={13} />
        </button>
        <button className="icon-btn" title="Hide panel" onClick={() => store.setProcPanel(row.id, false)}>
          <X size={13} />
        </button>
      </div>

      {ui.procs.length > 0 && (
        <div className="proc-chips">
          {ui.procs.map((p) => (
            <span key={p.id} className={cx('proc-chip', p.running ? 'running' : 'stopped')} title={p.command}>
              <span className="proc-chip-cmd">{p.command}</span>
              {p.running ? (
                <button title="Stop" onClick={() => void window.cockpit.procStop(row.id, p.id)}>
                  <Square size={9} fill="currentColor" />
                </button>
              ) : (
                <em>exit {p.exitCode ?? '?'}</em>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="proc-body" ref={bodyRef}>
        {ui.lines.length === 0 && (
          <div className="proc-empty">
            Run your dev server here. Output streams live, and crashes click straight into the chat.
          </div>
        )}
        {ui.lines.map((l) => (
          <button
            key={l.id}
            className="proc-line"
            title="Click to drop this line into the chat"
            onClick={() => store.insertIntoComposer(row.id, fmtLinesForChat([l], commandOf(l.procId)))}
          >
            {l.line}
          </button>
        ))}
      </div>
    </aside>
  )
}
