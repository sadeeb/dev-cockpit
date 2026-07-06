import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { PreflightCheck } from '../shared/types'

const execFileP = promisify(execFile)

let fixedPath: string | null = null
let nodeBin: string | null = null

/**
 * GUI apps on macOS don't inherit the user's login-shell PATH. Resolve it once
 * from the login shell and merge into process.env so every subprocess we (or
 * the Agent SDK) spawn can find node, gh, npx, etc.
 */
export async function fixPath(): Promise<string> {
  if (fixedPath) return fixedPath
  const fallbacks = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  let shellPath = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const { stdout } = await execFileP(shell, ['-lc', 'echo -n "$PATH"'], { timeout: 5000 })
    shellPath = stdout.trim()
  } catch {
    // login shell failed; fall back to defaults below
  }
  const parts = new Set<string>()
  for (const p of [...shellPath.split(':'), ...(process.env.PATH || '').split(':'), ...fallbacks]) {
    if (p) parts.add(p)
  }
  fixedPath = [...parts].join(':')
  process.env.PATH = fixedPath
  return fixedPath
}

export function getFixedPath(): string {
  return fixedPath || process.env.PATH || ''
}

export async function findNode(): Promise<string | null> {
  if (nodeBin) return nodeBin
  await fixPath()
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['node'], {
      timeout: 3000,
      env: { ...process.env, PATH: getFixedPath() }
    })
    const p = stdout.trim().split('\n')[0]
    if (p && existsSync(p)) {
      nodeBin = p
      return p
    }
  } catch {
    /* fall through to known locations */
  }
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
  const nvmDir = path.join(homedir(), '.nvm/versions/node')
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse()
      for (const v of versions) candidates.push(path.join(nvmDir, v, 'bin/node'))
    } catch {
      /* ignore */
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      nodeBin = c
      return c
    }
  }
  return null
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Arc.app/Contents/MacOS/Arc'
]

/** Find a Chromium-based browser for the shared-browser loop. */
export function findChrome(preferred?: string): string | null {
  if (preferred && existsSync(preferred)) return preferred
  if (process.env.COCKPIT_CHROME && existsSync(process.env.COCKPIT_CHROME)) {
    return process.env.COCKPIT_CHROME
  }
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c

  // Playwright's downloaded Chromium as a last resort
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright')
  if (existsSync(cache)) {
    try {
      const dirs = readdirSync(cache)
        .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
        .sort()
        .reverse()
      for (const d of dirs) {
        for (const sub of ['chrome-mac/Chromium.app', 'chrome-mac-arm64/Chromium.app']) {
          const p = path.join(cache, d, sub, 'Contents/MacOS/Chromium')
          if (existsSync(p)) return p
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

export function hasClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  if (existsSync(path.join(homedir(), '.claude/.credentials.json'))) return true
  if (existsSync(path.join(homedir(), '.claude/credentials.json'))) return true
  // On macOS, Claude Code keeps OAuth credentials in the Keychain; the
  // account marker in ~/.claude.json is the reliable on-disk signal.
  try {
    const cfg = path.join(homedir(), '.claude.json')
    if (existsSync(cfg)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const raw: string = require('node:fs').readFileSync(cfg, 'utf8')
      if (raw.includes('"oauthAccount"') || raw.includes('"primaryApiKey"')) return true
    }
  } catch {
    /* fall through */
  }
  return false
}

export async function findGh(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['gh'], {
      timeout: 3000,
      env: { ...process.env, PATH: getFixedPath() }
    })
    const p = stdout.trim().split('\n')[0]
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

export async function preflight(chromePath?: string): Promise<PreflightCheck[]> {
  await fixPath()
  const node = await findNode()
  const gh = await findGh()
  const chrome = findChrome(chromePath)
  const auth = hasClaudeAuth()
  return [
    {
      id: 'auth',
      label: 'Claude Code authentication',
      ok: auth,
      detail: auth ? 'Credentials found' : 'No credentials found',
      hint: auth ? undefined : 'Run `claude` in a terminal and log in, or set ANTHROPIC_API_KEY.'
    },
    {
      id: 'node',
      label: 'Node.js runtime',
      ok: !!node,
      detail: node ?? 'Not found on PATH',
      hint: node ? undefined : 'Install Node.js 18+ (https://nodejs.org). The agent engine runs on it.'
    },
    {
      id: 'gh',
      label: 'GitHub CLI (issue linking)',
      ok: !!gh,
      detail: gh ?? 'Not found, falling back to the public GitHub API',
      hint: gh ? undefined : 'Optional: `brew install gh && gh auth login` for private repos and higher rate limits.'
    },
    {
      id: 'chrome',
      label: 'Chromium browser (shared browser)',
      ok: !!chrome,
      detail: chrome ?? 'No Chromium-based browser found',
      hint: chrome ? undefined : 'Optional: install Google Chrome, or run `npx playwright install chromium`.'
    }
  ]
}
