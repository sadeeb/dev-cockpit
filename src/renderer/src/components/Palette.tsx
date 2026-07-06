import {
  Braces,
  GitBranch,
  GitFork,
  Globe,
  LayoutGrid,
  Link2,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { store, type AppState } from '../store'
import { baseName, cx } from '../util'

/**
 * ⌘K command palette: jump anywhere, toggle any panel, start anything -
 * the keyboard-first lane through mission control.
 */

interface Command {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  run: () => void
}

/** Subsequence fuzzy match; lower score = better, null = no match. */
function fuzzy(query: string, target: string): number | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return t.length
  let ti = 0
  let score = 0
  let lastHit = -1
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    score += found - lastHit - 1 // gaps cost
    lastHit = found
    ti = found + 1
  }
  return score + t.length * 0.01
}

function buildCommands(state: AppState): Command[] {
  const cmds: Command[] = []
  const activeId = state.view.kind === 'session' ? state.view.id : null

  for (const s of state.sessions) {
    cmds.push({
      id: `go-${s.id}`,
      label: s.title,
      hint: `${baseName(s.workingDir)} · ${s.status}`,
      icon: <span className={cx('side-dot', s.status)} />,
      run: () => store.selectSession(s.id)
    })
  }
  cmds.push(
    {
      id: 'board',
      label: 'Mission Control',
      hint: 'see every session',
      icon: <LayoutGrid size={14} />,
      run: () => store.showBoard()
    },
    {
      id: 'new',
      label: 'New session',
      hint: '⌘N',
      icon: <Plus size={14} />,
      run: () => store.openModal({ m: 'new-session' })
    },
    {
      id: 'settings',
      label: 'Settings',
      hint: '⌘,',
      icon: <Settings size={14} />,
      run: () => store.openModal({ m: 'settings' })
    }
  )
  if (activeId) {
    const id = activeId
    cmds.push(
      {
        id: 'toggle-browser',
        label: 'Toggle browser panel',
        icon: <Globe size={14} />,
        run: () => store.setBrowserPanel(id, !(state.browserPanel[id] ?? false))
      },
      {
        id: 'toggle-changes',
        label: 'Toggle changes panel',
        hint: 'diff · commit · discard',
        icon: <GitBranch size={14} />,
        run: () => store.setChangesPanel(id, !(state.changesPanel[id] ?? false))
      },
      {
        id: 'toggle-procs',
        label: 'Toggle processes panel',
        hint: 'dev server logs',
        icon: <SquareTerminal size={14} />,
        run: () => store.setProcPanel(id, !(state.procPanel[id] ?? false))
      },
      {
        id: 'toggle-drawer',
        label: 'Toggle raw event stream',
        icon: <Braces size={14} />,
        run: () => store.setDrawer(id, !(state.drawer[id] ?? false))
      },
      {
        id: 'fork',
        label: 'Fork this session',
        hint: 'branch the conversation',
        icon: <GitFork size={14} />,
        run: () => void store.forkSession(id)
      },
      {
        id: 'link-issue',
        label: 'Link a GitHub issue',
        icon: <Link2 size={14} />,
        run: () => store.openModal({ m: 'link-issue', id })
      },
      {
        id: 'delete-session',
        label: 'Delete this session…',
        icon: <Trash2 size={14} />,
        run: () => store.openModal({ m: 'delete-session', id })
      }
    )
  }
  return cmds
}

export function Palette({ state }: { state: AppState }): ReactNode {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const matches = useMemo(() => {
    const all = buildCommands(state)
    return all
      .map((c) => ({ c, score: fuzzy(query, `${c.label} ${c.hint ?? ''}`) }))
      .filter((m): m is { c: Command; score: number } => m.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map((m) => m.c)
  }, [query, state])

  useEffect(() => setSel(0), [query])
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (c: Command): void => {
    store.closeModal()
    c.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (matches[sel]) run(matches[sel])
    } else if (e.key === 'Escape') {
      store.closeModal()
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={() => store.closeModal()}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={14} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Jump to a session, toggle a panel, start something…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {matches.map((c, i) => (
            <button
              key={c.id}
              className={cx('palette-item', i === sel && 'selected')}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="palette-icon">{c.icon}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </button>
          ))}
          {matches.length === 0 && <div className="palette-empty">Nothing matches “{query}”.</div>}
        </div>
      </div>
    </div>
  )
}
