/** A link found in a post, either in a rich-text facet or an external embed. */
export type BookmarkLink = {
  url: string
  domain: string
  source: 'facet' | 'embed' | 'text'
  title?: string
}

export type BookmarkMention = {
  did?: string
  handle?: string
}

/**
 * Everything we derive from a single `app.bsky.bookmark.defs#bookmarkView`.
 * This is the shape the sync engine writes and the search layer reads back.
 */
export type BookmarkMetadata = {
  uri: string
  cid: string | null
  rkey: string | null
  bookmarkedAt: string | null
  /** `ok` when the post was resolvable, otherwise why it was not. */
  itemState: 'ok' | 'not_found' | 'blocked' | 'unknown'

  authorDid: string | null
  authorHandle: string | null
  authorDisplayName: string | null
  authorAvatar: string | null
  authorVerified: boolean
  authorTrustedVerifier: boolean

  text: string
  createdAt: string | null
  indexedAt: string | null

  isReply: boolean
  isRoot: boolean
  isSelfReply: boolean
  replyRootUri: string | null
  replyParentUri: string | null
  replyParentDid: string | null

  isQuote: boolean
  quotedUri: string | null
  quotedAuthorHandle: string | null
  quotedText: string | null

  links: BookmarkLink[]
  hasLinks: boolean
  linkCount: number
  primaryDomain: string | null

  hasImages: boolean
  imageCount: number
  altText: string
  hasAltText: boolean
  hasVideo: boolean
  hasMedia: boolean

  hasExternal: boolean
  externalUri: string | null
  externalTitle: string | null
  externalDescription: string | null
  externalThumb: string | null

  mentions: BookmarkMention[]
  mentionCount: number
  tags: string[]
  tagCount: number
  langs: string[]
  labels: string[]
  hasLabels: boolean

  wordCount: number
  charCount: number

  likeCount: number | null
  repostCount: number | null
  replyCount: number | null
  quoteCount: number | null
  bookmarkCount: number | null
}

/** A bookmark as returned by the HTTP API. */
export type BookmarkRecord = BookmarkMetadata & {
  id: number
  status: 'active' | 'removed'
  firstSeenAt: string
  lastSeenAt: string
  removedAt: string | null
  /** Web URL of the post on bsky.app, derived from the AT-URI. */
  postUrl: string | null
  /** Populated by search responses only. */
  score?: number
  highlights?: string[]
}

export type SyncMode = 'backfill' | 'quick' | 'full'
export type SyncTrigger = 'login' | 'schedule' | 'manual'
export type SyncStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type SyncRun = {
  id: number
  did: string
  mode: SyncMode
  trigger: SyncTrigger
  status: SyncStatus
  startedAt: string
  finishedAt: string | null
  pages: number
  scanned: number
  created: number
  updated: number
  removed: number
  restored: number
  error: string | null
}

export type AccountRecord = {
  did: string
  handle: string
  displayName: string | null
  avatar: string | null
  pdsUrl: string
  isOwner: boolean
  createdAt: string
  lastSyncAt: string | null
  lastSyncStatus: string | null
  backfillCompletedAt: string | null
}
