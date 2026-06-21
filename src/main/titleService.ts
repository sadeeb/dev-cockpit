import { query } from '@anthropic-ai/claude-agent-sdk'
import { heuristicTitle, sanitizeTitle } from '../shared/titleResolve'
import { findNode, getFixedPath } from './env'

const SYSTEM = 'Return a 3-6 word title for the given coding request, sentence case, no quotes, no trailing punctuation. Reply with the title only.'

/**
 * Title generation (spec §4): async, keyed off the raw first prompt, never
 * blocks the agent. Uses the Anthropic API directly when an API key exists;
 * otherwise falls back to a tiny one-shot Agent SDK call so subscription
 * (OAuth) users get titles too. Always resolves to *something* — the
 * heuristic is the final fallback.
 */
export async function generateTitle(prompt: string): Promise<string> {
  const trimmed = prompt.replace(/\s+/g, ' ').trim().slice(0, 600)
  try {
    const viaApi = process.env.ANTHROPIC_API_KEY ? await titleViaApi(trimmed) : null
    const raw = viaApi ?? (await titleViaAgent(trimmed))
    const clean = raw ? sanitizeTitle(raw) : ''
    if (clean && clean.length >= 3) return clean
  } catch {
    /* fall through to heuristic */
  }
  return heuristicTitle(prompt)
}

async function titleViaApi(prompt: string): Promise<string | null> {
  // Lazy import keeps startup fast for OAuth users who never hit this path.
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ maxRetries: 1, timeout: 15000 })
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 64,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }]
  })
  const text = msg.content.find((b) => b.type === 'text')
  return text && text.type === 'text' ? text.text : null
}

async function titleViaAgent(prompt: string): Promise<string | null> {
  const node = await findNode()
  const q = query({
    prompt: `${SYSTEM}\n\n<request>\n${prompt}\n</request>`,
    options: {
      model: 'claude-haiku-4-5',
      maxTurns: 1,
      systemPrompt: SYSTEM,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      allowedTools: [],
      includePartialMessages: false,
      executable: node ? 'node' : undefined,
      env: { ...process.env, PATH: getFixedPath() }
    }
  })
  const timeout = setTimeout(() => q.close(), 45000)
  try {
    for await (const m of q) {
      if (m.type === 'result') {
        return m.subtype === 'success' ? m.result : null
      }
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}
