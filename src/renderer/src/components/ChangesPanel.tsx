import { Check, ChevronDown, ChevronRight, GitBranch, Loader2, RotateCw, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { GitChanges, SessionRow } from '../../../shared/types'
import { store } from '../store'
import { cx } from '../util'

/**
 * The living working-tree view: watch the agent's edits accumulate, expand
 * any file's diff, then commit or discard without leaving the cockpit.
 */

const STATUS_LABEL: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', U: 'U', '?': 'U' }

function DiffView({ text }: { text: string }): ReactNode {
  const lines = text.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
  if (!lines.some((l) => l.trim())) return <div className="changes-nodiff">Binary or empty diff.</div>
  return (
    <div className="diff">
      {lines.map((l, i) => {
        const kind = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'same'
        return (
          <div key={i} className={`diff-line ${kind}`}>
            <span className="diff-gutter">{kind === 'add' ? '+' : kind === 'del' ? '-' : ' '}</span>
            <span>{(kind === 'add' || kind === 'del' ? l.slice(1) : l) || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}

function FileRow({ row, file, onChanged }: { row: SessionRow; file: GitChanges['files'][number]; onChanged: () => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (next && diff === null) {
      setDiff(await window.cockpit.gitFileDiff(row.id, file.path))
    }
  }

  const discard = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true)
      window.setTimeout(() => setConfirming(false), 3000)
      return
    }
    const res = await window.cockpit.gitDiscard(row.id, file.path)
    if (!res.ok) store.pushToast('error', res.error ?? 'Discard failed')
    onChanged()
  }

  return (
    <div className="change-file">
      <div className="change-row" role="button" tabIndex={0} onClick={() => void toggle()} onKeyDown={(e) => e.key === 'Enter' && void toggle()}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className={cx('change-status', `s-${STATUS_LABEL[file.status] ?? 'M'}`)}>{STATUS_LABEL[file.status] ?? 'M'}</span>
        <span className="change-path" title={file.path}>
          {file.path}
        </span>
        <span className="change-counts">
          {file.additions > 0 && <em className="add">+{file.additions}</em>}
          {file.deletions > 0 && <em className="del">−{file.deletions}</em>}
        </span>
        <button
          className={cx('change-discard', confirming && 'confirming')}
          title={confirming ? 'Click again to throw these changes away' : 'Discard changes to this file'}
          onClick={(e) => {
            e.stopPropagation()
            void discard()
          }}
        >
          {confirming ? 'Sure?' : <Undo2 size={12} />}
        </button>
      </div>
      {open && (diff === null ? <div className="changes-nodiff">Loading…</div> : <DiffView text={diff} />)}
    </div>
  )
}

export function ChangesPanel({ row }: { row: SessionRow }): ReactNode {
  const [changes, setChanges] = useState<GitChanges | null>(null)
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    const c = await window.cockpit.gitChanges(row.id)
    if (alive.current) setChanges(c)
  }, [row.id])

  useEffect(() => {
    alive.current = true
    setChanges(null)
    void refresh()
    const t = setInterval(() => void refresh(), 4000)
    return () => {
      alive.current = false
      clearInterval(t)
    }
  }, [refresh])

  const commit = async (): Promise<void> => {
    const msg = message.trim()
    if (!msg || committing) return
    setCommitting(true)
    const res = await window.cockpit.gitCommit(row.id, msg)
    setCommitting(false)
    if (res.ok) {
      store.pushToast('info', `Committed ${res.hash ?? ''} on ${changes?.branch ?? 'branch'}`)
      setMessage('')
    } else {
      store.pushToast('error', res.error ?? 'Commit failed')
    }
    void refresh()
  }

  const files = changes?.files ?? []

  return (
    <aside className="changes-panel">
      <div className="changes-head">
        <GitBranch size={13} />
        <span className="changes-branch" title={changes?.branch}>
          {changes?.branch || '…'}
        </span>
        <span className="changes-count">{files.length}</span>
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()}>
          <RotateCw size={13} />
        </button>
        <button className="icon-btn" title="Hide panel" onClick={() => store.setChangesPanel(row.id, false)}>
          <X size={13} />
        </button>
      </div>

      <div className="changes-body">
        {changes === null && (
          <div className="changes-empty">
            <Loader2 size={16} className="spin" /> Reading the working tree…
          </div>
        )}
        {changes && !changes.ok && <div className="changes-empty bad">{changes.error}</div>}
        {changes?.ok && files.length === 0 && (
          <div className="changes-empty">
            Working tree is clean. Everything the agent does to the repo shows up here, live.
          </div>
        )}
        {files.map((f) => (
          <FileRow key={f.path} row={row} file={f} onChanged={() => void refresh()} />
        ))}
      </div>

      {changes?.ok && files.length > 0 && (
        <div className="changes-commit">
          <input
            value={message}
            placeholder="Commit message…"
            spellCheck={false}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void commit()}
          />
          <button className="btn primary small" disabled={!message.trim() || committing} onClick={() => void commit()}>
            {committing ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Commit all
          </button>
        </div>
      )}
    </aside>
  )
}
