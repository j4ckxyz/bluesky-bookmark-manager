import type { Db } from './index.ts'
import type { BookmarkLink, BookmarkMetadata, BookmarkRecord } from '../types.ts'
import { postUrlFromUri } from '../metadata.ts'

export type UpsertOutcome = 'created' | 'updated' | 'restored'

export type BookmarkRow = {
  id: number
  did: string
  uri: string
  cid: string | null
  rkey: string | null
  bookmarked_at: string | null
  first_seen_at: string
  last_seen_at: string
  last_seen_run: number
  removed_at: string | null
  status: string
  sort_index: number
  item_state: string
  author_did: string | null
  author_handle: string | null
  author_display_name: string | null
  author_avatar: string | null
  author_verified: number
  author_trusted_verifier: number
  text: string | null
  created_at: string | null
  indexed_at: string | null
  is_reply: number
  is_root: number
  is_self_reply: number
  reply_root_uri: string | null
  reply_parent_uri: string | null
  reply_parent_did: string | null
  is_quote: number
  quoted_uri: string | null
  quoted_author_handle: string | null
  quoted_text: string | null
  has_links: number
  link_count: number
  has_images: number
  image_count: number
  has_alt_text: number
  has_video: number
  has_media: number
  has_external: number
  external_uri: string | null
  external_title: string | null
  external_description: string | null
  primary_domain: string | null
  mention_count: number
  tag_count: number
  langs: string
  labels: string
  has_labels: number
  word_count: number
  char_count: number
  alt_text: string | null
  like_count: number | null
  repost_count: number | null
  reply_count: number | null
  quote_count: number | null
  bookmark_count: number | null
  raw: string | null
}

