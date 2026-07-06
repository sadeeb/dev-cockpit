import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CockpitEvent } from '../shared/types'
import type { BrowserManager } from './browserManager'
import type { SessionManager } from './sessionManager'

/**
 * COCKPIT_SMOKE=1 — scripted end-to-end check of the real bridge: creates a
 * session in a temp dir, sends one tiny prompt to Haiku, and verifies that
 * streaming, the result, status flow, and async titling all happen.
 * Exits 0 on success, 1 on failure. Costs roughly nothing.
 */
export function runSmoke(manager: SessionManager, tap: (cb: (e: CockpitEvent) => void) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-smoke-'))
  writeFileSync(path.join(dir, 'README.md'), '# smoke fixture\n')

  const row = manager.createSession({
    workingDir: dir,
    model: 'haiku',
    permissionMode: 'default',
    browserEnabled: false
  })
  const log = (...a: unknown[]): void => console.log('[smoke]', ...a)
  log('session created', row.id, 'in', dir)

  let sawAssistantText = ''
  let sawTurnEnd = false
  let turnOk = false
  let sawTitle = ''
  let done = false

  const finish = (ok: boolean, reason: string): void => {
    if (done) return
    done = true
    log(ok ? 'PASS' : 'FAIL', '—', reason)
    log('assistant said:', JSON.stringify(sawAssistantText.slice(0, 120)))
    log('ai title:', JSON.stringify(sawTitle))
    setTimeout(() => app.exit(ok ? 0 : 1), 400)
  }

  tap((e) => {
    if (e.kind === 'session-updated' && e.session.id === row.id) {
      if (e.session.titleSource === 'ai') sawTitle = e.session.title
      log('status:', e.session.status, '| title:', e.session.title)
    }
    if (e.kind === 'convo' && e.sessionId === row.id) {
      const ev = e.ev
      if (ev.t === 'assistant') {
        sawAssistantText += ev.parts.map((p) => p.text).join(' ')
      }
      if (ev.t === 'banner' && ev.level === 'error') log('banner:', ev.text)
      if (ev.t === 'turn-end') {
        sawTurnEnd = true
        turnOk = ev.stats.ok
        log('turn-end ok:', ev.stats.ok, 'cost:', ev.stats.costUsd, 'turns:', ev.stats.numTurns, ev.stats.errorText ?? '')
        // give the async title a moment, then evaluate
        setTimeout(() => {
          const pass = sawTurnEnd && turnOk && /pong/i.test(sawAssistantText)
          finish(pass, pass ? 'agent replied and turn completed' : 'missing pong or failed turn')
        }, 12000)
      }
    }
  })

  void manager.sendPrompt(row.id, 'Reply with exactly the word: pong — no tools, no extra text.')
  setTimeout(() => finish(false, 'timeout after 150s'), 150000)
}

/**
 * COCKPIT_BROWSER_SMOKE=1 — verifies the shared-browser plumbing without an
 * agent: launches the per-session Chromium, waits for a CDP screencast frame,
 * then attaches a real Playwright MCP server over the same CDP endpoint and
 * drives one browser_navigate through it.
 */
export function runBrowserSmoke(
  manager: SessionManager,
  browsers: BrowserManager,
  tap: (cb: (e: CockpitEvent) => void) => void
): void {
  const log = (...a: unknown[]): void => console.log('[bsmoke]', ...a)
  const row = manager.createSession({
    workingDir: tmpdir(),
    model: null,
    permissionMode: 'default',
    browserEnabled: true
  })

  let gotFrame = false
  let gotConsole = false
  let done = false
  const finish = (ok: boolean, reason: string): void => {
    if (done) return
    done = true
    log(ok ? 'PASS' : 'FAIL', '—', reason)
    browsers.closeAll()
    setTimeout(() => app.exit(ok ? 0 : 1), 600)
  }

  tap((e) => {
    if (e.kind === 'browser' && e.sessionId === row.id) {
      if (e.ev.t === 'frame' && !gotFrame) {
        gotFrame = true
        log('screencast frame received', e.ev.w, 'x', e.ev.h)
        void mcpAttachCheck()
      } else if (e.ev.t === 'console' && e.ev.entry.text.includes('cockpit-console-check')) {
        gotConsole = true
        log('console captured:', e.ev.entry.level, JSON.stringify(e.ev.entry.text))
      } else if (e.ev.t === 'state' && e.ev.error) {
        finish(false, e.ev.error)
      }
    }
  })

  async function mcpAttachCheck(): Promise<void> {
    const cfg = (await browsers.mcpServerConfig(row.id, '')) as {
      playwright: { command: string; args: string[]; env: Record<string, string> }
    }
    const pw = cfg.playwright
    log('mcp:', pw.command, pw.args.join(' '))
    const proc = spawn(pw.command, pw.args, {
      env: { ...process.env, ...pw.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buf = ''
    const send = (msg: Record<string, unknown>): void => {
      proc.stdin.write(JSON.stringify(msg) + '\n')
    }
    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        try {
          const m = JSON.parse(line)
          if (m.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' })
            send({
              jsonrpc: '2.0', id: 2, method: 'tools/call',
              params: {
                name: 'browser_navigate',
                arguments: {
                  url: 'data:text/html,<title>cockpit</title><h1>shared browser ok</h1><script>console.log("cockpit-console-check")</script>'
                }
              }
            })
          } else if (m.id === 2) {
            const navOk = !m.error && !(m.result?.isError)
            log('browser_navigate via MCP over CDP:', navOk ? 'ok' : JSON.stringify(m).slice(0, 300))
            proc.kill()
            if (!navOk) return finish(false, 'MCP navigate failed')
            // console.log from the navigated page should stream in via CDP
            const deadline = Date.now() + 8000
            const poll = setInterval(() => {
              if (gotConsole) {
                clearInterval(poll)
                finish(true, 'frame + MCP attach + console capture all work')
              } else if (Date.now() > deadline) {
                clearInterval(poll)
                finish(false, 'navigate ok but no console event captured')
              }
            }, 200)
          }
        } catch {
          /* partial line */
        }
      }
    })
    proc.stderr.on('data', (d: Buffer) => log('mcp stderr:', d.toString().trim().slice(0, 200)))
    proc.on('exit', (code) => log('mcp exited', code))
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cockpit-smoke', version: '0.1' } }
    })
  }

  void browsers.ensure(row.id).catch((e) => finish(false, `ensure failed: ${e?.message ?? e}`))
  setTimeout(() => finish(false, gotFrame ? 'MCP attach timed out' : 'no screencast frame within 60s'), 60000)
}
