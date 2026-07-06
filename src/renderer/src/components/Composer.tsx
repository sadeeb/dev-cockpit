import { ChevronDown, ChevronUp, ListTodo, Send, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionRow } from '../../../shared/types'
import { store, type ConvoState } from '../store'
import { cx } from '../util'
import { TodoList } from './ToolCard'

export function TodoStrip({ convo }: { convo: ConvoState }): ReactNode {
  const [open, setOpen] = useState(false)
  if (!convo.todos.length) return null
  const done = convo.todos.filter((t) => t.status === 'completed').length
  const current = convo.todos.find((t) => t.status === 'in_progress')
  return (
    <div className="todo-strip">
      <button className="todo-strip-head" onClick={() => setOpen(!open)}>
        <ListTodo size={13} />
        <span className="todo-strip-count">
          Plan {done}/{convo.todos.length}
        </span>
        <span className="todo-strip-bar">
          <span style={{ width: `${convo.todos.length ? (done / convo.todos.length) * 100 : 0}%` }} />
        </span>
        {current && <span className="todo-strip-current">{current.activeForm || current.content}</span>}
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {open && (
        <div className="todo-strip-body">
          <TodoList todos={convo.todos} />
        </div>
      )}
    </div>
  )
}

/** data:<type>;base64,<data> → API image block parts */
function splitDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
  return m ? { mediaType: m[1], data: m[2] } : null
}

export function Composer({
  row,
  convo,
  insert
}: {
  row: SessionRow
  convo: ConvoState
  insert?: { text: string; images?: string[]; nonce: number }
}): ReactNode {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendOnEnter = store.state.settings?.sendOnEnter ?? true
  const busy = row.status === 'running' || row.status === 'waiting'

  useEffect(() => {
    ref.current?.focus()
  }, [row.id])

  // Panels (browser console, point-at-element) drop content in; the user adds words and sends.
  const lastInsert = useRef(0)
  useEffect(() => {
    if (!insert || insert.nonce === lastInsert.current) return
    lastInsert.current = insert.nonce
    if (insert.text) setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${insert.text}` : insert.text))
    if (insert.images?.length) setAttachments((a) => [...a, ...insert.images!].slice(0, 6))
    ref.current?.focus()
  }, [insert])

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = [...e.clipboardData.items].filter((it) => it.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    for (const it of files) {
      const f = it.getAsFile()
      if (!f) continue
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') setAttachments((a) => [...a, reader.result as string].slice(0, 6))
      }
      reader.readAsDataURL(f)
    }
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  const submit = (): void => {
    const t = text.trim()
    const images = attachments.map(splitDataUrl).filter((i): i is { mediaType: string; data: string } => i !== null)
    if (!t && !images.length) return
    store.send(row.id, t, images.length ? images : undefined)
    setText('')
    setAttachments([])
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      if ((sendOnEnter && plain) || e.metaKey || e.ctrlKey) {
        e.preventDefault()
        submit()
      }
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault()
      store.interrupt(row.id)
    }
  }

  return (
    <div className="composer-zone">
      <TodoStrip convo={convo} />
      {convo.queue.length > 0 && (
        <div className="queue-chips">
          {convo.queue.map((q, i) => (
            <span className="queue-chip" key={i} title={q}>
              queued: {q.slice(0, 48)}
              {q.length > 48 ? '…' : ''}
              <button onClick={() => store.cancelQueued(row.id, i)} aria-label="Remove from queue">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attach-row">
          {attachments.map((a, i) => (
            <span className="attach-chip" key={i}>
              <img src={a} alt={`attachment ${i + 1}`} />
              <button aria-label="Remove attachment" onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={cx('composer', busy && 'busy')}>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          spellCheck={false}
          onPaste={onPaste}
          placeholder={
            row.firstPromptSent
              ? busy
                ? 'Type to queue the next instruction… (Esc to stop the agent)'
                : 'Reply, or give the next task…'
              : 'Describe what to build or fix… Paste a GitHub issue URL to link it'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-side">
          {busy && (
            <button className="btn stop" title="Stop the agent (Esc)" onClick={() => store.interrupt(row.id)}>
              <Square size={12} fill="currentColor" /> Stop
            </button>
          )}
          <button
            className="btn send"
            title={sendOnEnter ? 'Send (Enter)' : 'Send (⌘Enter)'}
            disabled={!text.trim() && attachments.length === 0}
            onClick={submit}
          >
            <Send size={14} />
            {busy ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
      <div className="composer-hint">
        {sendOnEnter ? 'Enter to send · Shift+Enter for a new line' : '⌘Enter to send'}
        {busy ? ' · Esc to stop' : ''}
      </div>
    </div>
  )
}