const jsonArray = (value: string | null): string[] => {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export class BookmarkStore {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  get db(): Db {
    return this.#db
  }

  /**
   * Inserts or refreshes one bookmark and everything derived from it
   * (child rows and the full-text index) in a single transaction.
   */
  upsert(
    did: string,
    meta: BookmarkMetadata,
    options: { seenAt: string; runId: number; sortIndex: number; raw?: unknown },
  ): UpsertOutcome {
    return this.#db.transaction((): UpsertOutcome => {
      const existing = this.#db
        .prepare('SELECT id, status FROM bookmarks WHERE did = ? AND uri = ?')
        .get(did, meta.uri) as { id: number; status: string } | undefined

      const outcome: UpsertOutcome = !existing
        ? 'created'
        : existing.status === 'removed'
          ? 'restored'
          : 'updated'

      const params = {
        did,
        uri: meta.uri,
        cid: meta.cid,
        rkey: meta.rkey,
        bookmarked_at: meta.bookmarkedAt,
        seen_at: options.seenAt,
        seen_run: options.runId,
        sort_index: options.sortIndex,
        item_state: meta.itemState,
        author_did: meta.authorDid,
        author_handle: meta.authorHandle,
        author_display_name: meta.authorDisplayName,
        author_avatar: meta.authorAvatar,
        author_verified: meta.authorVerified ? 1 : 0,
        author_trusted_verifier: meta.authorTrustedVerifier ? 1 : 0,
        text: meta.text,
        created_at: meta.createdAt,
        indexed_at: meta.indexedAt,
        is_reply: meta.isReply ? 1 : 0,
        is_root: meta.isRoot ? 1 : 0,
        is_self_reply: meta.isSelfReply ? 1 : 0,
        reply_root_uri: meta.replyRootUri,
        reply_parent_uri: meta.replyParentUri,
        reply_parent_did: meta.replyParentDid,
        is_quote: meta.isQuote ? 1 : 0,
        quoted_uri: meta.quotedUri,
        quoted_author_handle: meta.quotedAuthorHandle,
        quoted_text: meta.quotedText,
        has_links: meta.hasLinks ? 1 : 0,
        link_count: meta.linkCount,
        has_images: meta.hasImages ? 1 : 0,
        image_count: meta.imageCount,
        has_alt_text: meta.hasAltText ? 1 : 0,
        has_video: meta.hasVideo ? 1 : 0,
        has_media: meta.hasMedia ? 1 : 0,
        has_external: meta.hasExternal ? 1 : 0,
        external_uri: meta.externalUri,
        external_title: meta.externalTitle,
        external_description: meta.externalDescription,
        primary_domain: meta.primaryDomain,
        mention_count: meta.mentionCount,
        tag_count: meta.tagCount,
        langs: JSON.stringify(meta.langs),
        labels: JSON.stringify(meta.labels),
        has_labels: meta.hasLabels ? 1 : 0,
        word_count: meta.wordCount,
        char_count: meta.charCount,
        alt_text: meta.altText,
        like_count: meta.likeCount,
        repost_count: meta.repostCount,
        reply_count: meta.replyCount,
        quote_count: meta.quoteCount,
        bookmark_count: meta.bookmarkCount,
        raw: options.raw === undefined ? null : JSON.stringify(options.raw),
      }

      let id: number
      if (existing) {
        id = existing.id
        this.#db
          .prepare(
            `UPDATE bookmarks SET
               cid = @cid, rkey = @rkey, bookmarked_at = @bookmarked_at,
               last_seen_at = @seen_at, last_seen_run = @seen_run,
               removed_at = NULL, status = 'active',
               sort_index = @sort_index, item_state = @item_state,
               author_did = @author_did, author_handle = @author_handle,
               author_display_name = @author_display_name, author_avatar = @author_avatar,
               author_verified = @author_verified, author_trusted_verifier = @author_trusted_verifier,
               text = @text, created_at = @created_at, indexed_at = @indexed_at,
               is_reply = @is_reply, is_root = @is_root, is_self_reply = @is_self_reply,
               reply_root_uri = @reply_root_uri, reply_parent_uri = @reply_parent_uri,
               reply_parent_did = @reply_parent_did,
               is_quote = @is_quote, quoted_uri = @quoted_uri,
               quoted_author_handle = @quoted_author_handle, quoted_text = @quoted_text,
               has_links = @has_links, link_count = @link_count,
               has_images = @has_images, image_count = @image_count, has_alt_text = @has_alt_text,
               has_video = @has_video, has_media = @has_media,
               has_external = @has_external, external_uri = @external_uri,
               external_title = @external_title, external_description = @external_description,
               primary_domain = @primary_domain,
               mention_count = @mention_count, tag_count = @tag_count,
               langs = @langs, labels = @labels, has_labels = @has_labels,
               word_count = @word_count, char_count = @char_count, alt_text = @alt_text,
               like_count = @like_count, repost_count = @repost_count, reply_count = @reply_count,
               quote_count = @quote_count, bookmark_count = @bookmark_count,
               raw = @raw
             WHERE id = @id`,
          )
          .run({ ...params, id })
      } else {
        const result = this.#db
          .prepare(
            `INSERT INTO bookmarks (
               did, uri, cid, rkey, bookmarked_at, first_seen_at, last_seen_at, last_seen_run, status, sort_index, item_state,
               author_did, author_handle, author_display_name, author_avatar, author_verified, author_trusted_verifier,
               text, created_at, indexed_at,
               is_reply, is_root, is_self_reply, reply_root_uri, reply_parent_uri, reply_parent_did,
               is_quote, quoted_uri, quoted_author_handle, quoted_text,
               has_links, link_count, has_images, image_count, has_alt_text, has_video, has_media,
               has_external, external_uri, external_title, external_description, primary_domain,
               mention_count, tag_count, langs, labels, has_labels,
               word_count, char_count, alt_text,
               like_count, repost_count, reply_count, quote_count, bookmark_count, raw
             ) VALUES (
               @did, @uri, @cid, @rkey, @bookmarked_at, @seen_at, @seen_at, @seen_run, 'active', @sort_index, @item_state,
               @author_did, @author_handle, @author_display_name, @author_avatar, @author_verified, @author_trusted_verifier,
               @text, @created_at, @indexed_at,
               @is_reply, @is_root, @is_self_reply, @reply_root_uri, @reply_parent_uri, @reply_parent_did,
               @is_quote, @quoted_uri, @quoted_author_handle, @quoted_text,
               @has_links, @link_count, @has_images, @image_count, @has_alt_text, @has_video, @has_media,
               @has_external, @external_uri, @external_title, @external_description, @primary_domain,
               @mention_count, @tag_count, @langs, @labels, @has_labels,
               @word_count, @char_count, @alt_text,
               @like_count, @repost_count, @reply_count, @quote_count, @bookmark_count, @raw
             )`,
          )
          .run(params)
        id = Number(result.lastInsertRowid)
      }

      this.#replaceChildren(id, meta)
      this.#replaceFts(id, meta)
      return outcome
    })()
  }

  #replaceChildren(id: number, meta: BookmarkMetadata): void {
    this.#db.prepare('DELETE FROM bookmark_links WHERE bookmark_id = ?').run(id)
    this.#db.prepare('DELETE FROM bookmark_mentions WHERE bookmark_id = ?').run(id)
    this.#db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').run(id)

    const insertLink = this.#db.prepare(
      'INSERT INTO bookmark_links (bookmark_id, url, domain, source, title) VALUES (?, ?, ?, ?, ?)',
    )
    for (const link of meta.links) {
      insertLink.run(id, link.url, link.domain, link.source, link.title ?? null)
    }

    const insertMention = this.#db.prepare(
      'INSERT INTO bookmark_mentions (bookmark_id, did, handle) VALUES (?, ?, ?)',
    )
    for (const mention of meta.mentions) {
      insertMention.run(id, mention.did ?? null, mention.handle?.toLowerCase() ?? null)
    }

    const insertTag = this.#db.prepare('INSERT INTO bookmark_tags (bookmark_id, tag) VALUES (?, ?)')
    for (const tag of meta.tags) insertTag.run(id, tag.toLowerCase())
  }

  #replaceFts(id: number, meta: BookmarkMetadata): void {
    this.#db.prepare('DELETE FROM bookmarks_fts WHERE rowid = ?').run(id)
    this.#db
      .prepare(
        `INSERT INTO bookmarks_fts (rowid, text, author, tags, link_text, alt_text, quoted_text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        meta.text,
        [meta.authorHandle, meta.authorDisplayName].filter(Boolean).join(' '),
        meta.tags.join(' '),
        linkText(meta),
        meta.altText,
        [meta.quotedAuthorHandle, meta.quotedText].filter(Boolean).join(' '),
      )
  }

  /**
   * Reconciles a full remote listing: anything we hold that the server no
   * longer lists has been un-bookmarked, so soft-delete it. Soft deletion
   * keeps the archive intact and lets people search what they removed.
   */
  markMissingAsRemoved(did: string, runId: number, removedAt: string): number {
    const result = this.#db
      .prepare(
        `UPDATE bookmarks
         SET status = 'removed', removed_at = ?
         WHERE did = ? AND status = 'active' AND last_seen_run <> ?`,
      )
      .run(removedAt, did, runId)
    return result.changes
  }

  /** Hard-deletes soft-deleted bookmarks older than the retention window. */
  purgeRemoved(did: string, olderThanDays: number): number {
    if (olderThanDays <= 0) return 0
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString()
    const ids = this.#db
      .prepare("SELECT id FROM bookmarks WHERE did = ? AND status = 'removed' AND removed_at < ?")
      .all(did, cutoff) as Array<{ id: number }>
    const deleteFts = this.#db.prepare('DELETE FROM bookmarks_fts WHERE rowid = ?')
    const deleteRow = this.#db.prepare('DELETE FROM bookmarks WHERE id = ?')
    this.#db.transaction(() => {
      for (const { id } of ids) {
        deleteFts.run(id)
        deleteRow.run(id)
      }
    })()
    return ids.length
  }

  knownUris(did: string): Set<string> {
    const rows = this.#db.prepare('SELECT uri FROM bookmarks WHERE did = ?').all(did) as Array<{
      uri: string
    }>
    return new Set(rows.map((r) => r.uri))
  }

  countActive(did: string): number {
    const row = this.#db
      .prepare("SELECT count(*) AS c FROM bookmarks WHERE did = ? AND status = 'active'")
      .get(did) as { c: number }
    return row.c
  }

  getById(did: string, id: number): BookmarkRecord | null {
    const row = this.#db.prepare('SELECT * FROM bookmarks WHERE did = ? AND id = ?').get(did, id) as
      | BookmarkRow
      | undefined
    return row ? this.hydrate(row) : null
  }

  getByUri(did: string, uri: string): BookmarkRecord | null {
    const row = this.#db.prepare('SELECT * FROM bookmarks WHERE did = ? AND uri = ?').get(did, uri) as
      | BookmarkRow
      | undefined
    return row ? this.hydrate(row) : null
  }

  /** Expands a row plus its child tables into an API-shaped record. */
  hydrate(row: BookmarkRow): BookmarkRecord {
    const links = this.#db
      .prepare('SELECT url, domain, source, title FROM bookmark_links WHERE bookmark_id = ?')
      .all(row.id) as Array<{
      url: string
      domain: string
      source: string
      title: string | null
    }>
    const mentions = this.#db
      .prepare('SELECT did, handle FROM bookmark_mentions WHERE bookmark_id = ?')
      .all(row.id) as Array<{ did: string | null; handle: string | null }>
    const tags = this.#db
      .prepare('SELECT tag FROM bookmark_tags WHERE bookmark_id = ?')
      .all(row.id) as Array<{ tag: string }>

    return {
      id: row.id,
      uri: row.uri,
      cid: row.cid,
      rkey: row.rkey,
      bookmarkedAt: row.bookmarked_at,
      itemState: row.item_state as BookmarkRecord['itemState'],
      status: row.status === 'removed' ? 'removed' : 'active',
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      removedAt: row.removed_at,
      postUrl: postUrlFromUri(row.uri, row.author_handle),

      authorDid: row.author_did,
      authorHandle: row.author_handle,
      authorDisplayName: row.author_display_name,
      authorAvatar: row.author_avatar,
      authorVerified: row.author_verified === 1,
      authorTrustedVerifier: row.author_trusted_verifier === 1,

      text: row.text ?? '',
      createdAt: row.created_at,
      indexedAt: row.indexed_at,

      isReply: row.is_reply === 1,
      isRoot: row.is_root === 1,
      isSelfReply: row.is_self_reply === 1,
      replyRootUri: row.reply_root_uri,
      replyParentUri: row.reply_parent_uri,
      replyParentDid: row.reply_parent_did,

      isQuote: row.is_quote === 1,
      quotedUri: row.quoted_uri,
      quotedAuthorHandle: row.quoted_author_handle,
      quotedText: row.quoted_text,

      links: links.map((l) => ({
        url: l.url,
        domain: l.domain,
        source: l.source as BookmarkLink['source'],
        ...(l.title ? { title: l.title } : {}),
      })),
      hasLinks: row.has_links === 1,
      linkCount: row.link_count,
      primaryDomain: row.primary_domain,

      hasImages: row.has_images === 1,
      imageCount: row.image_count,
      altText: row.alt_text ?? '',
      hasAltText: row.has_alt_text === 1,
      hasVideo: row.has_video === 1,
      hasMedia: row.has_media === 1,

      hasExternal: row.has_external === 1,
      externalUri: row.external_uri,
      externalTitle: row.external_title,
      externalDescription: row.external_description,

      mentions: mentions.map((m) => ({
        ...(m.did ? { did: m.did } : {}),
        ...(m.handle ? { handle: m.handle } : {}),
      })),
      mentionCount: row.mention_count,
      tags: tags.map((t) => t.tag),
      tagCount: row.tag_count,
      langs: jsonArray(row.langs),
      labels: jsonArray(row.labels),
      hasLabels: row.has_labels === 1,

      wordCount: row.word_count,
      charCount: row.char_count,

      likeCount: row.like_count,
      repostCount: row.repost_count,
      replyCount: row.reply_count,
      quoteCount: row.quote_count,
      bookmarkCount: row.bookmark_count,
    }
  }
}

/** Everything textual about a post's links, so `MATCH` can hit URLs and titles. */
function linkText(meta: BookmarkMetadata): string {
  const parts: string[] = []
  for (const link of meta.links) {
    parts.push(link.domain)
    parts.push(link.url.replace(/[/?#=&_.-]+/g, ' '))
    if (link.title) parts.push(link.title)
  }
  if (meta.externalTitle) parts.push(meta.externalTitle)
  if (meta.externalDescription) parts.push(meta.externalDescription)
  return parts.join(' ')
}
