/**
 * Builders for `app.bsky.bookmark.defs#bookmarkView` payloads, shaped exactly
 * as the lexicon defines them so the parsing code is exercised for real.
 */

export type PostOptions = {
  uri?: string
  cid?: string
  text?: string
  handle?: string
  did?: string
  displayName?: string
  verified?: boolean
  trustedVerifier?: boolean
  createdAt?: string
  indexedAt?: string
  bookmarkedAt?: string
  langs?: string[]
  tags?: string[]
  selfLabels?: string[]
  modLabels?: string[]
  links?: string[]
  mentions?: Array<{ did: string; handle: string }>
  images?: Array<{ alt: string }>
  video?: boolean
  external?: { uri: string; title: string; description: string; thumb?: string }
  quote?: { uri: string; handle: string; text: string }
  replyTo?: { parentUri: string; rootUri: string }
  likeCount?: number
  repostCount?: number
  replyCount?: number
  quoteCount?: number
  bookmarkCount?: number
}

let counter = 0

export function bookmarkView(options: PostOptions = {}): Record<string, unknown> {
  const did = options.did ?? 'did:plc:author1'
  const uri = options.uri ?? `at://${did}/app.bsky.feed.post/post${++counter}`
  const cid = options.cid ?? `bafy${counter}`
  const createdAt = options.createdAt ?? '2026-01-15T10:00:00.000Z'

  const facets: unknown[] = []
  for (const link of options.links ?? []) {
    facets.push({
      index: { byteStart: 0, byteEnd: 1 },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: link }],
    })
  }
  for (const mention of options.mentions ?? []) {
    facets.push({
      index: { byteStart: 0, byteEnd: 1 },
      features: [{ $type: 'app.bsky.richtext.facet#mention', did: mention.did }],
    })
  }
  for (const tag of options.tags ?? []) {
    facets.push({
      index: { byteStart: 0, byteEnd: 1 },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    })
  }

  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text: options.text ?? 'A post about the AT Protocol',
    createdAt,
  }
  if (facets.length > 0) record['facets'] = facets
  if (options.langs) record['langs'] = options.langs
  if (options.selfLabels) {
    record['labels'] = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: options.selfLabels.map((val) => ({ val })),
    }
  }
  if (options.replyTo) {
    record['reply'] = {
      parent: { uri: options.replyTo.parentUri, cid: 'bafyparent' },
      root: { uri: options.replyTo.rootUri, cid: 'bafyroot' },
    }
  }

  const post: Record<string, unknown> = {
    $type: 'app.bsky.feed.defs#postView',
    uri,
    cid,
    author: {
      did,
      handle: options.handle ?? 'alice.bsky.social',
      displayName: options.displayName ?? 'Alice',
      ...(options.verified || options.trustedVerifier
        ? {
            verification: {
              verifications: [],
              verifiedStatus: options.verified ? 'valid' : 'none',
              trustedVerifierStatus: options.trustedVerifier ? 'valid' : 'none',
            },
          }
        : {}),
    },
    record,
    indexedAt: options.indexedAt ?? createdAt,
  }

  const embed = buildEmbed(options)
  if (embed) post['embed'] = embed
  if (options.modLabels) {
    post['labels'] = options.modLabels.map((val) => ({
      src: 'did:plc:labeler',
      uri,
      val,
      cts: createdAt,
    }))
  }
  if (options.likeCount !== undefined) post['likeCount'] = options.likeCount
  if (options.repostCount !== undefined) post['repostCount'] = options.repostCount
  if (options.replyCount !== undefined) post['replyCount'] = options.replyCount
  if (options.quoteCount !== undefined) post['quoteCount'] = options.quoteCount
  if (options.bookmarkCount !== undefined) post['bookmarkCount'] = options.bookmarkCount

  return {
    $type: 'app.bsky.bookmark.defs#bookmarkView',
    subject: { uri, cid },
    createdAt: options.bookmarkedAt ?? '2026-02-01T09:00:00.000Z',
    item: post,
  }
}

function buildEmbed(options: PostOptions): Record<string, unknown> | null {
  const media = buildMedia(options)
  const quote = options.quote
    ? {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: options.quote.uri,
          cid: 'bafyquote',
          author: { did: 'did:plc:quoted', handle: options.quote.handle },
          value: { $type: 'app.bsky.feed.post', text: options.quote.text },
          indexedAt: '2026-01-01T00:00:00.000Z',
        },
      }
    : null

  if (media && quote) {
    return { $type: 'app.bsky.embed.recordWithMedia#view', record: quote, media }
  }
  return quote ?? media
}

function buildMedia(options: PostOptions): Record<string, unknown> | null {
  if (options.images) {
    return {
      $type: 'app.bsky.embed.images#view',
      images: options.images.map((image, index) => ({
        thumb: `https://cdn.example/thumb${index}.jpg`,
        fullsize: `https://cdn.example/full${index}.jpg`,
        alt: image.alt,
      })),
    }
  }
  if (options.video) {
    return {
      $type: 'app.bsky.embed.video#view',
      cid: 'bafyvideo',
      playlist: 'https://video.example/playlist.m3u8',
      alt: 'A short clip',
    }
  }
  if (options.external) {
    return { $type: 'app.bsky.embed.external#view', external: { ...options.external } }
  }
  return null
}

export function notFoundBookmark(uri: string): Record<string, unknown> {
  return {
    $type: 'app.bsky.bookmark.defs#bookmarkView',
    subject: { uri, cid: 'bafygone' },
    createdAt: '2026-02-01T09:00:00.000Z',
    item: { $type: 'app.bsky.feed.defs#notFoundPost', uri, notFound: true },
  }
}

export function blockedBookmark(uri: string, authorDid: string): Record<string, unknown> {
  return {
    $type: 'app.bsky.bookmark.defs#bookmarkView',
    subject: { uri, cid: 'bafyblocked' },
    createdAt: '2026-02-01T09:00:00.000Z',
    item: {
      $type: 'app.bsky.feed.defs#blockedPost',
      uri,
      blocked: true,
      author: { did: authorDid },
    },
  }
}

/** Splits a list of bookmark views into a cursor-paged fetcher. */
export function pagedFetcher(views: unknown[], pageSize = 2) {
  let calls = 0
  const fetcher = async ({ cursor }: { cursor?: string | undefined; limit: number }) => {
    calls++
    const offset = cursor ? Number.parseInt(cursor, 10) : 0
    const slice = views.slice(offset, offset + pageSize)
    const next = offset + pageSize
    return {
      bookmarks: slice,
      cursor: next < views.length ? String(next) : undefined,
    }
  }
  return Object.assign(fetcher, { get calls() { return calls } })
}
