import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GitChanges, GitCommitResult, GitFileChange } from '../shared/types'
import { getFixedPath } from './env'

const exec = promisify(execFile)

/**
 * Per-session git awareness: the Changes panel reads the working tree so the
 * human can watch the agent's edits accumulate, then commit or discard from
 * mission control instead of dropping to a terminal.
 */

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, ...args], {
    env: { ...process.env, PATH: getFixedPath() },
    maxBuffer: 16 * 1024 * 1024
  })
  return stdout
}

function statusOf(xy: string): GitFileChange['status'] {
  if (xy === '??') return '?'
  const c = (xy[0] !== ' ' && xy[0] !== '?' ? xy[0] : xy[1]) as string
  if (c === 'M' || c === 'A' || c === 'D' || c === 'R' || c === 'U') return c
  return 'M'
}

export async function gitChanges(dir: string): Promise<GitChanges> {
  try {
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const porcelain = await git(dir, ['status', '--porcelain'])
    const counts = new Map<string, { add: number; del: number }>()
    const numstat = await git(dir, ['diff', 'HEAD', '--numstat']).catch(() => '')
    for (const line of numstat.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (m) counts.set(m[3], { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) })
    }

    const files: GitFileChange[] = []
    for (const raw of porcelain.split('\n')) {
      if (!raw.trim()) continue
      const xy = raw.slice(0, 2)
      let file = raw.slice(3)
      if (file.includes(' -> ')) file = file.split(' -> ')[1]
      if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1)
      const c = counts.get(file)
      let additions = c?.add ?? 0
      const deletions = c?.del ?? 0
      if (xy === '??' && !c) {
        // untracked files aren't in `diff HEAD` - count their lines directly
        try {
          const st = statSync(path.join(dir, file))
          if (st.isFile() && st.size < 2 * 1024 * 1024) {
            additions = Number((await noIndexNumstat(dir, file)).split('\t')[0]) || 0
          }
        } catch {
          /* directory or unreadable - leave 0 */
        }
      }
      files.push({ path: file, status: statusOf(xy), additions, deletions })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { ok: true, branch, files }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const friendly = /not a git repository/i.test(msg)
      ? 'Not a git repository. Initialize one to track the agent’s changes.'
      : msg.split('\n')[0]
    return { ok: false, error: friendly, branch: '', files: [] }
  }
}

/** `git diff --no-index` exits 1 when files differ; the output is still on stdout. */
async function noIndexNumstat(dir: string, file: string): Promise<string> {
  try {
    return await git(dir, ['diff', '--no-index', '--numstat', '/dev/null', file])
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? ''
  }
}

export async function gitFileDiff(dir: string, file: string): Promise<string> {
  const tracked = await git(dir, ['ls-files', '--error-unmatch', '--', file])
    .then(() => true)
    .catch(() => false)
  if (tracked) return git(dir, ['diff', 'HEAD', '--', file]).catch(() => '')
  try {
    return await git(dir, ['diff', '--no-index', '--', '/dev/null', file])
  } catch (e) {
    return (e as { stdout?: string }).stdout ?? ''
  }
}

export async function gitCommit(dir: string, message: string): Promise<GitCommitResult> {
  try {
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-m', message])
    const hash = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim()
    return { ok: true, hash }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg.split('\n').find((l) => l.trim()) ?? 'commit failed' }
  }
}

// ── worktrees: one branch + directory per session, derived (not stored) ──────
// A session "is a worktree session" when its git-dir differs from the common
// git-dir; the base repo and branch fall out of the same probe. Nothing about
// worktrees is persisted, so sessions survive schema-free.

export interface WorktreeInfo {
  isWorktree: boolean
  branch: string
  baseDir: string
}

const WORKTREE_MARKER = '.cockpit-worktrees'

export async function worktreeInfo(dir: string): Promise<WorktreeInfo | null> {
  try {
    const gitDir = (await git(dir, ['rev-parse', '--git-dir'])).trim()
    const common = (await git(dir, ['rev-parse', '--git-common-dir'])).trim()
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const isWorktree = path.resolve(dir, gitDir) !== path.resolve(dir, common)
    const baseDir = isWorktree ? path.dirname(path.resolve(dir, common)) : path.resolve(dir)
    return { isWorktree, branch, baseDir }
  } catch {
    return null
  }
}

