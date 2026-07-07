import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type {
  BrowserEvent,
  BrowserInputEvent,
  BrowserTab,
  ConsoleEntry,
  ConsoleLevel,
  InspectResult
} from '../shared/types'
import { CdpClient, activateTarget, listTargets, waitForCdp } from './cdp'
import { findChrome, findNode, getFixedPath } from './env'

/**
 * The shared-browser upgrade (spec §7): one Chromium per session, launched
 * headless with remote debugging. The Playwright MCP attaches to the same
 * instance over CDP, and we screencast it into mission control - so the human
 * and the agent literally share one browser surface, entirely inside the app
 * (no separate desktop window). Console output, JS exceptions, and failed
 * network requests are captured over CDP so they can be sent to the agent.
 */

interface LiveBrowser {
  port: number
  proc: ChildProcess
  page: CdpClient | null
  tabs: BrowserTab[]
  activeTabId: string | null
  url: string
  pollTimer: ReturnType<typeof setInterval> | null
  lastFrameAt: number
  starting: boolean
  closing: boolean
  consoleSeq: number
  consoleWindowStart: number
  consoleWindowCount: number
}

export class BrowserManager {
  private live = new Map<string, LiveBrowser>()

  constructor(
    private profilesDir: string,
    private emit: (sessionId: string, ev: BrowserEvent) => void,
    private getChromePath: () => string | undefined
  ) {}

  isRunning(sessionId: string): boolean {
    return this.live.has(sessionId) && !this.live.get(sessionId)!.closing
  }

  port(sessionId: string): number | null {
    return this.live.get(sessionId)?.port ?? null
  }

  /** Reserve a port up front so the MCP server config can exist before launch. */
  private reserved = new Map<string, number>()

  async reservePort(sessionId: string): Promise<number> {
    const running = this.live.get(sessionId)
    if (running) return running.port
    const existing = this.reserved.get(sessionId)
    if (existing) return existing
    const port = await freePort()
    this.reserved.set(sessionId, port)
    return port
  }

  async ensure(sessionId: string): Promise<void> {
    const existing = this.live.get(sessionId)
    if (existing && !existing.closing) {
      if (existing.starting) await this.waitUntilUp(sessionId, 15000)
      return
    }

    const chrome = findChrome(this.getChromePath())
    if (!chrome) {
      this.emit(sessionId, {
        t: 'state',
        running: false,
        error: 'No Chromium-based browser found. Install Google Chrome or run `npx playwright install chromium`.'
      })
      throw new Error('no-chrome')
    }

    const port = await this.reservePort(sessionId)
    this.reserved.delete(sessionId)
    const profile = path.join(this.profilesDir, sessionId)
    mkdirSync(profile, { recursive: true })

    const proc = spawn(
      chrome,
      [
        // Headless: the embedded panel is the only browser surface - no
        // separate desktop window competing with the app for attention.
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=DefaultBrowserPromo',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--window-size=1280,860',
        'about:blank'
      ],
      { stdio: 'ignore', env: { ...process.env, PATH: getFixedPath() } }
    )

    const lb: LiveBrowser = {
      port,
      proc,
      page: null,
      tabs: [],
      activeTabId: null,
      url: 'about:blank',
      pollTimer: null,
      lastFrameAt: 0,
      starting: true,
      closing: false,
      consoleSeq: 0,
      consoleWindowStart: 0,
      consoleWindowCount: 0
    }
    this.live.set(sessionId, lb)
    this.emit(sessionId, { t: 'state', running: false, starting: true })

    proc.on('exit', () => {
      const cur = this.live.get(sessionId)
      if (cur === lb) {
        this.teardown(sessionId, lb)
        this.emit(sessionId, { t: 'state', running: false })
      }
    })

    const up = await waitForCdp(port, 20000)
    if (!up) {
      this.emit(sessionId, { t: 'state', running: false, error: 'Browser did not expose its debugging port in time.' })
      this.close(sessionId)
      throw new Error('cdp-timeout')
    }
    lb.starting = false
    await this.refreshTabs(sessionId, lb, true)
    lb.pollTimer = setInterval(() => void this.refreshTabs(sessionId, lb, false), 2500)
  }

