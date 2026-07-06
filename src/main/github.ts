import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { repoFromRemoteUrl } from '../shared/issueRefs'
import { getFixedPath, findGh } from './env'

const execFileP = promisify(execFile)

export interface ResolvedIssue {
  repo: string
  number: number
  title: string
  state: 'open' | 'closed'
  url: string
  body: string
  comments: { author: string; body: string }[]
}

/** owner/repo for a working dir, from its git origin remote. */
export async function inferRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 4000,
      env: { ...process.env, PATH: getFixedPath() }
    })
    return repoFromRemoteUrl(stdout)
  } catch {
    return null
  }
}

interface GhIssueJson {
  number: number
  title: string
  state: string
  url: string
  body: string
  comments?: { author?: { login?: string }; body?: string }[]
}

async function resolveViaGh(repo: string, num: number): Promise<ResolvedIssue | null> {
  const gh = await findGh()
  if (!gh) return null
  const fields = 'number,title,state,body,url,comments'
  const env = { ...process.env, PATH: getFixedPath() }
  for (const sub of ['issue', 'pr'] as const) {
    try {
      const { stdout } = await execFileP(gh, [sub, 'view', String(num), '-R', repo, '--json', fields], {
        timeout: 8000,
        env,
        maxBuffer: 4 * 1024 * 1024
      })
      const j = JSON.parse(stdout) as GhIssueJson
      return {
        repo,
        number: j.number,
        title: j.title,
        state: j.state.toLowerCase() === 'closed' || j.state.toLowerCase() === 'merged' ? 'closed' : 'open',
        url: j.url,
        body: j.body || '',
        comments: (j.comments || []).slice(-10).map((c) => ({
          author: c.author?.login || 'unknown',
          body: c.body || ''
        }))
      }
    } catch {
      // not an issue (maybe a PR) or gh failed - try next form
    }
  }
  return null
}

async function resolveViaApi(repo: string, num: number): Promise<ResolvedIssue | null> {
  const headers: Record<string, string> = {
    'User-Agent': 'dev-cockpit',
    Accept: 'application/vnd.github+json'
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
      headers,
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    const j = (await res.json()) as {
      number: number
      title: string
      state: string
      html_url: string
      body: string | null
      comments: number
    }
    let comments: { author: string; body: string }[] = []
    if (j.comments > 0) {
      try {
        const cr = await fetch(
          `https://api.github.com/repos/${repo}/issues/${num}/comments?per_page=100`,
          { headers, signal: AbortSignal.timeout(8000) }
        )
        if (cr.ok) {
          const list = (await cr.json()) as { user?: { login?: string }; body?: string }[]
          comments = list.slice(-10).map((c) => ({
            author: c.user?.login || 'unknown',
            body: c.body || ''
          }))
        }
      } catch {
        /* comments are best-effort */
      }
    }
    return {
      repo,
      number: j.number,
      title: j.title,
      state: j.state === 'closed' ? 'closed' : 'open',
      url: j.html_url,
      body: j.body || '',
      comments
    }
  } catch {
    return null
  }
}

/** Resolve via gh CLI when installed (free, already authenticated); fall back to the REST API. */
export async function resolveIssue(repo: string, num: number): Promise<ResolvedIssue | null> {
  return (await resolveViaGh(repo, num)) ?? (await resolveViaApi(repo, num))
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s)

/**
 * Context block injected into the session when an issue is linked, so the
 * agent starts already knowing the bug (spec §5 bonus).
 */
export function buildIssueContext(issue: ResolvedIssue): string {
  const lines = [
    `<github-issue repo="${issue.repo}" number="${issue.number}" state="${issue.state}">`,
    `Title: ${issue.title}`,
    `URL: ${issue.url}`,
    '',
    'Body:',
    clip(issue.body || '(no description)', 6000)
  ]
  if (issue.comments.length) {
    lines.push('', `Comments (latest ${issue.comments.length}):`)
    for (const c of issue.comments) {
      lines.push(`> @${c.author}:`, clip(c.body, 1200), '')
    }
  }
  lines.push('</github-issue>')
  return clip(lines.join('\n'), 14000)
}
