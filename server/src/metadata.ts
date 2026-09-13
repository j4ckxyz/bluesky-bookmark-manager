import type { BookmarkLink, BookmarkMention, BookmarkMetadata } from './types.ts'

/**
 * Bookmark views come off the wire as loosely-typed lexicon data, and the
 * records inside them are authored by arbitrary users. Everything here reads
 * defensively: a malformed post should lose metadata, never break a sync.
 */
type Unknown = Record<string, unknown>

const isObject = (v: unknown): v is Unknown => typeof v === 'object' && v !== null && !Array.isArray(v)
const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const typeOf = (v: unknown): string => (isObject(v) && typeof v['$type'] === 'string' ? v['$type'] : '')

/** Strips the fragment so `app.bsky.embed.images#view` matches `app.bsky.embed.images`. */
const embedIs = (v: unknown, nsid: string): boolean => typeOf(v).split('#')[0] === nsid

/** Extracts the record key from an AT-URI (`at://did/collection/rkey`). */
export function rkeyFromUri(uri: string): string | null {
  const parts = uri.split('/')
  return parts.length >= 5 ? (parts[4] ?? null) : null
}

/** Extracts the repo DID from an AT-URI. */
export function didFromUri(uri: string): string | null {
  const match = /^at:\/\/([^/]+)/.exec(uri)
  return match?.[1] ?? null
}

/** Builds the bsky.app permalink for a post AT-URI. */
export function postUrlFromUri(uri: string, handle?: string | null): string | null {
  const did = didFromUri(uri)
  const rkey = rkeyFromUri(uri)
  if (!did || !rkey) return null
  return `https://bsky.app/profile/${handle ?? did}/post/${rkey}`
}

/**
 * Normalises a URL to a registrable-ish domain for filtering and stats:
 * lowercased host with a leading `www.` removed.
 */
export function domainOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host
  } catch {
    return ''
  }
}

