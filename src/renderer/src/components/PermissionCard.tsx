import { Check, OctagonAlert, ShieldQuestion, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PermissionRequest } from '../../../shared/types'
import { store } from '../store'
import { cx } from '../util'
import { Markdown } from './Markdown'

function inputPreview(req: PermissionRequest): string {
  const inp = (req.input ?? {}) as Record<string, unknown>
  if (typeof inp.command === 'string') return inp.command
  if (typeof inp.file_path === 'string') return inp.file_path
  if (typeof inp.url === 'string') return inp.url
  const json = JSON.stringify(req.input, null, 2) ?? ''
  return json.length > 600 ? json.slice(0, 600) + '…' : json
}

export function PermissionCard({
  req,
  resolved
}: {
  req: PermissionRequest
  resolved?: 'allow' | 'deny'
}): ReactNode {
  const respond = (d: Parameters<typeof store.respondPermission>[2]): void =>
    store.respondPermission(req.sessionId, req.id, d)

  if (req.isPlan) {
    return (
      <div className={cx('perm-card plan', resolved && 'resolved')}>
        <div className="perm-head">
          <ShieldQuestion size={15} />
          <span>Claude has a plan and wants to start working</span>
          {resolved && <ResolvedBadge resolved={resolved} />}
        </div>
        {req.plan && (
          <div className="perm-plan">
            <Markdown text={req.plan} />
          </div>
        )}
        {!resolved && (
          <div className="perm-actions">
            <button
              className="btn primary"
              onClick={() => respond({ behavior: 'allow', setMode: 'acceptEdits' })}
            >
              Approve — auto-accept edits
            </button>
            <button className="btn" onClick={() => respond({ behavior: 'allow', setMode: 'default' })}>
              Approve — ask as it goes
            </button>
            <button
              className="btn subtle"
              onClick={() => respond({ behavior: 'deny', message: 'Keep planning — the user wants changes to the plan.' })}
            >
              Keep planning
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cx('perm-card', resolved && 'resolved')}>
      <div className="perm-head">
        <OctagonAlert size={15} />
        <span>{req.title || `Claude wants to use ${req.displayName || req.toolName}`}</span>
        {resolved && <ResolvedBadge resolved={resolved} />}
      </div>
      {req.description && <div className="perm-desc">{req.description}</div>}
      <pre className="perm-input">{inputPreview(req)}</pre>
      {!resolved && (
        <div className="perm-actions">
          <button className="btn primary" onClick={() => respond({ behavior: 'allow' })}>
            <Check size={13} /> Allow once
          </button>
          <button className="btn" onClick={() => respond({ behavior: 'allow', always: true })}>
            Always allow {shortToolName(req)}
          </button>
          <button className="btn subtle danger" onClick={() => respond({ behavior: 'deny' })}>
            <X size={13} /> Deny
          </button>
        </div>
      )}
    </div>
  )
}

function shortToolName(req: PermissionRequest): string {
  if (req.toolName.startsWith('mcp__playwright__')) return 'browser actions'
  return req.displayName?.toLowerCase() || req.toolName
}

function ResolvedBadge({ resolved }: { resolved: 'allow' | 'deny' }): ReactNode {
  return (
    <span className={cx('perm-resolved', resolved)}>
      {resolved === 'allow' ? 'Allowed' : 'Denied'}
    </span>
  )
}
