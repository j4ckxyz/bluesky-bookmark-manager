const RELATIVE = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' })
const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const FULL_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const NUMBER = new Intl.NumberFormat('en-GB')
const COMPACT = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 })

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "3 hours ago" for anything recent, a plain date beyond a week. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'

  const diff = date.getTime() - Date.now()
  const absolute = Math.abs(diff)

  if (absolute < MINUTE) return 'just now'
  if (absolute < HOUR) return RELATIVE.format(Math.round(diff / MINUTE), 'minute')
  if (absolute < DAY) return RELATIVE.format(Math.round(diff / HOUR), 'hour')
  if (absolute < 7 * DAY) return RELATIVE.format(Math.round(diff / DAY), 'day')

  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear()
  return sameYear ? SHORT_DATE.format(date) : FULL_DATE.format(date)
}

export function fullDate(iso: string | null): string {
  if (!iso) return 'Unknown'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Unknown' : DATE_TIME.format(date)
}

export function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return month
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' }).format(date)
}

export const formatNumber = (value: number): string => NUMBER.format(value)
export const compactNumber = (value: number): string =>
  value < 1000 ? String(value) : COMPACT.format(value)

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`
}

/**
 * Splits text into highlighted and plain runs for the matched search terms.
 * Matching is case-insensitive and respects word starts, so a query for
 * "proto" highlights "protocol" but not "cryptoproto".
 */
export function highlightRuns(
  text: string,
  terms: string[],
): Array<{ text: string; match: boolean }> {
  const cleaned = terms
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .sort((a, b) => b.length - a.length)

  if (cleaned.length === 0) return [{ text, match: false }]

  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${cleaned.map(escapeRegExp).join('|')})`, 'giu')
  const runs: Array<{ text: string; match: boolean }> = []
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    // Extend the highlight to the end of the word so prefixes read naturally.
    const wordEnd = wordBoundaryAfter(text, start + match[0].length)
    if (start > lastIndex) runs.push({ text: text.slice(lastIndex, start), match: false })
    runs.push({ text: text.slice(start, wordEnd), match: true })
    lastIndex = wordEnd
  }

  if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex), match: false })
  return runs.length > 0 ? runs : [{ text, match: false }]
}

function wordBoundaryAfter(text: string, from: number): number {
  let index = from
  while (index < text.length && /[\p{L}\p{N}]/u.test(text[index] ?? '')) index++
  return index
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Trims a long URL to something that fits on one line. */
export function prettyUrl(url: string, maxLength = 60): string {
  const withoutScheme = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return withoutScheme.length > maxLength
    ? `${withoutScheme.slice(0, maxLength - 1)}…`
    : withoutScheme
}
