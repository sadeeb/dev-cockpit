import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { BrowserInputEvent, CockpitEvent, SessionRow, SessionStatus, UiCommand } from '../shared/types'
import { BrowserManager } from './browserManager'
import { demoGitChanges, demoGitFileDiff, runDemo } from './demo'
import { fixPath, preflight } from './env'
import { createPrWorktree, createWorktree, gitChanges, gitCommit, gitDiscard, gitFileDiff, mergeWorktree, removeWorktree, worktreeInfo } from './git'
import { ProcessManager } from './processManager'
import { SessionManager } from './sessionManager'
import { Store } from './store'

const DEMO = process.env.COCKPIT_DEMO === '1'
const SMOKE = process.env.COCKPIT_SMOKE === '1'

let win: BrowserWindow | null = null
let store: Store
let browsers: BrowserManager
let manager: SessionManager
let procs: ProcessManager
let demoStarted = false
const eventTaps: ((e: CockpitEvent) => void)[] = []

function broadcast(e: CockpitEvent): void {
  win?.webContents.send('cockpit:event', e)
  for (const tap of eventTaps) tap(e)
  if (e.kind === 'session-updated') onStatusMaybeChanged(e.session)
  else if (e.kind === 'session-removed') {
    lastStatus.delete(e.sessionId)
    updateBadge()
  } else if (e.kind === 'sessions') {
    for (const s of e.sessions) lastStatus.set(s.id, s.status) // seed silently
    updateBadge()
  }
}

// ── attention: dock badge + native notifications ──────────────────────────────
// The badge counts sessions that need a human; notifications only fire while
// the window is unfocused - if you're looking at the app, you already know.

const lastStatus = new Map<string, SessionStatus>()

function updateBadge(): void {
  const n = manager?.listSessions().filter((s) => s.status === 'waiting' || s.status === 'error').length ?? 0
  app.setBadgeCount(n)
}

function onStatusMaybeChanged(row: SessionRow): void {
  const prev = lastStatus.get(row.id)
  lastStatus.set(row.id, row.status)
  updateBadge()
  if (prev === undefined || prev === row.status) return
  if (!store.getSettings().notifications || !Notification.isSupported()) return
  if (win?.isFocused()) return

  let title: string | null = null
  if (row.status === 'waiting') title = 'Needs you'
  else if (row.status === 'error') title = 'Session hit an error'
  else if (row.status === 'done' && prev === 'running') title = 'Agent finished'
  if (!title) return

  const n = new Notification({ title: `${title} · Argus`, body: row.title, silent: row.status === 'done' })
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    sendUiCommand({ c: 'select-session', id: row.id })
  })
  n.show()
}

function sendUiCommand(command: UiCommand): void {
  broadcast({ kind: 'ui-command', command })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1020,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0d13',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 17 },
    title: 'Argus',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      e.preventDefault()
      if (url.startsWith('http')) void shell.openExternal(url)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  // Self-verification harness: COCKPIT_SHOT=/tmp/x.png captures the window.
  const shot = process.env.COCKPIT_SHOT
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win!.webContents.capturePage()
          writeFileSync(shot, img.toPNG())
          console.log(`[cockpit] screenshot written to ${shot}`)
        } catch (e) {
          console.error('[cockpit] screenshot failed', e)
        }
        if (process.env.COCKPIT_SHOT_EXIT === '1') app.quit()
      }, Number(process.env.COCKPIT_SHOT_DELAY || 2200))
    })
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ label: 'Argus', submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendUiCommand({ c: 'open-settings' }) }, { type: 'separator' as const }, { role: 'hide' as const }, { role: 'quit' as const }] }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => sendUiCommand({ c: 'new-session' }) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Mission Control', accelerator: 'CmdOrCtrl+B', click: () => sendUiCommand({ c: 'toggle-board' }) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Session ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => sendUiCommand({ c: 'select-session-index', index: i })
        })),
        { type: 'separator' },
        { role: 'reload' as const },
        { role: 'toggleDevTools' as const }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

type Handler = (...args: never[]) => unknown

