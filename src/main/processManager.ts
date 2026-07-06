import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ProcEvent, ProcInfo, ProcLine } from '../shared/types'
import { getFixedPath } from './env'

/**
 * Session-owned background processes (dev servers, watchers): the cockpit
 * spawns them, tails their output into the process drawer, and the lines can
 * be clicked straight into the chat - the console drawer's sibling, for the
 * server side of the app.
 */

interface LiveProc {
  info: ProcInfo
  proc: ChildProcess | null
}

const MAX_LINES = 600

export class ProcessManager {
  private bySession = new Map<string, Map<string, LiveProc>>()
  private lines = new Map<string, ProcLine[]>() // sessionId → ring buffer
  private lineSeq = 0
  private pending = new Map<string, ProcLine[]>() // batched flush per session
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private emit: (sessionId: string, ev: ProcEvent) => void) {}

  private procs(sessionId: string): Map<string, LiveProc> {
    let m = this.bySession.get(sessionId)
    if (!m) {
      m = new Map()
      this.bySession.set(sessionId, m)
    }
    return m
  }

  list(sessionId: string): { procs: ProcInfo[]; lines: ProcLine[] } {
    return {
      procs: [...this.procs(sessionId).values()].map((l) => l.info),
      lines: this.lines.get(sessionId) ?? []
    }
  }

  private emitProcs(sessionId: string): void {
    this.emit(sessionId, { t: 'procs', procs: [...this.procs(sessionId).values()].map((l) => l.info) })
  }

  private pushLine(sessionId: string, procId: string, text: string): void {
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd()
      if (!line) continue
      const entry: ProcLine = { id: ++this.lineSeq, procId, line: line.slice(0, 2000), ts: Date.now() }
      const ring = this.lines.get(sessionId) ?? []
      ring.push(entry)
      if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES)
      this.lines.set(sessionId, ring)
      const batch = this.pending.get(sessionId) ?? []
      batch.push(entry)
      this.pending.set(sessionId, batch)
    }
    if (this.flushTimer == null) {
      this.flushTimer = setTimeout(() => this.flush(), 120)
    }
  }

  private flush(): void {
    this.flushTimer = null
    for (const [sessionId, batch] of this.pending) {
      if (batch.length) this.emit(sessionId, { t: 'lines', lines: batch })
    }
    this.pending.clear()
  }

  start(sessionId: string, command: string, cwd: string): ProcInfo | { error: string } {
    const cmd = command.trim()
    if (!cmd) return { error: 'Empty command' }
    if ([...this.procs(sessionId).values()].filter((p) => p.info.running).length >= 5) {
      return { error: 'Five processes are already running in this session - stop one first.' }
    }
    const id = randomUUID().slice(0, 8)
    const info: ProcInfo = { id, command: cmd, running: true, exitCode: null, startedAt: Date.now() }
    let proc: ChildProcess
    try {
      // own process group so stopping a dev server also stops its children
      proc = spawn('/bin/sh', ['-c', cmd], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: getFixedPath(), FORCE_COLOR: '0', NO_COLOR: '1' }
      })
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
    const live: LiveProc = { info, proc }
    this.procs(sessionId).set(id, live)
    this.pushLine(sessionId, id, `❯ ${cmd}`)

    proc.stdout?.on('data', (d: Buffer) => this.pushLine(sessionId, id, stripAnsi(d.toString())))
    proc.stderr?.on('data', (d: Buffer) => this.pushLine(sessionId, id, stripAnsi(d.toString())))
    proc.on('exit', (code, signal) => {
      live.info.running = false
      live.info.exitCode = code
      live.proc = null
      this.pushLine(sessionId, id, `· exited ${signal ? `(${signal})` : `with code ${code ?? 0}`}`)
      this.emitProcs(sessionId)
    })
    proc.on('error', (e) => {
      live.info.running = false
      live.proc = null
      this.pushLine(sessionId, id, `· failed to start: ${e.message}`)
      this.emitProcs(sessionId)
    })

    this.emitProcs(sessionId)
    return info
  }

  stop(sessionId: string, procId: string): void {
    const live = this.procs(sessionId).get(procId)
    if (!live?.proc?.pid) return
    try {
      process.kill(-live.proc.pid, 'SIGTERM')
    } catch {
      try {
        live.proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    // escalate if it ignores SIGTERM
    const pid = live.proc.pid
    setTimeout(() => {
      if (live.info.running) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }, 4000)
  }

  clearLines(sessionId: string): void {
    this.lines.set(sessionId, [])
    this.emit(sessionId, { t: 'clear' })
  }

  stopSession(sessionId: string): void {
    for (const id of this.procs(sessionId).keys()) this.stop(sessionId, id)
    this.bySession.delete(sessionId)
    this.lines.delete(sessionId)
  }

  stopAll(): void {
    for (const sessionId of [...this.bySession.keys()]) this.stopSession(sessionId)
  }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}