/** Matches bare URLs in post text for posts that arrive without link facets. */
const BARE_URL = /\bhttps?:\/\/[^\s<>()"']+/gi

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

function pushLink(
  links: Map<string, BookmarkLink>,
  url: string,
  source: BookmarkLink['source'],
  title?: string | null,
): void {
  const domain = domainOf(url)
  if (!domain) return
  const existing = links.get(url)
  if (existing) {
    if (title && !existing.title) existing.title = title
    return
  }
  links.set(url, title ? { url, domain, source, title } : { url, domain, source })
}

/** Walks rich-text facets, collecting links, mentions and hashtags. */
function readFacets(
  facets: unknown[],
  links: Map<string, BookmarkLink>,
  mentions: Map<string, BookmarkMention>,
  tags: Set<string>,
): void {
  for (const facet of facets) {
    if (!isObject(facet)) continue
    for (const feature of asArray(facet['features'])) {
      if (!isObject(feature)) continue
      const kind = typeOf(feature)
      if (kind === 'app.bsky.richtext.facet#link') {
        const uri = asString(feature['uri'])
        if (uri) pushLink(links, uri, 'facet')
      } else if (kind === 'app.bsky.richtext.facet#mention') {
        const did = asString(feature['did'])
        if (did) mentions.set(did, { did })
      } else if (kind === 'app.bsky.richtext.facet#tag') {
        const tag = asString(feature['tag'])
        if (tag) tags.add(tag.replace(/^#/, '').toLowerCase())
      }
    }
  }
}

type MediaCounts = {
  images: number
  altTexts: string[]
  video: boolean
  external: { uri: string; title: string | null; description: string | null } | null
  quoted: { uri: string; handle: string | null; text: string | null } | null
}

/** Recursively reads an embed view, folding nested record-with-media embeds. */
function readEmbed(embed: unknown, out: MediaCounts): void {
  if (!isObject(embed)) return

  if (embedIs(embed, 'app.bsky.embed.images')) {
    for (const image of asArray(embed['images'])) {
      if (!isObject(image)) continue
      out.images++
      const alt = asString(image['alt'])
      if (alt) out.altTexts.push(alt)
    }
    return
  }

  if (embedIs(embed, 'app.bsky.embed.gallery')) {
    for (const item of asArray(embed['items'])) {
      if (!isObject(item)) continue
      out.images++
      const alt = asString(item['alt'])
      if (alt) out.altTexts.push(alt)
    }
    return
  }

  if (embedIs(embed, 'app.bsky.embed.video')) {
    out.video = true
    const alt = asString(embed['alt'])
    if (alt) out.altTexts.push(alt)
    return
  }

  if (embedIs(embed, 'app.bsky.embed.external')) {
    const external = embed['external']
    if (isObject(external)) {
      const uri = asString(external['uri'])
      if (uri) {
        out.external = {
          uri,
          title: asString(external['title']),
          description: asString(external['description']),
        }
      }
    }
    return
  }

  if (embedIs(embed, 'app.bsky.embed.record')) {
    const record = embed['record']
    if (isObject(record) && typeOf(record) === 'app.bsky.embed.record#viewRecord') {
      const uri = asString(record['uri'])
      if (uri) {
        const author = isObject(record['author']) ? record['author'] : null
        const value = isObject(record['value']) ? record['value'] : null
        out.quoted = {
          uri,
          handle: author ? asString(author['handle']) : null,
          text: value ? asString(value['text']) : null,
        }
      }
    }
    return
  }

  if (embedIs(embed, 'app.bsky.embed.recordWithMedia')) {
    readEmbed(embed['record'], out)
    readEmbed(embed['media'], out)
  }
}

/** Reads self-labels off the record plus moderation labels off the view. */
function readLabels(record: Unknown | null, view: Unknown): string[] {
  const values = new Set<string>()

  const selfLabels = record ? record['labels'] : null
  if (isObject(selfLabels)) {
    for (const entry of asArray(selfLabels['values'])) {
      if (!isObject(entry)) continue
      const val = asString(entry['val'])
      if (val) values.add(val)
    }
  }

  for (const label of asArray(view['labels'])) {
    if (!isObject(label)) continue
    // A negated label means "previously applied, now retracted".
    if (label['neg'] === true) continue
    const val = asString(label['val'])
    if (val) values.add(val)
  }

  return [...values]
}

const EMPTY: Omit<BookmarkMetadata, 'uri' | 'cid' | 'rkey' | 'bookmarkedAt' | 'itemState'> = {
  authorDid: null,
  authorHandle: null,
  authorDisplayName: null,
  authorAvatar: null,
  authorVerified: false,
  authorTrustedVerifier: false,
  text: '',
  createdAt: null,
  indexedAt: null,
  isReply: false,
  isRoot: true,
  isSelfReply: false,
  replyRootUri: null,
  replyParentUri: null,
  replyParentDid: null,
  isQuote: false,
  quotedUri: null,
  quotedAuthorHandle: null,
  quotedText: null,
  links: [],
  hasLinks: false,
  linkCount: 0,
  primaryDomain: null,
  hasImages: false,
  imageCount: 0,
  altText: '',
  hasAltText: false,
  hasVideo: false,
  hasMedia: false,
  hasExternal: false,
  externalUri: null,
  externalTitle: null,
  externalDescription: null,
  mentions: [],
  mentionCount: 0,
  tags: [],
  tagCount: 0,
  langs: [],
  labels: [],
  hasLabels: false,
  wordCount: 0,
  charCount: 0,
  likeCount: null,
  repostCount: null,
  replyCount: null,
  quoteCount: null,
  bookmarkCount: null,
}

/**
 * Derives searchable metadata from one `app.bsky.bookmark.defs#bookmarkView`.
 *
 * Handles the three `item` variants the lexicon allows: a resolvable
 * `postView`, a `notFoundPost`, and a `blockedPost`. For the latter two we
 * keep the bookmark with whatever the subject ref tells us, so a deleted post
 * still shows up in the archive rather than silently vanishing.
 */
export function extractMetadata(bookmarkView: unknown): BookmarkMetadata | null {
  if (!isObject(bookmarkView)) return null

  const subject = isObject(bookmarkView['subject']) ? bookmarkView['subject'] : null
  const item = isObject(bookmarkView['item']) ? bookmarkView['item'] : null

  const uri = asString(subject?.['uri']) ?? asString(item?.['uri'])
  if (!uri) return null

  const base = {
    uri,
    cid: asString(subject?.['cid']),
    rkey: rkeyFromUri(uri),
    bookmarkedAt: asString(bookmarkView['createdAt']),
  }

  const itemType = typeOf(item)
  if (itemType === 'app.bsky.feed.defs#notFoundPost') {
    return { ...EMPTY, ...base, itemState: 'not_found', authorDid: didFromUri(uri) }
  }
  if (itemType === 'app.bsky.feed.defs#blockedPost') {
    const author = isObject(item?.['author']) ? item['author'] : null
    return {
      ...EMPTY,
      ...base,
      itemState: 'blocked',
      authorDid: asString(author?.['did']) ?? didFromUri(uri),
    }
  }
  if (!item || itemType !== 'app.bsky.feed.defs#postView') {
    return { ...EMPTY, ...base, itemState: 'unknown', authorDid: didFromUri(uri) }
  }

  return { ...extractFromPostView(item), ...base, cid: base.cid ?? asString(item['cid']) }
}

/** The metadata half of {@link extractMetadata}, for a resolvable post view. */
export function extractFromPostView(post: Unknown): BookmarkMetadata {
  const uri = asString(post['uri']) ?? ''
  const record = isObject(post['record']) ? post['record'] : null
  const author = isObject(post['author']) ? post['author'] : null
  const verification = author && isObject(author['verification']) ? author['verification'] : null

  const text = (record ? asString(record['text']) : null) ?? ''

  const links = new Map<string, BookmarkLink>()
  const mentions = new Map<string, BookmarkMention>()
  const tags = new Set<string>()

  if (record) {
    readFacets(asArray(record['facets']), links, mentions, tags)
    for (const tag of asArray(record['tags'])) {
      const value = asString(tag)
      if (value) tags.add(value.replace(/^#/, '').toLowerCase())
    }
  }

  // Fall back to scanning the text so link-less facets still yield domains.
  for (const match of text.matchAll(BARE_URL)) {
    pushLink(links, match[0].replace(/[.,;:!?)\]]+$/, ''), 'text')
  }

  const media: MediaCounts = { images: 0, altTexts: [], video: false, external: null, quoted: null }
  readEmbed(post['embed'], media)

  if (media.external) {
    pushLink(links, media.external.uri, 'embed', media.external.title)
  }

  // Mentions carry only a DID in the facet; the AppView hydrates handles into
  // the post text, so recover them from the `@handle` tokens where we can.
  const handleTokens = [...text.matchAll(/@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)].map((m) =>
    m[1]!.toLowerCase(),
  )
  const mentionList = [...mentions.values()]
  mentionList.forEach((mention, index) => {
    const handle = handleTokens[index]
    if (handle) mention.handle = handle
  })
  // Handles present in the text but not facet-linked still count as mentions.
  for (const handle of handleTokens) {
    if (!mentionList.some((m) => m.handle === handle)) mentionList.push({ handle })
  }

  const reply = record && isObject(record['reply']) ? record['reply'] : null
  const replyParent = reply && isObject(reply['parent']) ? reply['parent'] : null
  const replyRoot = reply && isObject(reply['root']) ? reply['root'] : null
  const replyParentUri = asString(replyParent?.['uri'])
  const replyParentDid = replyParentUri ? didFromUri(replyParentUri) : null
  const authorDid = asString(author?.['did'])

  const linkList = [...links.values()]
  const altText = media.altTexts.join('\n')
  const langs = asArray(record?.['langs'])
    .map(asString)
    .filter((v): v is string => v !== null)
  const labels = readLabels(record, post)

  return {
    uri,
    cid: asString(post['cid']),
    rkey: rkeyFromUri(uri),
    bookmarkedAt: null,
    itemState: 'ok',

    authorDid,
    authorHandle: asString(author?.['handle']),
    authorDisplayName: asString(author?.['displayName']),
    authorAvatar: asString(author?.['avatar']),
    authorVerified: verification?.['verifiedStatus'] === 'valid',
    authorTrustedVerifier: verification?.['trustedVerifierStatus'] === 'valid',

    text,
    createdAt: (record ? asString(record['createdAt']) : null) ?? asString(post['indexedAt']),
    indexedAt: asString(post['indexedAt']),

    isReply: reply !== null,
    isRoot: reply === null,
    isSelfReply: reply !== null && authorDid !== null && replyParentDid === authorDid,
    replyRootUri: asString(replyRoot?.['uri']),
    replyParentUri,
    replyParentDid,

    isQuote: media.quoted !== null,
    quotedUri: media.quoted?.uri ?? null,
    quotedAuthorHandle: media.quoted?.handle ?? null,
    quotedText: media.quoted?.text ?? null,

    links: linkList,
    hasLinks: linkList.length > 0,
    linkCount: linkList.length,
    primaryDomain: linkList[0]?.domain ?? null,

    hasImages: media.images > 0,
    imageCount: media.images,
    altText,
    hasAltText: altText.length > 0,
    hasVideo: media.video,
    hasMedia: media.images > 0 || media.video,

    hasExternal: media.external !== null,
    externalUri: media.external?.uri ?? null,
    externalTitle: media.external?.title ?? null,
    externalDescription: media.external?.description ?? null,

    mentions: mentionList,
    mentionCount: mentionList.length,
    tags: [...tags],
    tagCount: tags.size,
    langs,
    labels,
    hasLabels: labels.length > 0,

    wordCount: countWords(text),
    charCount: [...text].length,

    likeCount: asNumber(post['likeCount']),
    repostCount: asNumber(post['repostCount']),
    replyCount: asNumber(post['replyCount']),
    quoteCount: asNumber(post['quoteCount']),
    bookmarkCount: asNumber(post['bookmarkCount']),
  }
}
