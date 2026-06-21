export interface IssueRef {
  repo: string | null // owner/repo, null when only `#123` was given
  number: number
}

const URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/(?:issues|pull)\/(\d+)/g
const OWNER_REPO_RE = /(?:^|[\s(])([A-Za-z0-9-]+)\/([\w.-]+?)#(\d+)\b/g
const BARE_RE = /(?:^|[\s(])#(\d+)\b/g

/**
 * Detect GitHub issue references in free text. Three forms, per spec:
 * a pasted URL, `owner/repo#123`, or a bare `#123` (repo inferred from cwd).
 */
export function parseIssueRefs(text: string): IssueRef[] {
  const out: IssueRef[] = []
  const seen = new Set<string>()
  const push = (repo: string | null, number: number) => {
    const key = `${repo ?? ''}#${number}`
    if (number > 0 && !seen.has(key)) {
      seen.add(key)
      out.push({ repo, number })
    }
  }

  for (const m of text.matchAll(URL_RE)) push(`${m[1]}/${m[2]}`, parseInt(m[3], 10))
  for (const m of text.matchAll(OWNER_REPO_RE)) push(`${m[1]}/${m[2]}`, parseInt(m[3], 10))
  for (const m of text.matchAll(BARE_RE)) push(null, parseInt(m[1], 10))
  return out
}

/** Parse a git remote URL into owner/repo, or null when not a GitHub remote. */
export function repoFromRemoteUrl(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}
