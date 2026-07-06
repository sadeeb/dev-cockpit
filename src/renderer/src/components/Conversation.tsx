import { ArrowDown, ChevronDown, ChevronRight, CircleAlert, GitBranch, Info } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionRow } from '../../../shared/types'
import type { ConvoItem, ConvoState } from '../store'
import { cx, fmtCost, fmtDuration, fmtTokens, timeAgo } from '../util'
import { Markdown } from './Markdown'
import { PermissionCard } from './PermissionCard'
import { ToolCard } from './ToolCard'

function Thinking({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Thinking
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

function Item({ item, streamingCaret }: { item: ConvoItem; streamingCaret: boolean }): ReactNode {
  switch (item.k) {
    case 'user':
      return (
        <div className="row user">
          <div className="row-label">You</div>
          <div className="user-bubble">
            {item.images && item.images.length > 0 && (
              <div className="user-images">
                {item.images.map((src, i) => (
                  <img key={i} src={src} alt={`attachment ${i + 1}`} />
                ))}
              </div>
            )}
            {item.text}
          </div>
        </div>
      )
    case 'context':
      return (
        <div className="row context">
          <GitBranch size={12} />
          <span>
            Issue context from <b>{item.repo}#{item.n}</b> was shared with the agent
          </span>
        </div>
      )
    case 'msg':
      return (
        <div className={cx('row msg', item.streaming && 'streaming')}>
          {item.parts.map((p, i) =>
            p.type === 'thinking' ? (
              <Thinking key={i} text={p.text} />
            ) : (
              <Markdown key={i} text={p.text + (streamingCaret && item.streaming && i === item.parts.length - 1 ? ' ▍' : '')} />
            )
          )}
        </div>
      )
    case 'tool':
      return <ToolCard tool={item.tool} />
    case 'perm':
      return <PermissionCard req={item.req} resolved={item.resolved} />
    case 'turn':
      return (
        <div className={cx('row turn', !item.stats.ok && 'turn-err')}>
          {item.stats.ok ? (
            <span>
              {item.stats.interrupted ? 'Interrupted' : 'Done'} · {fmtDuration(item.stats.durationMs)} ·{' '}
              {fmtTokens(item.stats.outputTokens)} tokens out
              {item.stats.costUsd > 0 ? ` · ${fmtCost(item.stats.costUsd)}` : ''}
            </span>
          ) : (
            <span>
              <CircleAlert size={12} /> {item.stats.errorText || 'The turn ended with an error'}
            </span>
          )}
        </div>
      )
    case 'banner':
      return (
        <div className={cx('row banner', item.level)}>
          {item.level === 'error' ? <CircleAlert size={13} /> : <Info size={13} />}
          <span>{item.text}</span>
        </div>
      )
  }
}

export function Conversation({ convo, row }: { convo: ConvoState; row: SessionRow }): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      pinnedRef.current = pinned
      setShowJump(!pinned)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  })

  const jump = (): void => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      pinnedRef.current = true
      setShowJump(false)
    }
  }

  return (
    <div className="convo-wrap">
      <div className="convo-scroll" ref={scrollRef}>
        <div className="convo">
          {convo.items.length === 0 && (
            <div className="convo-empty">
              <p className="convo-empty-title">{row.title === 'Untitled session' ? 'Fresh session' : row.title}</p>
              <p>
                Describe what to build or fix. Paste a GitHub issue URL — or <code>#123</code> — to link it; the agent
                starts with the issue context already loaded.
              </p>
              <p className="dim">Working in {row.workingDir}</p>
            </div>
          )}
          {convo.items.map((item) => (
            <Item key={item.key} item={item} streamingCaret />
          ))}
          {(row.status === 'running' || convo.spinner) && (
            <div className="row working">
              <span className="pulse-dot" />
              {convo.spinner === 'compacting'
                ? 'Compacting context…'
                : convo.spinner === 'linking issue'
                  ? 'Fetching linked issue…'
                  : convo.streaming
                    ? 'Writing…'
                    : 'Working…'}
              {convo.turnStartTs ? <Elapsed since={convo.turnStartTs} /> : null}
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button className="jump-latest" onClick={jump}>
          <ArrowDown size={13} /> Latest
        </button>
      )}
    </div>
  )
}

function Elapsed({ since }: { since: number }): ReactNode {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.floor((Date.now() - since) / 1000)
  return <span className="dim">{s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}</span>
}

export function lastActivity(convo: ConvoState | undefined, row: SessionRow): string {
  const last = convo?.items[convo.items.length - 1]
  return timeAgo(last?.ts ?? row.updatedAt)
}