  private async waitUntilUp(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const lb = this.live.get(sessionId)
      if (!lb || lb.closing) return
      if (!lb.starting) return
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  private async refreshTabs(sessionId: string, lb: LiveBrowser, attachFirst: boolean): Promise<void> {
    if (lb.closing) return
    let targets
    try {
      targets = await listTargets(lb.port)
    } catch {
      return
    }
    const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    lb.tabs = pages.map((p) => ({ id: p.id, title: p.title || p.url, url: p.url }))

    const activeGone = !pages.some((p) => p.id === lb.activeTabId)
    if ((attachFirst && !lb.page) || (activeGone && pages.length > 0)) {
      const target = pages[0]
      if (target?.webSocketDebuggerUrl) await this.attach(sessionId, lb, target.id, target.webSocketDebuggerUrl)
    }
    this.emitState(sessionId, lb)
  }

  private async attach(sessionId: string, lb: LiveBrowser, targetId: string, wsUrl: string): Promise<void> {
    lb.page?.close()
    const client = new CdpClient(targetId)
    try {
      await client.connect(wsUrl)
    } catch {
      return
    }
    lb.page = client
    lb.activeTabId = targetId

    client.on('Page.screencastFrame', (params) => {
      const p = params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }
      client.cast('Page.screencastFrameAck', { sessionId: p.sessionId })
      const now = Date.now()
      if (now - lb.lastFrameAt < 100) return // ~10fps cap into the renderer
      lb.lastFrameAt = now
      this.emit(sessionId, {
        t: 'frame',
        dataUrl: `data:image/jpeg;base64,${p.data}`,
        w: p.metadata.deviceWidth,
        h: p.metadata.deviceHeight
      })
    })
    client.on('Page.frameNavigated', (params) => {
      const p = params as { frame?: { parentId?: string; url?: string } }
      if (p.frame && !p.frame.parentId && p.frame.url) {
        lb.url = p.frame.url
        this.emit(sessionId, { t: 'console-clear' })
        this.emitState(sessionId, lb)
      }
    })
    client.on('close', () => {
      if (lb.page === client) lb.page = null
    })

    client.on('Runtime.consoleAPICalled', (params) => {
      const p = params as {
        type: string
        args: RemoteObject[]
        stackTrace?: { callFrames?: { url?: string; lineNumber?: number }[] }
      }
      const levelMap: Record<string, ConsoleLevel> = {
        warning: 'warn',
        error: 'error',
        debug: 'debug',
        info: 'info',
        assert: 'error'
      }
      const frame = p.stackTrace?.callFrames?.[0]
      this.pushConsole(sessionId, lb, {
        level: levelMap[p.type] ?? 'log',
        source: 'console',
        text: p.args.map(formatRemoteObject).join(' '),
        url: frame?.url,
        line: frame?.lineNumber !== undefined ? frame.lineNumber + 1 : undefined
      })
    })
    client.on('Runtime.exceptionThrown', (params) => {
      const p = params as {
        exceptionDetails: {
          text: string
          url?: string
          lineNumber?: number
          exception?: { description?: string }
        }
      }
      const d = p.exceptionDetails
      this.pushConsole(sessionId, lb, {
        level: 'error',
        source: 'exception',
        text: d.exception?.description ?? d.text,
        url: d.url,
        line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined
      })
    })
    client.on('Log.entryAdded', (params) => {
      const p = params as {
        entry: { source: string; level: string; text: string; url?: string; lineNumber?: number }
      }
      // Runtime.* already covers console calls and JS errors - only take the
      // network channel here (failed requests, 4xx/5xx, CORS, mixed content).
      if (p.entry.source !== 'network') return
      this.pushConsole(sessionId, lb, {
        level: p.entry.level === 'error' ? 'error' : p.entry.level === 'warning' ? 'warn' : 'info',
        source: 'network',
        text: p.entry.text,
        url: p.entry.url,
        line: p.entry.lineNumber !== undefined ? p.entry.lineNumber + 1 : undefined
      })
    })

    try {
      await client.send('Page.enable')
      await client.send('Runtime.enable')
      await client.send('Log.enable')
      const info = lb.tabs.find((t) => t.id === targetId)
      if (info) lb.url = info.url
      await client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 65,
        maxWidth: 1600,
        maxHeight: 1100,
        everyNthFrame: 1
      })
    } catch {
      /* tab may have closed mid-attach; poller will recover */
    }
    this.emitState(sessionId, lb)
  }

  /** Forward a console entry, rate-limited so a log-spamming page can't flood IPC. */
  private pushConsole(sessionId: string, lb: LiveBrowser, e: Omit<ConsoleEntry, 'id' | 'ts'>): void {
    const now = Date.now()
    if (now - lb.consoleWindowStart > 1000) {
      lb.consoleWindowStart = now
      lb.consoleWindowCount = 0
    }
    lb.consoleWindowCount++
    if (lb.consoleWindowCount > 50) {
      if (lb.consoleWindowCount === 51) {
        this.emit(sessionId, {
          t: 'console',
          entry: { id: ++lb.consoleSeq, level: 'warn', source: 'console', text: '… console output truncated (page is logging very fast)', ts: now }
        })
      }
      return
    }
    this.emit(sessionId, { t: 'console', entry: { ...e, id: ++lb.consoleSeq, ts: now } })
  }

  private emitState(sessionId: string, lb: LiveBrowser): void {
    this.emit(sessionId, {
      t: 'state',
      running: !lb.closing && !lb.starting,
      starting: lb.starting,
      url: lb.url,
      tabs: lb.tabs,
      activeTabId: lb.activeTabId ?? undefined
    })
  }

  async selectTab(sessionId: string, tabId: string): Promise<void> {
    const lb = this.live.get(sessionId)
    if (!lb) return
    await activateTarget(lb.port, tabId)
    const targets = await listTargets(lb.port).catch(() => [])
    const t = targets.find((x) => x.id === tabId)
    if (t?.webSocketDebuggerUrl) await this.attach(sessionId, lb, t.id, t.webSocketDebuggerUrl)
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    const lb = this.live.get(sessionId)
    if (!lb?.page) return
    const full = /^https?:\/\//.test(url) ? url : `http://${url}`
    await lb.page.send('Page.navigate', { url: full }).catch(() => {})
  }

  input(sessionId: string, ev: BrowserInputEvent, frameW: number, frameH: number): void {
    const lb = this.live.get(sessionId)
    const page = lb?.page
    if (!page) return
    if (ev.t === 'mouse') {
      const type = ev.kind === 'down' ? 'mousePressed' : ev.kind === 'up' ? 'mouseReleased' : 'mouseMoved'
      page.cast('Input.dispatchMouseEvent', {
        type,
        x: Math.round(ev.x * frameW),
        y: Math.round(ev.y * frameH),
        button: ev.button,
        buttons: ev.kind === 'down' || ev.kind === 'move' ? 1 : 0,
        clickCount: ev.clickCount
      })
    } else if (ev.t === 'wheel') {
      page.cast('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(ev.x * frameW),
        y: Math.round(ev.y * frameH),
        deltaX: ev.deltaX,
        deltaY: ev.deltaY
      })
    } else if (ev.t === 'text') {
      page.cast('Input.insertText', { text: ev.text })
    } else if (ev.t === 'key') {
      page.cast('Input.dispatchKeyEvent', {
        type: ev.kind === 'down' ? 'rawKeyDown' : 'keyUp',
        key: ev.key,
        code: ev.code,
        modifiers: ev.modifiers,
        windowsVirtualKeyCode: keyCodeFor(ev.key),
        nativeVirtualKeyCode: keyCodeFor(ev.key)
      })
    }
  }

  /**
   * Point-at-element: resolve what's under the (normalized) cursor, build a
   * readable selector, and crop a screenshot around it - so the human can say
   * "this thing" to the agent instead of describing DOM by hand.
   */
  async inspect(sessionId: string, nx: number, ny: number): Promise<InspectResult | null> {
    const page = this.live.get(sessionId)?.page
    if (!page) return null
    const expr = `(() => {
      const x = Math.round(${Number(nx)} * innerWidth), y = Math.round(${Number(ny)} * innerHeight)
      const el = document.elementFromPoint(x, y)
      if (!el) return null
      const sel = (start) => {
        const parts = []
        let n = start
        while (n && n.nodeType === 1 && parts.length < 5) {
          if (n.id) { parts.unshift('#' + n.id); break }
          let p = n.tagName.toLowerCase()
          const cls = [...n.classList].slice(0, 2).join('.')
          if (cls) p += '.' + cls
          const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : []
          if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')'
          parts.unshift(p)
          n = n.parentElement
        }
        return parts.join(' > ')
      }
      const r = el.getBoundingClientRect()
      return JSON.stringify({
        selector: sel(el),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 160),
        html: el.outerHTML.slice(0, 600),
        rect: { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }
      })
    })()`
    try {
      const res = (await page.send('Runtime.evaluate', { expression: expr, returnByValue: true })) as {
        result?: { value?: unknown }
      }
      if (typeof res.result?.value !== 'string') return null
      const found = JSON.parse(res.result.value) as {
        selector: string
        text: string
        html: string
        rect: { x: number; y: number; w: number; h: number }
      }
      const pad = 12
      const clip = {
        x: Math.max(0, found.rect.x - pad),
        y: Math.max(0, found.rect.y - pad),
        width: Math.max(48, Math.min(found.rect.w + pad * 2, 1400)),
        height: Math.max(48, Math.min(found.rect.h + pad * 2, 1000)),
        scale: 1
      }
      const shot = (await page
        .send('Page.captureScreenshot', { format: 'png', clip })
        .catch(() => null)) as { data?: string } | null
      return {
        selector: found.selector,
        text: found.text,
        html: found.html,
        shot: shot?.data ? { mediaType: 'image/png', data: shot.data } : null
      }
    } catch {
      return null
    }
  }

  private teardown(sessionId: string, lb: LiveBrowser): void {
    lb.closing = true
    if (lb.pollTimer) clearInterval(lb.pollTimer)
    lb.page?.close()
    this.live.delete(sessionId)
  }

  close(sessionId: string): void {
    const lb = this.live.get(sessionId)
    if (!lb) return
    this.teardown(sessionId, lb)
    try {
      lb.proc.kill()
    } catch {
      /* already gone */
    }
    this.emit(sessionId, { t: 'state', running: false })
  }

  deleteProfile(sessionId: string): void {
    this.close(sessionId)
    try {
      rmSync(path.join(this.profilesDir, sessionId), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  closeAll(): void {
    for (const id of [...this.live.keys()]) this.close(id)
  }

  /** MCP server config that attaches Playwright to this session's browser. */
  async mcpServerConfig(sessionId: string, allowedOrigins: string): Promise<Record<string, unknown>> {
    const port = await this.reservePort(sessionId)
    const node = await findNode()
    // cli.js is not in the package's exports map - resolve it next to the entry.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js')
    const args = [cli, '--cdp-endpoint', `http://127.0.0.1:${port}`]
    if (allowedOrigins.trim()) args.push('--allowed-origins', allowedOrigins.trim())
    return {
      playwright: {
        type: 'stdio',
        command: node ?? 'node',
        args,
        env: { PATH: getFixedPath() }
      }
    }
  }
}

interface RemoteObject {
  type: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  preview?: { properties?: { name: string; value?: string }[]; overflow?: boolean }
}

/** Render a CDP RemoteObject roughly the way DevTools would, in one line. */
function formatRemoteObject(o: RemoteObject): string {
  if (o.type === 'string') return String(o.value)
  if (o.type === 'undefined') return 'undefined'
  if (o.unserializableValue) return o.unserializableValue
  if (o.value !== undefined) {
    try {
      return JSON.stringify(o.value)
    } catch {
      return String(o.value)
    }
  }
  if (o.preview?.properties) {
    const inner = o.preview.properties.map((p) => `${p.name}: ${p.value ?? '…'}`).join(', ')
    const body = `{${inner}${o.preview.overflow ? ', …' : ''}}`
    return o.subtype === 'array' ? `[${inner}${o.preview.overflow ? ', …' : ''}]` : body
  }
  return o.description ?? o.type
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
    srv.on('error', reject)
  })
}

const KEY_CODES: Record<string, number> = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34
}

function keyCodeFor(key: string): number {
  return KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
}
