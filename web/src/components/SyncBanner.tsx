import { AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react'
import { formatNumber, relativeTime } from '../lib/format.ts'
import type { SyncProgress } from '../lib/types.ts'

type Props = {
  status: SyncProgress | null
  intervalMinutes: number
  onRefresh: () => void
  onCancel: () => void
  busy: boolean
}

const MODE_LABELS: Record<SyncProgress['mode'], string> = {
  backfill: 'Backfilling your bookmarks',
  quick: 'Checking for new bookmarks',
  full: 'Full sync',
}

/**
 * Shows what the sync job is doing. During a backfill the total is unknown
 * until it finishes, so this reports work done rather than a false percentage.
 */
export function SyncBanner({ status, intervalMinutes, onRefresh, onCancel, busy }: Props) {
  if (!status) {
    return (
      <div className="sync">
        <span className="status-dot" aria-hidden="true" />
        <div className="sync__body">
          <div className="sync__title">Not synced yet</div>
          <div className="sync__detail">Start a sync to pull your bookmarks across.</div>
        </div>
        <button className="button button--small" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'spin' : undefined} />
          Sync now
        </button>
      </div>
    )
  }

  if (status.active || status.status === 'running') {
    return (
      <div className="sync sync--running">
        <span className="sync__icon" aria-hidden="true">
          <RefreshCw size={16} className="spin" />
        </span>
        <div className="sync__body">
          <div className="sync__title">{MODE_LABELS[status.mode]}</div>
          <div className="sync__detail">
            {formatNumber(status.scanned)} scanned · {formatNumber(status.created)} new ·{' '}
            {formatNumber(status.pages)} {status.pages === 1 ? 'page' : 'pages'}
            {status.totalStored > 0 && ` · ${formatNumber(status.totalStored)} stored`}
          </div>
          <div className="sync__bar" role="progressbar" aria-label="Sync in progress">
            <div className="sync__bar-fill" />
          </div>
        </div>
        <button className="button button--small button--ghost" onClick={onCancel}>
          <X size={13} />
          Stop
        </button>
      </div>
    )
  }

  if (status.status === 'failed') {
    return (
      <div className="sync sync--error">
        <span className="sync__icon" aria-hidden="true" style={{ color: 'var(--danger)' }}>
          <AlertTriangle size={16} />
        </span>
        <div className="sync__body">
          <div className="sync__title">Last sync failed</div>
          <div className="sync__detail">{status.error ?? 'Unknown error'}</div>
        </div>
        <button className="button button--small" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'spin' : undefined} />
          Retry
        </button>
      </div>
    )
  }

  const summary: string[] = []
  if (status.created > 0) summary.push(`${formatNumber(status.created)} new`)
  if (status.restored > 0) summary.push(`${formatNumber(status.restored)} restored`)
  if (status.removed > 0) summary.push(`${formatNumber(status.removed)} un-bookmarked`)

  return (
    <div className="sync">
      <span className="sync__icon" aria-hidden="true" style={{ color: 'var(--positive)' }}>
        <CheckCircle2 size={16} />
      </span>
      <div className="sync__body">
        <div className="sync__title">
          {status.status === 'cancelled' ? 'Sync stopped' : 'Up to date'}
          {' · '}
          <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
            {relativeTime(status.finishedAt ?? status.startedAt)}
          </span>
        </div>
        <div className="sync__detail">
          {formatNumber(status.totalStored)} bookmarks stored
          {summary.length > 0 && ` · last run: ${summary.join(', ')}`}
          {` · checking every ${intervalMinutes} minutes`}
        </div>
      </div>
      <button className="button button--small" onClick={onRefresh} disabled={busy}>
        <RefreshCw size={13} className={busy ? 'spin' : undefined} />
        Sync now
      </button>
    </div>
  )
}
