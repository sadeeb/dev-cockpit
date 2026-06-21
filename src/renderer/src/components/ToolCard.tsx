import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  MousePointerClick,
  NotebookPen,
  Search,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { diffLines } from '../../../shared/diff'
import type { TodoItem } from '../../../shared/types'
import type { ConvoItem, ToolView } from '../store'
import { baseName, cx, fmtTokens } from '../util'
import { Markdown } from './Markdown'

const input = (t: ToolView): Record<string, unknown> =>
  (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

interface ToolMeta {
  icon: ReactNode
  label: string
  summary: string
  autoExpand?: boolean
  body?: ReactNode
}

function playwrightLabel(name: string): string {
  const action = name.replace('mcp__playwright__browser_', '').replace('mcp__playwright__', '')
  const labels: Record<string, string> = {
    navigate: 'Navigate browser',
    snapshot: 'Read page snapshot',
    click: 'Click element',
    type: 'Type into element',
    fill_form: 'Fill form',
    take_screenshot: 'Screenshot page',
    console_messages: 'Read console',
    network_requests: 'Read network log',
    evaluate: 'Run script in page',
    wait_for: 'Wait for page',
    tabs: 'Manage tabs',
    resize: 'Resize browser',
    press_key: 'Press key',
    select_option: 'Select option',
    hover: 'Hover element',
    drag: 'Drag element',
    handle_dialog: 'Handle dialog',
    file_upload: 'Upload file'
  }
  return labels[action] ?? `Browser: ${action.replace(/_/g, ' ')}`
}

function metaFor(tool: ToolView): ToolMeta {
  const inp = input(tool)
  switch (tool.name) {
    case 'Bash':
      return {
        icon: <SquareTerminal size={14} />,
        label: 'Shell',
        summary: str(inp.command).split('\n')[0],
        body: (
          <>
            <pre className="tool-pre cmd">{str(inp.command)}</pre>
            {tool.result !== undefined && <ResultBlock tool={tool} />}
          </>
        )
      }
    case 'Read':
      return {
        icon: <FileText size={14} />,
        label: 'Read',
        summary: str(inp.file_path),
        body: <ResultBlock tool={tool} mono />
      }
    case 'Edit': {
      const lines = diffLines(str(inp.old_string), str(inp.new_string))
      return {
        icon: <FilePen size={14} />,
        label: 'Edit',
        summary: str(inp.file_path),
        autoExpand: true,
        body: (
          <div className="diff">
            {lines.map((l, i) => (
              <div key={i} className={`diff-line ${l.kind}`}>
                <span className="diff-gutter">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
                <span>{l.text || ' '}</span>
              </div>
            ))}
          </div>
        )
      }
    }
    case 'Write': {
      const content = str(inp.content)
      return {
        icon: <FilePlus size={14} />,
        label: 'Write',
        summary: str(inp.file_path),
        autoExpand: true,
        body: (
          <pre className="tool-pre">
            {content.split('\n').slice(0, 24).join('\n')}
            {content.split('\n').length > 24 ? `\n… ${content.split('\n').length - 24} more lines` : ''}
          </pre>
        )
      }
    }
    case 'TodoWrite': {
      const todos = (inp.todos as TodoItem[] | undefined) ?? []
      const done = todos.filter((t) => t.status === 'completed').length
      return {
        icon: <ListTodo size={14} />,
        label: 'Plan',
        summary: `${done}/${todos.length} done`,
        autoExpand: true,
        body: <TodoList todos={todos} />
      }
    }
    case 'Grep':
      return {
        icon: <Search size={14} />,
        label: 'Search',
        summary: `${str(inp.pattern)}${inp.path ? ` in ${baseName(str(inp.path))}` : ''}`,
        body: <ResultBlock tool={tool} mono />
      }
    case 'Glob':
      return {
        icon: <Search size={14} />,
        label: 'Find files',
        summary: str(inp.pattern),
        body: <ResultBlock tool={tool} mono />
      }
    case 'Task':
      return {
        icon: <Bot size={14} />,
        label: 'Subagent',
        summary: str(inp.description) || str(inp.subagent_type),
        autoExpand: true,
        body: <SubagentBody tool={tool} />
      }
    case 'ExitPlanMode':
      return {
        icon: <NotebookPen size={14} />,
        label: 'Proposed plan',
        summary: '',
        autoExpand: true,
        body: <Markdown text={str(inp.plan)} />
      }
    case 'WebFetch':
      return {
        icon: <Globe size={14} />,
        label: 'Fetch URL',
        summary: str(inp.url),
        body: <ResultBlock tool={tool} />
      }
    case 'WebSearch':
      return {
        icon: <Globe size={14} />,
        label: 'Web search',
        summary: str(inp.query),
        body: <ResultBlock tool={tool} />
      }
  }
  if (tool.name.startsWith('mcp__playwright__')) {
    const summary =
      str(inp.url) || str(inp.element) || str(inp.text) || str(inp.key) || ''
    return {
      icon: <MousePointerClick size={14} />,
      label: playwrightLabel(tool.name),
      summary,
      body: <ResultBlock tool={tool} mono />
    }
  }
  return {
    icon: <Wrench size={14} />,
    label: tool.name.replace(/^mcp__(\w+)__/, '$1: ').replace(/_/g, ' '),
    summary: summarizeInput(input(tool)),
    body: (
      <>
        <pre className="tool-pre">{JSON.stringify(tool.input, null, 2)?.slice(0, 2000)}</pre>
        {tool.result !== undefined && <ResultBlock tool={tool} mono />}
      </>
    )
  }
}

function summarizeInput(inp: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'command', 'url', 'query', 'pattern', 'prompt', 'description']) {
    if (typeof inp[key] === 'string' && inp[key]) return String(inp[key])
  }
  const first = Object.values(inp).find((v) => typeof v === 'string') as string | undefined
  return first ?? ''
}

