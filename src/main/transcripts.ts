import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AssistantPart, ConvoEvent, TodoItem, ToolUseStart } from '../shared/types'

/**
 * Claude Code keeps the canonical transcript as JSONL under
 * ~/.claude/projects/<munged-cwd>/<session-id>.jsonl. Per spec we don't store
 * transcripts ourselves — we replay CC's own file into conversation events so
 * a reopened session shows its full history.
 */
export function transcriptPath(cwd: string, claudeSessionId: string): string | null {
  const base = path.join(homedir(), '.claude', 'projects')
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const direct = path.join(base, munged, `${claudeSessionId}.jsonl`)
  if (existsSync(direct)) return direct
  if (!existsSync(base)) return null
  try {
    for (const dir of readdirSync(base)) {
      const p = path.join(base, dir, `${claudeSessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* ignore */
  }
  return null
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          const blk = b as Record<string, unknown>
          if (blk.type === 'text') return String(blk.text ?? '')
          if (blk.type === 'image') return '[image]'
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function loadTranscriptEvents(cwd: string, claudeSessionId: string): ConvoEvent[] {
  const file = transcriptPath(cwd, claudeSessionId)
  if (!file) return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const events: ConvoEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain) continue // subagent internals — keep history compact
    if (entry.isMeta) continue
    const ts = entry.timestamp ? Date.parse(String(entry.timestamp)) || Date.now() : Date.now()
    const message = entry.message as Record<string, unknown> | undefined

    if (entry.type === 'user' && message) {
      const content = message.content
      if (typeof content === 'string') {
        if (content.trim()) events.push({ t: 'user', text: content, ts })
        continue
      }
      if (Array.isArray(content)) {
        const texts: string[] = []
        for (const b of content) {
          const blk = b as Record<string, unknown>
          if (blk.type === 'tool_result') {
            events.push({
              t: 'tool-result',
              toolUseId: String(blk.tool_use_id ?? ''),
              ok: !blk.is_error,
              content: flattenContent(blk.content).slice(0, 20000),
              ts
            })
          } else if (blk.type === 'text') {
            texts.push(String(blk.text ?? ''))
          }
        }
        const joined = texts.join('\n').trim()
        if (joined && !joined.startsWith('<')) events.push({ t: 'user', text: joined, ts })
      }
      continue
    }

    if (entry.type === 'assistant' && message && Array.isArray(message.content)) {
      const parts: AssistantPart[] = []
      const toolUses: ToolUseStart[] = []
      for (const b of message.content) {
        const blk = b as Record<string, unknown>
        if (blk.type === 'text' && String(blk.text ?? '').trim()) {
          parts.push({ type: 'text', text: String(blk.text) })
        } else if (blk.type === 'thinking' && String(blk.thinking ?? '').trim()) {
          parts.push({ type: 'thinking', text: String(blk.thinking) })
        } else if (blk.type === 'tool_use') {
          const tu: ToolUseStart = {
            id: String(blk.id ?? ''),
            name: String(blk.name ?? 'Tool'),
            input: blk.input
          }
          toolUses.push(tu)
          if (tu.name === 'TodoWrite') {
            const todos = (tu.input as { todos?: TodoItem[] } | undefined)?.todos
            if (Array.isArray(todos)) events.push({ t: 'todos', todos, ts })
          }
        }
      }
      if (parts.length || toolUses.length) {
        events.push({
          t: 'assistant',
          id: String(entry.uuid ?? `${ts}-${events.length}`),
          chain: null,
          parts,
          toolUses,
          ts
        })
      }
    }
  }

  // Keep history bounded: very long sessions replay their most recent slice.
  const MAX = 1000
  return events.length > MAX ? events.slice(events.length - MAX) : events
}
