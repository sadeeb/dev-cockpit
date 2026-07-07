import { CircleDot, FolderOpen, GitBranch, Globe, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  MODEL_CHOICES,
  PERMISSION_MODES,
  type PermissionModeId
} from '../../../shared/types'
import { store, type AppState } from '../store'
import { cx, shortPath } from '../util'
import { Palette } from './Palette'
import { PreflightList } from './Welcome'

function ModalShell({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'wide')}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function NewSessionModal({ state }: { state: AppState }): ReactNode {
  const s = state.settings
  const [dir, setDir] = useState(s?.defaultWorkingDir || '')
  const [model, setModel] = useState<string | null>(s?.defaultModel ?? null)
  const [mode, setMode] = useState<PermissionModeId>(s?.defaultPermissionMode ?? 'default')
  const [browser, setBrowser] = useState(false)
  const [workspace, setWorkspace] = useState<'direct' | 'worktree' | 'pr'>('direct')
  const [prRef, setPrRef] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (): Promise<void> => {
    const chosen = await window.cockpit.chooseDirectory()
    if (chosen) setDir(chosen)
  }

  const create = async (): Promise<void> => {
    if (!dir || busy) return
    setBusy(true)
    try {
      await store.saveSettings({ defaultWorkingDir: dir, defaultModel: model, defaultPermissionMode: mode })
      await store.createSession({
        workingDir: dir,
        model,
        permissionMode: mode,
        browserEnabled: browser,
        useWorktree: workspace === 'worktree',
        reviewPr: workspace === 'pr' ? prRef.trim() : undefined
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell title="New session" onClose={() => store.closeModal()}>
      <label className="field">
        <span>Working directory: the repo Claude works in</span>
        <div className="field-row">
          <input value={dir} placeholder="/path/to/your/project" onChange={(e) => setDir(e.target.value)} spellCheck={false} />
          <button className="btn" onClick={() => void pick()}>
            <FolderOpen size={14} /> Browse
          </button>
        </div>
      </label>

      <label className="field">
        <span>Model</span>
        <div className="choice-row">
          {MODEL_CHOICES.map((m) => (
            <button key={String(m.id)} className={cx('choice', model === m.id && 'active')} title={m.hint} onClick={() => setModel(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </label>

      <label className="field">
        <span>Permissions</span>
        <div className="radio-col">
          {PERMISSION_MODES.map((m) => (
            <button key={m.id} className={cx('radio', mode === m.id && 'active', m.danger && 'danger')} onClick={() => setMode(m.id)}>
              <span className="radio-dot" />
              <span className="radio-label">{m.label}</span>
              <span className="radio-hint">{m.hint}</span>
            </button>
          ))}
        </div>
      </label>

      <label className="field check">
        <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} />
        <span>
          <Globe size={13} /> Enable the shared browser (Playwright) so the agent can drive your app while you watch
        </span>
      </label>

      <label className="field">
        <span>
          <GitBranch size={13} /> Workspace
        </span>
        <div className="radio-col">
          <button className={cx('radio', workspace === 'direct' && 'active')} onClick={() => setWorkspace('direct')}>
            <span className="radio-dot" />
            <span className="radio-label">Use the folder directly</span>
            <span className="radio-hint">Work on whatever is checked out</span>
          </button>
          <button className={cx('radio', workspace === 'worktree' && 'active')} onClick={() => setWorkspace('worktree')}>
            <span className="radio-dot" />
            <span className="radio-label">New branch + worktree</span>
            <span className="radio-hint">Isolated copy; merge back when done</span>
          </button>
          <button className={cx('radio', workspace === 'pr' && 'active')} onClick={() => setWorkspace('pr')}>
            <span className="radio-dot" />
            <span className="radio-label">Review a pull request</span>
            <span className="radio-hint">Checks the PR out into its own worktree</span>
          </button>
        </div>
        {workspace === 'pr' && (
          <input
            autoFocus
            value={prRef}
            placeholder="#123  ·  or paste the PR URL"
            onChange={(e) => setPrRef(e.target.value)}
            spellCheck={false}
          />
        )}
      </label>

      <div className="modal-actions">
        <button className="btn subtle" onClick={() => store.closeModal()}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!dir.trim() || busy || (workspace === 'pr' && !/\d/.test(prRef))}
          onClick={() => void create()}
        >
          {busy ? 'Creating…' : workspace === 'pr' ? 'Check out & review' : 'Create session'}
        </button>
      </div>
    </ModalShell>
  )
}

function SettingsModal({ state }: { state: AppState }): ReactNode {
  const s = state.settings
  const [origins, setOrigins] = useState(s?.allowedOrigins ?? '')
  const [chromePath, setChromePath] = useState(s?.chromePath ?? '')
  const [sendOnEnter, setSendOnEnter] = useState(s?.sendOnEnter ?? true)
  const [notifications, setNotifications] = useState(s?.notifications ?? true)

  const save = async (): Promise<void> => {
    await store.saveSettings({ allowedOrigins: origins.trim(), chromePath: chromePath.trim(), sendOnEnter, notifications })
    await store.refreshPreflight()
    store.closeModal()
  }

  return (
    <ModalShell title="Settings" onClose={() => store.closeModal()} wide>
      <label className="field check">
        <input type="checkbox" checked={sendOnEnter} onChange={(e) => setSendOnEnter(e.target.checked)} />
        <span>Enter sends the message (Shift+Enter for a new line)</span>
      </label>

      <label className="field check">
        <input type="checkbox" checked={notifications} onChange={(e) => setNotifications(e.target.checked)} />
        <span>Notify me when a background session needs approval, errors, or finishes</span>
      </label>

      <label className="field">
        <span>Browser: allowed origins (optional, semicolon-separated)</span>
        <input
          value={origins}
          placeholder="e.g. http://localhost:3000;http://127.0.0.1:5173 (empty allows all)"
          onChange={(e) => setOrigins(e.target.value)}
          spellCheck={false}
        />
        <em className="field-hint">
          Restricts which sites the agent's browser tools may touch. Takes effect for newly started agents.
        </em>
      </label>

      <label className="field">
        <span>Chromium executable (optional override)</span>
        <input
          value={chromePath}
          placeholder="Auto-detected: Chrome, Chromium, Edge, Brave, or Playwright's Chromium"
          onChange={(e) => setChromePath(e.target.value)}
          spellCheck={false}
        />
      </label>

      {(s?.permissionRules?.length ?? 0) > 0 && (
        <label className="field">
          <span>Trusted tools: “always, for this repo” rules</span>
          <div className="rule-list">
            {s!.permissionRules.map((r, i) => (
              <span className="rule-chip" key={i} title={r.dir || 'everywhere'}>
                <b>{r.tool}</b>
                <em>{r.dir ? shortPath(r.dir, window.cockpit.meta.home) : 'everywhere'}</em>
                <button
                  aria-label="Remove rule"
                  onClick={() =>
                    void store.saveSettings({ permissionRules: s!.permissionRules.filter((_, j) => j !== i) })
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <em className="field-hint">Removing a rule takes effect for newly started agents.</em>
        </label>
      )}

      <div className="welcome-preflight in-modal">
        <h3>Environment checks</h3>
        <PreflightList state={state} />
      </div>

      <div className="modal-actions">
        <button className="btn subtle" onClick={() => store.closeModal()}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </ModalShell>
  )
}

function DeleteModal({ state, id }: { state: AppState; id: string }): ReactNode {
  const row = state.sessions.find((s) => s.id === id)
  if (!row) return null
  return (
    <ModalShell title="Delete session?" onClose={() => store.closeModal()}>
      <p className="modal-text">
        “{row.title}” will be removed from the cockpit, and its browser profile deleted. The underlying Claude Code
        transcript on disk is kept.
      </p>
      <div className="modal-actions">
        <button className="btn subtle" onClick={() => store.closeModal()}>
          Cancel
        </button>
        <button className="btn danger" onClick={() => void store.deleteSession(id)}>
          Delete session
        </button>
      </div>
    </ModalShell>
  )
}

function BrowserSafetyModal({ id }: { id: string }): ReactNode {
  return (
    <ModalShell title="Enable the shared browser" onClose={() => store.closeModal()}>
      <div className="safety">
        <TriangleAlert size={18} />
        <p>
          Everything the agent sees through the browser (page content, console output, form data) is sent to the
          model API as it works. <b>Use development or test environments with test data only.</b>
        </p>
      </div>
      <p className="modal-text dim">
        You can restrict reachable origins in Settings. This notice is shown once.
      </p>
      <div className="modal-actions">
        <button className="btn subtle" onClick={() => store.closeModal()}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void store.ackBrowserSafety(id)}>
          I understand, enable it
        </button>
      </div>
    </ModalShell>
  )
}

function LinkIssueModal({ state, id }: { state: AppState; id: string }): ReactNode {
  const row = state.sessions.find((s) => s.id === id)
  const [ref, setRef] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const link = async (): Promise<void> => {
    if (!ref.trim() || busy) return
    setBusy(true)
    setErr(null)
    const e = await store.linkIssue(id, ref.trim())
    setBusy(false)
    if (e) setErr(e)
  }

  return (
    <ModalShell title="Link a GitHub issue" onClose={() => store.closeModal()}>
      <p className="modal-text dim">
        <CircleDot size={13} /> Accepts <code>#123</code> (repo inferred from{' '}
        {row ? shortPath(row.workingDir, window.cockpit.meta.home) : 'the working dir'}), <code>owner/repo#123</code>,
        or a full issue URL. The issue body and recent comments are shared with the agent on your next prompt.
      </p>
      <label className="field">
        <div className="field-row">
          <input
            autoFocus
            value={ref}
            placeholder="#142  ·  acme/web#142  ·  https://github.com/acme/web/issues/142"
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void link()}
            spellCheck={false}
          />
          <button className="btn primary" disabled={!ref.trim() || busy} onClick={() => void link()}>
            {busy ? 'Fetching…' : 'Link'}
          </button>
        </div>
      </label>
      {err && <div className="modal-error">{err}</div>}
    </ModalShell>
  )
}

export function Modals({ state }: { state: AppState }): ReactNode {
  const m = state.modal
  if (!m) return null
  switch (m.m) {
    case 'new-session':
      return <NewSessionModal state={state} />
    case 'settings':
      return <SettingsModal state={state} />
    case 'delete-session':
      return <DeleteModal state={state} id={m.id} />
    case 'browser-safety':
      return <BrowserSafetyModal id={m.id} />
    case 'link-issue':
      return <LinkIssueModal state={state} id={m.id} />
    case 'palette':
      return <Palette state={state} />
  }
}
