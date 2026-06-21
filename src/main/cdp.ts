import { EventEmitter } from 'node:events'

/**
 * Minimal Chrome DevTools Protocol client over the page WebSocket.
 * Used for the embedded live view: screencast frames in, input events out.
 * Node ≥22 (Electron's bundled runtime) provides the global WebSocket.
 */
export class CdpClient extends EventEmitter {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  closed = false

  constructor(readonly targetId: string) {
    super()
  }

  async connect(wsUrl: string): Promise<void> {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is not available in this runtime')
    }
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('error', onErr)
        resolve()
      }
      const onErr = () => reject(new Error('CDP connect failed'))
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onErr, { once: true })
    })
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as {
          id?: number
          method?: string
          params?: unknown
          result?: unknown
          error?: { message?: string }
        }
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'))
            else p.resolve(msg.result)
          }
        } else if (msg.method) {
          this.emit(msg.method, msg.params)
        }
      } catch {
        /* ignore malformed frames */
      }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error('CDP closed'))
      this.pending.clear()
      this.emit('close')
    })
    ws.addEventListener('error', () => {
      /* close event follows */
    })
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP not connected'))
    }
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    })
    this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    return promise
  }

  /** Fire-and-forget send for input events / frame acks. */
  cast(method: string, params?: Record<string, unknown>): void {
    this.send(method, params).catch(() => {})
  }

  close(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }
}

export interface CdpTargetInfo {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export async function listTargets(port: number): Promise<CdpTargetInfo[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000)
  })
  if (!res.ok) throw new Error(`CDP list failed: ${res.status}`)
  return (await res.json()) as CdpTargetInfo[]
}

export async function activateTarget(port: number, targetId: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/activate/${targetId}`, {
    signal: AbortSignal.timeout(3000)
  }).catch(() => {})
}

export async function waitForCdp(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1500)
      })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}