function registerIpc(): void {
  const handlers: Record<string, Handler> = {
    listSessions: () => manager.listSessions(),
    createSession: async (
      opts: Parameters<SessionManager['createSession']>[0] & { useWorktree?: boolean; reviewPr?: string }
    ) => {
      // typed paths arrive raw: expand ~ and trim, or every child process
      // (agent, dev servers) dies with a cryptic "spawn /bin/sh ENOENT"
      let dir = (opts.workingDir ?? '').trim()
      if (dir === '~') dir = homedir()
      else if (dir.startsWith('~/')) dir = path.join(homedir(), dir.slice(2))
      opts = { ...opts, workingDir: dir }
      if (!DEMO && !existsSync(dir)) {
        broadcast({ kind: 'toast', level: 'error', message: `That folder doesn't exist: ${dir}` })
      }
      if (opts.reviewPr && !DEMO) {
        const m = opts.reviewPr.match(/(\d+)(?!.*\d)/) // last number in "#123", "123", or a PR URL
        const pr = m ? Number(m[1]) : NaN
        if (!Number.isFinite(pr) || pr <= 0) {
          broadcast({ kind: 'toast', level: 'error', message: `Could not read a PR number from "${opts.reviewPr}"` })
          return manager.createSession(opts)
        }
        const wt = await createPrWorktree(opts.workingDir, pr)
        if (wt.ok && wt.dir) {
          broadcast({ kind: 'toast', level: 'info', message: `PR #${pr} checked out on ${wt.branch}` })
          const row = manager.createSession({ ...opts, workingDir: wt.dir })
          void manager.linkIssue(row.id, `#${pr}`).catch(() => {}) // PRs resolve via the issues API; best effort
          return manager.listSessions().find((s) => s.id === row.id) ?? row
        }
        broadcast({ kind: 'toast', level: 'error', message: wt.error ?? `Could not check out PR #${pr}` })
        return manager.createSession(opts)
      }
      if (opts.useWorktree && !DEMO) {
        const wt = await createWorktree(opts.workingDir)
        if (wt.ok && wt.dir) {
          broadcast({ kind: 'toast', level: 'info', message: `Session works on branch ${wt.branch}` })
          return manager.createSession({ ...opts, workingDir: wt.dir })
        }
        broadcast({
          kind: 'toast',
          level: 'error',
          message: `Worktree failed (${wt.error ?? 'unknown'}) - using the repo directly.`
        })
      }
      return manager.createSession(opts)
    },
    forkSession: (id: string) => manager.forkSession(id),
    deleteSession: async (id: string) => {
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      procs.stopSession(id)
      manager.deleteSession(id)
      if (dir) await removeWorktree(dir)
    },
    renameSession: (id: string, title: string) => manager.renameSession(id, title),
    setModel: (id: string, model: string | null) => manager.setModel(id, model),
    setPermissionMode: (id: string, mode: Parameters<SessionManager['setPermissionMode']>[1]) =>
      manager.setPermissionMode(id, mode),
    setBrowserEnabled: (id: string, enabled: boolean) => manager.setBrowserEnabled(id, enabled),
    sendPrompt: (id: string, text: string, images?: Parameters<SessionManager['sendPrompt']>[2]) => {
      void manager.sendPrompt(id, text, images)
    },
    cancelQueued: (id: string, index: number) => manager.cancelQueued(id, index),
    interrupt: (id: string) => manager.interrupt(id),
    respondPermission: (id: string, reqId: string, d: Parameters<SessionManager['respondPermission']>[2]) =>
      manager.respondPermission(id, reqId, d),
    loadHistory: (id: string) => manager.loadHistory(id),
    linkIssue: (id: string, ref: string) => manager.linkIssue(id, ref),
    unlinkIssue: (id: string) => manager.unlinkIssue(id),
    chooseDirectory: async () => {
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        message: 'Choose the working directory for this session'
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    gitChanges: (id: string) => {
      if (DEMO) return demoGitChanges()
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      return dir ? gitChanges(dir) : { ok: false, error: 'unknown session', branch: '', files: [] }
    },
    gitFileDiff: (id: string, file: string) => {
      if (DEMO) return demoGitFileDiff(file)
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      return dir ? gitFileDiff(dir, file) : ''
    },
    gitCommit: (id: string, message: string) => {
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      return dir ? gitCommit(dir, message) : { ok: false, error: 'unknown session' }
    },
    gitDiscard: (id: string, file: string) => {
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      return dir ? gitDiscard(dir, file) : { ok: false, error: 'unknown session' }
    },
    gitWorktreeInfo: (id: string) => {
      if (DEMO) return { isWorktree: true, branch: 'fix/142-samesite-redirect', baseDir: '/Users/dev/acme-web' }
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      return dir ? worktreeInfo(dir) : null
    },
    gitMergeBack: (id: string) => {
      if (DEMO) return { ok: false, error: 'Demo mode - nothing to merge.' }
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      return dir ? mergeWorktree(dir) : { ok: false, error: 'unknown session' }
    },
    procStart: (id: string, command: string) => {
      const dir = manager.listSessions().find((s) => s.id === id)?.workingDir
      return dir ? procs.start(id, command, dir) : { error: 'unknown session' }
    },
    procStop: (id: string, procId: string) => procs.stop(id, procId),
    procList: (id: string) => procs.list(id),
    procClear: (id: string) => procs.clearLines(id),
    browserOpen: async (id: string) => {
      try {
        await browsers.ensure(id)
      } catch {
        /* error already emitted as browser state */
      }
    },
    browserClose: (id: string) => browsers.close(id),
    browserNavigate: (id: string, url: string) => browsers.navigate(id, url),
    browserSelectTab: (id: string, tabId: string) => browsers.selectTab(id, tabId),
    browserInspect: (id: string, x: number, y: number) => browsers.inspect(id, x, y),
    getSettings: () => store.getSettings(),
    setSettings: (patch: Partial<ReturnType<Store['getSettings']>>) => store.setSettings(patch),
    preflight: () => preflight(store.getSettings().chromePath || undefined),
    uiReady: () => {
      if (DEMO && !demoStarted) {
        demoStarted = true
        runDemo(store, broadcast)
      }
    },
    openExternal: (url: string) => {
      if (typeof url === 'string' && url.startsWith('http')) void shell.openExternal(url)
    }
  }

  ipcMain.handle('cockpit:cmd', async (_e, name: string, args: unknown[]) => {
    const h = handlers[name]
    if (!h) throw new Error(`Unknown command: ${name}`)
    return (h as (...a: unknown[]) => unknown)(...(args ?? []))
  })

  ipcMain.on(
    'cockpit:browser-input',
    (_e, sessionId: string, ev: BrowserInputEvent, frameW: number, frameH: number) => {
      browsers.input(sessionId, ev, Number(frameW) || 1280, Number(frameH) || 860)
    }
  )
}

/**
 * One-time carry-over from the app's old identity ("Dev Cockpit"): the rename
 * moved userData to .../Argus, so copy the session store and browser profiles
 * across the first time Argus starts with nothing in its own directory.
 */
function migrateLegacyData(newDir: string): void {
  try {
    const oldDir = path.join(path.dirname(newDir), 'Dev Cockpit')
    const alreadyMigrated = existsSync(path.join(newDir, 'cockpit.db')) || existsSync(path.join(newDir, 'cockpit.json'))
    if (alreadyMigrated || !existsSync(oldDir)) return
    mkdirSync(newDir, { recursive: true })
    for (const f of ['cockpit.db', 'cockpit.json']) {
      const src = path.join(oldDir, f)
      if (existsSync(src)) copyFileSync(src, path.join(newDir, f))
    }
    const oldProfiles = path.join(oldDir, 'browser-profiles')
    const newProfiles = path.join(newDir, 'browser-profiles')
    if (existsSync(oldProfiles) && !existsSync(newProfiles)) {
      cpSync(oldProfiles, newProfiles, { recursive: true })
    }
    console.log('[argus] migrated session data from Dev Cockpit')
  } catch (e) {
    console.warn('[argus] legacy data migration failed (starting fresh):', e)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    await fixPath()
    const dataDir =
      DEMO || SMOKE || process.env.COCKPIT_BROWSER_SMOKE === '1' || process.env.COCKPIT_FORK_SMOKE === '1'
        ? ':memory:'
        : app.getPath('userData')
    if (dataDir !== ':memory:') migrateLegacyData(dataDir)
    store = new Store(dataDir)
    browsers = new BrowserManager(
      path.join(app.getPath('userData'), 'browser-profiles'),
      (sessionId, ev) => broadcast({ kind: 'browser', sessionId, ev }),
      () => store.getSettings().chromePath || undefined
    )
    manager = new SessionManager(store, browsers, broadcast)
    procs = new ProcessManager((sessionId, ev) => broadcast({ kind: 'proc', sessionId, ev }))
    registerIpc()
    buildMenu()
    createWindow()

    if (SMOKE) {
      const { runSmoke } = await import('./smoke')
      runSmoke(manager, (cb) => eventTaps.push(cb))
    }
    if (process.env.COCKPIT_BROWSER_SMOKE === '1') {
      const { runBrowserSmoke } = await import('./smoke')
      runBrowserSmoke(manager, browsers, (cb) => eventTaps.push(cb))
    }
    if (process.env.COCKPIT_FORK_SMOKE === '1') {
      const { runForkSmoke } = await import('./smoke')
      runForkSmoke(manager, (cb) => eventTaps.push(cb))
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    procs?.stopAll()
    manager?.shutdown()
  })
}