export async function createWorktree(
  repoDir: string
): Promise<{ ok: boolean; dir?: string; branch?: string; error?: string }> {
  try {
    await git(repoDir, ['rev-parse', '--git-dir'])
  } catch {
    return { ok: false, error: 'Not a git repository, and worktree sessions need one.' }
  }
  try {
    const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '')
    const rand = Math.random().toString(36).slice(2, 6)
    const slug = `${stamp}-${rand}`
    const branch = `cockpit/${slug}`
    const dir = path.join(path.dirname(repoDir), `${path.basename(repoDir)}${WORKTREE_MARKER}`, slug)
    mkdirSync(path.dirname(dir), { recursive: true })
    await git(repoDir, ['worktree', 'add', '-b', branch, dir])
    return { ok: true, dir, branch }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg.split('\n').find((l) => l.includes('fatal')) ?? msg.split('\n')[0] }
  }
}

/**
 * Check a pull request out into a managed worktree for review: fetches
 * `pull/<n>/head` from origin (works for fork PRs too) into a local branch
 * and adds a worktree for it, without disturbing the main checkout.
 */
export async function createPrWorktree(
  repoDir: string,
  pr: number
): Promise<{ ok: boolean; dir?: string; branch?: string; error?: string }> {
  try {
    await git(repoDir, ['remote', 'get-url', 'origin'])
  } catch {
    return { ok: false, error: 'This repo has no "origin" remote; PR review needs one.' }
  }
  const branch = `cockpit/pr-${pr}`
  const dir = path.join(path.dirname(repoDir), `${path.basename(repoDir)}${WORKTREE_MARKER}`, `pr-${pr}`)
  if (existsSync(dir)) {
    return { ok: false, error: `PR #${pr} is already checked out at ${dir}` }
  }
  try {
    // +refspec force-updates the branch so a re-review picks up new pushes
    await git(repoDir, ['fetch', 'origin', `+pull/${pr}/head:${branch}`])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: `Could not fetch PR #${pr} from origin: ${msg.split('\n').find((l) => l.includes('fatal')) ?? msg.split('\n')[0]}`
    }
  }
  try {
    mkdirSync(path.dirname(dir), { recursive: true })
    await git(repoDir, ['worktree', 'add', dir, branch])
    return { ok: true, dir, branch }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg.split('\n').find((l) => l.includes('fatal')) ?? msg.split('\n')[0] }
  }
}

/** Remove a worktree the cockpit created (never touches dirs it didn't make). The branch survives. */
export async function removeWorktree(dir: string): Promise<void> {
  if (!dir.includes(WORKTREE_MARKER)) return
  const info = await worktreeInfo(dir)
  if (!info?.isWorktree) return
  await git(info.baseDir, ['worktree', 'remove', '--force', dir]).catch(() => {})
}

/** Merge the session's branch back into whatever the base repo has checked out. */
export async function mergeWorktree(dir: string): Promise<GitCommitResult> {
  const info = await worktreeInfo(dir)
  if (!info?.isWorktree) return { ok: false, error: 'This session is not on a worktree branch.' }
  try {
    if ((await git(dir, ['status', '--porcelain'])).trim()) {
      return { ok: false, error: 'Commit this session’s changes first (Changes panel → Commit all).' }
    }
    if ((await git(info.baseDir, ['status', '--porcelain'])).trim()) {
      return { ok: false, error: 'The base repo has uncommitted changes. Clean it up before merging.' }
    }
    await git(info.baseDir, ['merge', '--no-edit', info.branch])
    const hash = (await git(info.baseDir, ['rev-parse', '--short', 'HEAD'])).trim()
    return { ok: true, hash }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const conflict = /CONFLICT|Automatic merge failed/i.test(msg)
    return {
      ok: false,
      error: conflict
        ? 'Merge conflict. Resolve it in the base repo (the merge was left in progress there).'
        : (msg.split('\n').find((l) => l.trim()) ?? 'merge failed')
    }
  }
}

export async function gitDiscard(dir: string, file: string): Promise<GitCommitResult> {
  try {
    const tracked = await git(dir, ['ls-files', '--error-unmatch', '--', file])
      .then(() => true)
      .catch(() => false)
    if (tracked) {
      await git(dir, ['checkout', 'HEAD', '--', file])
    } else {
      const target = path.resolve(dir, file)
      if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('path escapes working dir')
      rmSync(target, { force: true })
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) }
  }
}
