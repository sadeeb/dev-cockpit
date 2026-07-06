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

export function Composer({
  row,
  convo,
  insert
}: {
  row: SessionRow
  convo: ConvoState
  insert?: { text: string; nonce: number }
}): ReactNode {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendOnEnter = store.state.settings?.sendOnEnter ?? true
  const busy = row.status === 'running' || row.status === 'waiting'

  useEffect(() => {
    ref.current?.focus()
  }, [row.id])

  // Panels (e.g. the browser console) drop text in; the user adds words and sends.
  const lastInsert = useRef(0)
  useEffect(() => {
    if (!insert || insert.nonce === lastInsert.current) return
    lastInsert.current = insert.nonce
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${insert.text}` : insert.text))
    ref.current?.focus()
  }, [insert])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    store.send(row.id, t)
    setText('')
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
      <div className={cx('composer', busy && 'busy')}>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          spellCheck={false}
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
            disabled={!text.trim()}
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
