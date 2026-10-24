import { urlKey } from '../lib/url.ts'
import type { BookmarkRecord } from '../types.ts'
import { AgentRequestError } from './params.ts'

/**
 * The compact bookmark shape: every key always present (null when it does
 * not apply), nested where things belong together, and none of the internal
 * bookkeeping a reader does not need.
 */
export function compact(record: BookmarkRecord) {
  return {
    id: record.id,
    url: record.postUrl,
    uri: record.uri,
    status: record.status,
    /** `ok`, or why the post can no longer be loaded upstream. */
    state: record.itemState,
    savedAt: record.bookmarkedAt,
    postedAt: record.createdAt,
    author: {
      handle: record.authorHandle,
      displayName: record.authorDisplayName,
      did: record.authorDid,
      verified: record.authorVerified,
    },
    text: record.text,
    links: uniqueLinks(record),
    linkCard: record.hasExternal
      ? {
          url: record.externalUri,
          title: record.externalTitle,
          description: record.externalDescription,
        }
      : null,
    quote: record.isQuote
      ? { uri: record.quotedUri, author: record.quotedAuthorHandle, text: record.quotedText }
      : null,
    reply: record.isReply
      ? { parentUri: record.replyParentUri, rootUri: record.replyRootUri, selfThread: record.isSelfReply }
      : null,
    media: {
      images: record.imageCount,
      video: record.hasVideo,
      altText: record.altText || null,
    },
    tags: record.tags,
    mentions: record.mentions.map((m) => m.handle ?? m.did ?? '').filter(Boolean),
    langs: record.langs,
    labels: record.labels,
    engagement: {
      likes: record.likeCount,
      reposts: record.repostCount,
      replies: record.replyCount,
      quotes: record.quoteCount,
    },
    ...(record.score !== undefined && record.score !== 0 ? { score: record.score } : {}),
  }
}

export type CompactBookmark = ReturnType<typeof compact>

export const COMPACT_FIELDS = [
  'id',
  'url',
  'uri',
  'status',
  'state',
  'savedAt',
  'postedAt',
  'author',
  'text',
  'links',
  'linkCard',
  'quote',
  'reply',
  'media',
  'tags',
  'mentions',
  'langs',
  'labels',
  'engagement',
  'score',
] as const satisfies ReadonlyArray<keyof CompactBookmark>

/** The same link often arrives twice (a facet and a card); list it once. */
function uniqueLinks(record: BookmarkRecord): Array<{ url: string; domain: string; title: string | null }> {
  const seen = new Map<string, { url: string; domain: string; title: string | null }>()
  for (const link of record.links) {
    const key = urlKey(link.url)
    const existing = seen.get(key)
    if (existing) {
      existing.title ??= link.title ?? null
      continue
    }
    seen.set(key, { url: link.url, domain: link.domain, title: link.title ?? null })
  }
  return [...seen.values()]
}

/** Builds the per-record presenter for a `view` and optional `fields` list. */
export function presenter(
  view: 'compact' | 'full',
  fields: string[],
): (record: BookmarkRecord) => Record<string, unknown> {
  if (view === 'full') {
    if (fields.length > 0) {
      throw new AgentRequestError('invalid_parameter', '`fields` only applies to the compact view.', 'Drop `view=full`, or drop `fields`.')
    }
    // `highlights` is a UI concern; everything else is the stored record.
    return ({ highlights: _highlights, ...rest }) => rest
  }

  if (fields.length === 0) return compact

  const bad = fields.filter((f) => !(COMPACT_FIELDS as readonly string[]).includes(f))
  if (bad.length > 0) {
    throw new AgentRequestError(
      'invalid_parameter',
      `Unknown field${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}.`,
      `Fields: ${COMPACT_FIELDS.join(', ')}.`,
    )
  }
  const keep = new Set(['id', ...fields])
  return (record) => {
    const full = compact(record) as Record<string, unknown>
    return Object.fromEntries(Object.entries(full).filter(([key]) => keep.has(key)))
  }
}
