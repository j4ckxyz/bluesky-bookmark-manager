import { BarChart3, Globe, Tag, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import { formatNumber, fullDate, monthLabel } from '../lib/format.ts'
import type { FacetBucket, Stats } from '../lib/types.ts'

type Props = { onFilter: (fragment: string) => void }

export function StatsView({ onFilter }: Props) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api
      .stats(controller.signal)
      .then(setStats)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'Could not load stats.')
      })
    return () => controller.abort()
  }, [])

  if (error) return <div className="error-box">{error}</div>
  if (!stats) {
    return (
      <div className="stats__grid">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="skeleton" style={{ height: 84 }} />
        ))}
      </div>
    )
  }

  if (stats.totals.all === 0) {
    return (
      <div className="empty">
        <BarChart3 size={26} className="empty__icon" />
        <p className="empty__title">Nothing to measure yet</p>
        <p>Once your bookmarks have synced, this is where the shape of your archive shows up.</p>
      </div>
    )
  }

  const peakMonth = Math.max(1, ...stats.savedByMonth.map((entry) => entry.count))
  const peakDay = Math.max(1, ...stats.savedByWeekday.map((entry) => entry.count))

  return (
    <div className="stats">
      <div className="stats__grid">
        <Tile value={formatNumber(stats.totals.active)} label="Bookmarks saved" />
        <Tile value={formatNumber(stats.totals.authors)} label="Accounts bookmarked" />
        <Tile value={formatNumber(stats.totals.domains)} label="Domains linked" />
        <Tile value={formatNumber(stats.totals.words)} label="Words archived" />
      </div>

      <div className="panel">
        <h2 className="panel__title">
          <BarChart3 size={14} /> Saved over time
        </h2>
        {stats.savedByMonth.length === 0 ? (
          <p className="hint">No dated bookmarks yet.</p>
        ) : (
          <>
            <div className="spark" role="img" aria-label="Bookmarks saved per month">
              {stats.savedByMonth.map((entry) => (
                <div
                  key={entry.month}
                  className="spark__bar"
                  style={{ height: `${Math.max(3, (entry.count / peakMonth) * 100)}%` }}
                  title={`${monthLabel(entry.month)}: ${formatNumber(entry.count)}`}
                />
              ))}
            </div>
            <div className="spark__axis">
              <span>{monthLabel(stats.savedByMonth[0]?.month ?? '')}</span>
              <span>peak {formatNumber(peakMonth)} in a month</span>
              <span>{monthLabel(stats.savedByMonth.at(-1)?.month ?? '')}</span>
            </div>
          </>
        )}
      </div>

      <div className="panel-grid">
        <BucketPanel
          title="Most bookmarked accounts"
          icon={<Users size={14} />}
          buckets={stats.topAuthors}
          onSelect={(value) => onFilter(`from:@${value}`)}
          format={(value) => `@${value}`}
        />
        <BucketPanel
          title="Most linked domains"
          icon={<Globe size={14} />}
          buckets={stats.topDomains}
          onSelect={(value) => onFilter(`domain:${value}`)}
        />
        <BucketPanel
          title="Most used hashtags"
          icon={<Tag size={14} />}
          buckets={stats.topTags}
          onSelect={(value) => onFilter(`#${value}`)}
          format={(value) => `#${value}`}
        />

        <div className="panel">
          <h2 className="panel__title">What you save</h2>
          <div className="bar-list">
            <Row label="With links" value={stats.content.withLinks} total={stats.totals.active} />
            <Row label="With images" value={stats.content.withImages} total={stats.totals.active} />
            <Row label="With video" value={stats.content.withVideo} total={stats.totals.active} />
            <Row label="Replies" value={stats.content.replies} total={stats.totals.active} />
            <Row label="Quote posts" value={stats.content.quotes} total={stats.totals.active} />
            <Row
              label="From verified accounts"
              value={stats.content.verifiedAuthors}
              total={stats.totals.active}
            />
          </div>
        </div>

        <div className="panel">
          <h2 className="panel__title">Saving habits</h2>
          <div className="bar-list">
            {stats.savedByWeekday.map((entry) => (
              <div key={entry.day}>
                <div className="bar-row" style={{ cursor: 'default' }}>
                  <span className="bar-row__label">{entry.day}</span>
                  <span className="bar-row__count">{formatNumber(entry.count)}</span>
                  <span className="bar-row__track">
                    <span
                      className="bar-row__fill"
                      style={{ width: `${(entry.count / peakDay) * 100}%` }}
                    />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2 className="panel__title">Archive health</h2>
          <div className="bar-list">
            <KeyValue label="First saved" value={fullDate(stats.range.firstSaved)} />
            <KeyValue label="Last saved" value={fullDate(stats.range.lastSaved)} />
            <KeyValue label="Oldest post" value={fullDate(stats.range.oldestPost)} />
            <KeyValue label="Words per post" value={String(stats.averages.wordsPerPost)} />
            <KeyValue
              label="Un-bookmarked on Bluesky"
              value={formatNumber(stats.totals.removed)}
            />
            <KeyValue
              label="Deleted by their author"
              value={formatNumber(stats.content.deletedUpstream)}
            />
          </div>
          {(stats.totals.removed > 0 || stats.content.deletedUpstream > 0) && (
            <p className="hint" style={{ marginTop: 12 }}>
              Nothing is thrown away here. Removed and deleted posts stay searchable under
              “Everything”.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile__value">{value}</div>
      <div className="stat-tile__label">{label}</div>
    </div>
  )
}

function BucketPanel({
  title,
  icon,
  buckets,
  onSelect,
  format = (value: string) => value,
}: {
  title: string
  icon: React.ReactNode
  buckets: FacetBucket[]
  onSelect: (value: string) => void
  format?: (value: string) => string
}) {
  if (buckets.length === 0) return null
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.count))

  return (
    <div className="panel">
      <h2 className="panel__title">
        {icon} {title}
      </h2>
      <div className="bar-list">
        {buckets.map((bucket) => (
          <button
            key={bucket.value}
            type="button"
            className="bar-row"
            onClick={() => onSelect(bucket.value)}
            title={`Search for ${format(bucket.value)}`}
          >
            <span className="bar-row__label">{bucket.label || format(bucket.value)}</span>
            <span className="bar-row__count">{formatNumber(bucket.count)}</span>
            <span className="bar-row__track">
              <span
                className="bar-row__fill"
                style={{ width: `${(bucket.count / peak) * 100}%` }}
              />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Row({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((value / total) * 100)
  return (
    <div className="bar-row" style={{ cursor: 'default' }}>
      <span className="bar-row__label">{label}</span>
      <span className="bar-row__count">
        {formatNumber(value)} · {percent}%
      </span>
      <span className="bar-row__track">
        <span className="bar-row__fill" style={{ width: `${percent}%` }} />
      </span>
    </div>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 13,
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}
