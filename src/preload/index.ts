import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserInputEvent, CockpitEvent } from '../shared/types'

const invoke = (name: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke('cockpit:cmd', name, args)

const cmd =
  (name: string) =>
  (...args: unknown[]): Promise<unknown> =>
    invoke(name, ...args)

const api = {
  listSessions: cmd('listSessions'),
  createSession: cmd('createSession'),
  deleteSession: cmd('deleteSession'),
  renameSession: cmd('renameSession'),
  setModel: cmd('setModel'),
  setPermissionMode: cmd('setPermissionMode'),
  setBrowserEnabled: cmd('setBrowserEnabled'),
  sendPrompt: cmd('sendPrompt'),
  cancelQueued: cmd('cancelQueued'),
  interrupt: cmd('interrupt'),
  respondPermission: cmd('respondPermission'),
  loadHistory: cmd('loadHistory'),
  linkIssue: cmd('linkIssue'),
  unlinkIssue: cmd('unlinkIssue'),
  chooseDirectory: cmd('chooseDirectory'),
  gitChanges: cmd('gitChanges'),
  gitFileDiff: cmd('gitFileDiff'),
  gitCommit: cmd('gitCommit'),
  gitDiscard: cmd('gitDiscard'),
  browserOpen: cmd('browserOpen'),
  browserClose: cmd('browserClose'),
  browserNavigate: cmd('browserNavigate'),
  browserSelectTab: cmd('browserSelectTab'),
  getSettings: cmd('getSettings'),
  setSettings: cmd('setSettings'),
  preflight: cmd('preflight'),
  uiReady: cmd('uiReady'),
  openExternal: cmd('openExternal'),

  onEvent(cb: (e: CockpitEvent) => void): () => void {
    const handler = (_: unknown, e: CockpitEvent): void => cb(e)
    ipcRenderer.on('cockpit:event', handler)
    return () => ipcRenderer.removeListener('cockpit:event', handler)
  },

  browserInput(sessionId: string, ev: BrowserInputEvent, frameW: number, frameH: number): void {
    ipcRenderer.send('cockpit:browser-input', sessionId, ev, frameW, frameH)
  },

  meta: {
    platform: process.platform,
    home: process.env.HOME || '',
    demo: process.env.COCKPIT_DEMO === '1',
    demoView: process.env.COCKPIT_DEMO_VIEW || null
  }
}

contextBridge.exposeInMainWorld('cockpit', api)
