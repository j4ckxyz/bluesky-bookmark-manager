import type { BookmarkRecord } from './types.ts'

export type ExportFormat = 'html' | 'json' | 'csv' | 'ndjson'

export const EXPORT_FORMATS: Record<ExportFormat, { contentType: string; extension: string; label: string }> = {
  html: {
    contentType: 'text/html; charset=utf-8',
    extension: 'html',
    label: 'Netscape bookmarks (importable by browsers, Raindrop, Pocket)',
  },
  json: { contentType: 'application/json; charset=utf-8', extension: 'json', label: 'JSON with full metadata' },
  csv: { contentType: 'text/csv; charset=utf-8', extension: 'csv', label: 'CSV for spreadsheets' },
  ndjson: {
    contentType: 'application/x-ndjson; charset=utf-8',
    extension: 'ndjson',
    label: 'Newline-delimited JSON for streaming into other tools',
  },
}

export function exportFilename(format: ExportFormat, handle: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const safeHandle = handle.replace(/[^a-z0-9.-]/gi, '_')
  return `bluesky-bookmarks-${safeHandle}-${date}.${EXPORT_FORMATS[format].extension}`
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Netscape bookmark files use Unix seconds for their date attributes. */
const unixSeconds = (iso: string | null): string =>
  iso ? String(Math.floor(new Date(iso).getTime() / 1000)) : ''

/** A single-line title, since the format has no room for a post body. */
function titleFor(bookmark: BookmarkRecord): string {
  const author = bookmark.authorHandle ? `@${bookmark.authorHandle}` : 'Unknown author'
  const body = bookmark.text.replace(/\s+/g, ' ').trim()
  if (!body) {
    if (bookmark.itemState === 'not_found') return `${author} — post deleted`
    if (bookmark.itemState === 'blocked') return `${author} — post blocked`
    return `${author} — post`
  }
  const truncated = body.length > 110 ? `${body.slice(0, 109)}…` : body
  return `${author}: ${truncated}`
}

/**
 * The Netscape bookmark file format — the de facto standard that browsers,
 * Raindrop, Pocket, Pinboard and friends all import. Metadata that has no
 * home in the format is carried in TAGS and in the DD description line, both
 * of which importers generally preserve.
 */
export function toNetscapeHtml(bookmarks: BookmarkRecord[], handle: string): string {
  return [...streamNetscapeHtml([bookmarks], handle)].join('')
}

function* streamNetscapeHtml(pages: Iterable<BookmarkRecord[]>, handle: string): Generator<string> {
  yield [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    `    <DT><H3>Bluesky bookmarks — @${escapeHtml(handle)}</H3>`,
    '    <DL><p>',
    '',
  ].join('\n')

  for (const page of pages) {
    const lines: string[] = []
    for (const bookmark of page) {
      const href = bookmark.postUrl ?? bookmark.uri
      const tags = buildTags(bookmark)
      const attributes = [
        `HREF="${escapeHtml(href)}"`,
        `ADD_DATE="${unixSeconds(bookmark.bookmarkedAt)}"`,
        `LAST_MODIFIED="${unixSeconds(bookmark.createdAt)}"`,
        tags.length > 0 ? `TAGS="${escapeHtml(tags.join(','))}"` : '',
      ]
        .filter(Boolean)
        .join(' ')

      lines.push(`        <DT><A ${attributes}>${escapeHtml(titleFor(bookmark))}</A>`)

      const description = buildDescription(bookmark)
      if (description) lines.push(`        <DD>${escapeHtml(description)}`)
    }
    if (lines.length > 0) yield `${lines.join('\n')}\n`
  }

  yield '    </DL><p>\n</DL><p>\n'
}

/** Tag list carried into importers: hashtags plus derived facets. */
function buildTags(bookmark: BookmarkRecord): string[] {
  const tags = new Set<string>(['bluesky'])
  for (const tag of bookmark.tags) tags.add(tag)
  if (bookmark.authorHandle) tags.add(bookmark.authorHandle)
  if (bookmark.hasImages) tags.add('has-image')
  if (bookmark.hasVideo) tags.add('has-video')
  if (bookmark.hasLinks) tags.add('has-link')
  if (bookmark.isReply) tags.add('reply')
  if (bookmark.isQuote) tags.add('quote')
  if (bookmark.authorVerified) tags.add('verified-author')
  if (bookmark.status === 'removed') tags.add('un-bookmarked')
  for (const lang of bookmark.langs) tags.add(`lang-${lang}`)
  return [...tags]
}

function buildDescription(bookmark: BookmarkRecord): string {
  const parts: string[] = []
  const text = bookmark.text.replace(/\s+/g, ' ').trim()
  if (text) parts.push(text)
  if (bookmark.externalTitle) parts.push(`Link: ${bookmark.externalTitle}`)
  if (bookmark.altText) parts.push(`Image: ${bookmark.altText.replace(/\s+/g, ' ')}`)
  if (bookmark.quotedText) {
    parts.push(`Quoting @${bookmark.quotedAuthorHandle ?? 'unknown'}: ${bookmark.quotedText.replace(/\s+/g, ' ')}`)
  }
  return parts.join(' — ')
}

export function toJson(bookmarks: BookmarkRecord[], handle: string): string {
  return [...streamJson([bookmarks], handle, bookmarks.length)].join('')
}

/**
 * Emits the same pretty-printed document as `JSON.stringify(doc, null, 2)`,
 * one page at a time. `count` must be known up front since it precedes the list.
 */
function* streamJson(pages: Iterable<BookmarkRecord[]>, handle: string, count: number): Generator<string> {
  const envelope = JSON.stringify(
    {
      $schema: 'https://github.com/j4ckxyz/bluesky-bookmark-manager/export/v1',
      exportedAt: new Date().toISOString(),
      account: handle,
      count,
      bookmarks: [],
    },
    null,
    2,
  )
  const [head] = envelope.split('"bookmarks": []')
  yield `${head}"bookmarks": [`

  let first = true
  for (const page of pages) {
    if (page.length === 0) continue
    const items = page.map((bookmark) => `    ${JSON.stringify(bookmark, null, 2).replace(/\n/g, '\n    ')}`)
    yield `${first ? '\n' : ',\n'}${items.join(',\n')}`
    first = false
  }

  yield first ? ']\n}\n' : '\n  ]\n}\n'
}

export function toNdjson(bookmarks: BookmarkRecord[]): string {
  return [...streamNdjson([bookmarks])].join('')
}

function* streamNdjson(pages: Iterable<BookmarkRecord[]>): Generator<string> {
  for (const page of pages) {
    if (page.length > 0) yield page.map((bookmark) => `${JSON.stringify(bookmark)}\n`).join('')
  }
}

const CSV_COLUMNS = [
  'uri',
  'url',
  'bookmarked_at',
  'posted_at',
  'author_handle',
  'author_display_name',
  'author_verified',
  'text',
  'is_reply',
  'is_quote',
  'has_links',
  'has_images',
  'has_video',
  'link_count',
  'primary_domain',
  'links',
  'tags',
  'mentions',
  'langs',
  'labels',
  'word_count',
  'like_count',
  'repost_count',
  'reply_count',
  'quote_count',
  'status',
  'item_state',
] as const

/** RFC 4180 quoting, with the leading-formula guard spreadsheets need. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  // Stop a spreadsheet from executing a cell that starts with =, +, - or @.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/["\n\r,]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function toCsv(bookmarks: BookmarkRecord[]): string {
  return [...streamCsv([bookmarks])].join('')
}

function* streamCsv(pages: Iterable<BookmarkRecord[]>): Generator<string> {
  yield `${CSV_COLUMNS.join(',')}\r\n`

  for (const page of pages) {
    const rows = page.map((b) =>
      [
        b.uri,
        b.postUrl ?? '',
        b.bookmarkedAt ?? '',
        b.createdAt ?? '',
        b.authorHandle ?? '',
        b.authorDisplayName ?? '',
        b.authorVerified,
        b.text,
        b.isReply,
        b.isQuote,
        b.hasLinks,
        b.hasImages,
        b.hasVideo,
        b.linkCount,
        b.primaryDomain ?? '',
        b.links.map((l) => l.url).join(' '),
        b.tags.join(' '),
        b.mentions.map((m) => m.handle ?? m.did ?? '').filter(Boolean).join(' '),
        b.langs.join(' '),
        b.labels.join(' '),
        b.wordCount,
        b.likeCount ?? '',
        b.repostCount ?? '',
        b.replyCount ?? '',
        b.quoteCount ?? '',
        b.status,
        b.itemState,
      ]
        .map(csvCell)
        .join(','),
    )
    if (rows.length > 0) yield `${rows.join('\r\n')}\r\n`
  }
}

/**
 * Renders an export incrementally from pages of results, so a large archive
 * never has to sit in memory as one array or one string.
 */
export function streamExport(
  format: ExportFormat,
  pages: Iterable<BookmarkRecord[]>,
  handle: string,
  count: number,
): Generator<string> {
  switch (format) {
    case 'html':
      return streamNetscapeHtml(pages, handle)
    case 'json':
      return streamJson(pages, handle, count)
    case 'csv':
      return streamCsv(pages)
    case 'ndjson':
      return streamNdjson(pages)
  }
}
