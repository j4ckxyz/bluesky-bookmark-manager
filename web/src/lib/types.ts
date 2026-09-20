/** Mirrors the server's `/api/v1` response shapes. */

export type BookmarkLink = {
  url: string
  domain: string
  source: 'facet' | 'embed' | 'text'
  title?: string
}

export type BookmarkMention = { did?: string; handle?: string }

export type Bookmark = {
  id: number
  uri: string
  cid: string | null
  rkey: string | null
  bookmarkedAt: string | null
  itemState: 'ok' | 'not_found' | 'blocked' | 'unknown'
  status: 'active' | 'removed'
  firstSeenAt: string
  lastSeenAt: string
  removedAt: string | null
  postUrl: string | null

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

  score?: number
  highlights?: string[]
}

export type FacetBucket = { value: string; count: number; label?: string }

export type SearchFacets = {
  authors: FacetBucket[]
  domains: FacetBucket[]
  tags: FacetBucket[]
  langs: FacetBucket[]
  attributes: FacetBucket[]
}

export type SortOrder =
  | 'relevance'
  | 'saved'
  | 'oldest-saved'
  | 'posted'
  | 'oldest-posted'
  | 'likes'
  | 'reposts'

export type StatusFilter = 'active' | 'removed' | 'all'

export type SearchResponse = {
  total: number
  limit: number
  offset: number
  sort: SortOrder
  took: number
  terms: string[]
  corrections: Array<{ from: string; to: string[] }>
  results: Bookmark[]
  facets?: SearchFacets
}

export type Account = {
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

export type SyncProgress = {
  id: number
  did: string
  mode: 'backfill' | 'quick' | 'full'
  trigger: 'login' | 'schedule' | 'manual'
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string | null
  pages: number
  scanned: number
  created: number
  updated: number
  removed: number
  restored: number
  error: string | null
  totalStored: number
  active: boolean
}

export type SessionResponse = {
  account: Account | null
  providerLabel?: string
  sync?: SyncProgress | null
}

export type InstanceInfo = {
  multiUser: boolean
  claimed: boolean
  openToNewAccounts: boolean
  restrictedToHandles: string[] | null
  syncIntervalMinutes: number
  defaultProvider: string
}

export type TypeaheadActor = {
  did: string
  handle: string
  displayName: string | null
  avatar: string | null
  verified: boolean
}

export type ResolvedIdentity = {
  did: string
  handle: string
  pdsUrl: string
  providerLabel: string
  displayName: string | null
  avatar: string | null
}

export type Stats = {
  totals: {
    active: number
    removed: number
    all: number
    authors: number
    domains: number
    tags: number
    words: number
  }
  range: { firstSaved: string | null; lastSaved: string | null; oldestPost: string | null }
  content: {
    withLinks: number
    withImages: number
    withVideo: number
    withAltText: number
    replies: number
    quotes: number
    verifiedAuthors: number
    labelled: number
    deletedUpstream: number
    blocked: number
  }
  averages: { wordsPerPost: number; linksPerPost: number }
  topAuthors: FacetBucket[]
  topDomains: FacetBucket[]
  topTags: FacetBucket[]
  languages: FacetBucket[]
  savedByMonth: Array<{ month: string; count: number }>
  savedByWeekday: Array<{ day: string; count: number }>
  mostLiked: Array<{ uri: string; text: string; handle: string | null; likeCount: number }>
  sync: SyncProgress | null
}

export type ApiToken = {
  name: string
  hint: string
  createdAt: string
  lastUsedAt: string | null
}

export type Suggestions = {
  authors: FacetBucket[]
  tags: FacetBucket[]
  domains: FacetBucket[]
}
