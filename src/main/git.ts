import { execFile } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
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
        // untracked files aren't in `diff HEAD` — count their lines directly
        try {
          const st = statSync(path.join(dir, file))
          if (st.isFile() && st.size < 2 * 1024 * 1024) {
            additions = Number((await noIndexNumstat(dir, file)).split('\t')[0]) || 0
          }
        } catch {
          /* directory or unreadable — leave 0 */
        }
      }
      files.push({ path: file, status: statusOf(xy), additions, deletions })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { ok: true, branch, files }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const friendly = /not a git repository/i.test(msg)
      ? 'Not a git repository — initialize one to track the agent’s changes.'
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
