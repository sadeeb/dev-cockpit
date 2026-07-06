import type { GithubLink, TitleSource } from './types'

/**
 * Title precedence, highest wins (spec §5):
 *   1. manual  - the user's text
 *   2. issue   - `#142 · Login redirect loops on Safari`
 *   3. ai      - generated from the first prompt
 *   4. default - `Untitled session`
 *
 * Returns the new {title, source} for a proposed update, or null when the
 * existing title outranks the proposal and must be kept.
 */
const RANK: Record<TitleSource, number> = { manual: 3, issue: 2, ai: 1, default: 0 }

export function proposeTitle(
  current: { title: string; titleSource: TitleSource },
  proposal: { title: string; source: TitleSource }
): { title: string; titleSource: TitleSource } | null {
  if (RANK[proposal.source] >= RANK[current.titleSource]) {
    return { title: proposal.title, titleSource: proposal.source }
  }
  return null
}

export function issueTitle(link: Pick<GithubLink, 'issueNumber' | 'issueTitle'>): string {
  return `#${link.issueNumber} · ${link.issueTitle}`
}

/** Clean up a model-generated title: strip quotes/punctuation, clamp length. */
export function sanitizeTitle(raw: string): string {
  let t = raw.trim().split('\n')[0].trim()
  t = t.replace(/^["'`“”]+|["'`“”.!]+$/g, '').trim()
  if (t.length > 64) t = t.slice(0, 61).trimEnd() + '…'
  if (t.length > 0) t = t[0].toUpperCase() + t.slice(1)
  return t
}

/** Heuristic fallback when the title model is unavailable. */
export function heuristicTitle(prompt: string): string {
  const words = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 7)
    .join(' ')
  return sanitizeTitle(words || 'Untitled session')
}