function ResultBlock({ tool, mono }: { tool: ToolView; mono?: boolean }): ReactNode {
  if (tool.result === undefined) return null
  const text = tool.result.length > 6000 ? tool.result.slice(0, 6000) + '\n… (truncated)' : tool.result
  if (!text.trim()) return <div className="tool-empty">No output</div>
  return <pre className={cx('tool-pre result', mono && 'mono', tool.ok === false && 'err')}>{text}</pre>
}

export function TodoList({ todos }: { todos: TodoItem[] }): ReactNode {
  return (
    <ul className="todo-list">
      {todos.map((t, i) => (
        <li key={i} className={`todo ${t.status}`}>
          <span className="todo-box">
            {t.status === 'completed' ? <Check size={11} /> : t.status === 'in_progress' ? <Loader2 size={11} className="spin" /> : null}
          </span>
          <span className="todo-text">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  )
}

function SubagentBody({ tool }: { tool: ToolView }): ReactNode {
  const inp = input(tool)
  return (
    <div className="subagent">
      {str(inp.prompt) && <div className="subagent-prompt">{str(inp.prompt).slice(0, 400)}</div>}
      {tool.task && (
        <div className="subagent-task">
          <Loader2 size={12} className={tool.task.done ? '' : 'spin'} />
          <span>{tool.task.summary || tool.task.description}</span>
          {tool.task.totalTokens ? <span className="dim">{fmtTokens(tool.task.totalTokens)} tok</span> : null}
        </div>
      )}
      {tool.children.length > 0 && <NestedItems items={tool.children} />}
      {tool.result !== undefined && <ResultBlock tool={tool} />}
    </div>
  )
}

function NestedItems({ items }: { items: ConvoItem[] }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="nested">
      <button className="nested-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {items.length} subagent step{items.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="nested-body">
          {items.map((it) =>
            it.k === 'msg' ? (
              <div key={it.key} className="nested-msg">
                {it.parts.filter((p) => p.type === 'text').map((p, i) => <Markdown key={i} text={p.text} />)}
              </div>
            ) : it.k === 'tool' ? (
              <ToolCard key={it.key} tool={it.tool} />
            ) : null
          )}
        </div>
      )}
    </div>
  )
}

export function ToolCard({ tool }: { tool: ToolView }): ReactNode {
  const meta = metaFor(tool)
  const failed = tool.ok === false
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (meta.autoExpand || failed) ?? false

  return (
    <div className={cx('tool-card', tool.running && 'running', failed && 'failed')}>
      <button className="tool-head" onClick={() => setOpen(!expanded)}>
        <span className="tool-icon">{meta.icon}</span>
        <span className="tool-label">{meta.label}</span>
        {meta.summary && <span className="tool-summary">{meta.summary}</span>}
        <span className="tool-status">
          {tool.running ? (
            <Loader2 size={13} className="spin accent" />
          ) : failed ? (
            <CircleAlert size={13} className="bad" />
          ) : tool.ok ? (
            <Check size={13} className="good" />
          ) : null}
        </span>
        {meta.body ? (expanded ? <ChevronDown size={13} className="dim" /> : <ChevronRight size={13} className="dim" />) : <span style={{ width: 13 }} />}
      </button>
      {expanded && meta.body && <div className="tool-body">{meta.body}</div>}
      {!expanded && failed && tool.result && (
        <div className="tool-body">
          <pre className="tool-pre result err">{tool.result.slice(0, 400)}</pre>
        </div>
      )}
    </div>
  )
}

export function PermIcon({ ok }: { ok: boolean }): ReactNode {
  return ok ? <Check size={12} /> : <X size={12} />
}
