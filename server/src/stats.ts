import type { Db } from './db/index.ts'

export type StatsBucket = { value: string; count: number; label?: string }

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
  topAuthors: StatsBucket[]
  topDomains: StatsBucket[]
  topTags: StatsBucket[]
  languages: StatsBucket[]
  /** Bookmarks saved per calendar month, oldest first. */
  savedByMonth: Array<{ month: string; count: number }>
  /** Bookmarks saved per weekday, Monday first. */
  savedByWeekday: Array<{ day: string; count: number }>
  mostLiked: Array<{ uri: string; text: string; handle: string | null; likeCount: number }>
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Aggregates the whole archive for the stats screen. Everything is scoped to
 * active bookmarks unless the field says otherwise.
 */
export function computeStats(db: Db, did: string): Stats {
  const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T
  const many = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[]

  const active = "did = ? AND status = 'active'"

  const totals = one<{
    active: number
    authors: number
    words: number
    links: number
  }>(
    `SELECT count(*) AS active, count(DISTINCT author_handle) AS authors,
            COALESCE(SUM(word_count), 0) AS words, COALESCE(SUM(link_count), 0) AS links
     FROM bookmarks WHERE ${active}`,
    did,
  )

  const removed = one<{ c: number }>(
    "SELECT count(*) AS c FROM bookmarks WHERE did = ? AND status = 'removed'",
    did,
  ).c

  const domains = one<{ c: number }>(
    `SELECT count(DISTINCT l.domain) AS c FROM bookmark_links l
     JOIN bookmarks b ON b.id = l.bookmark_id WHERE b.did = ? AND b.status = 'active'`,
    did,
  ).c

  const tags = one<{ c: number }>(
    `SELECT count(DISTINCT t.tag) AS c FROM bookmark_tags t
     JOIN bookmarks b ON b.id = t.bookmark_id WHERE b.did = ? AND b.status = 'active'`,
    did,
  ).c

  const range = one<{
    firstSaved: string | null
    lastSaved: string | null
    oldestPost: string | null
  }>(
    `SELECT MIN(bookmarked_at) AS firstSaved, MAX(bookmarked_at) AS lastSaved, MIN(created_at) AS oldestPost
     FROM bookmarks WHERE ${active}`,
    did,
  )

  const content = one<Stats['content']>(
    `SELECT
       COALESCE(SUM(has_links), 0)       AS withLinks,
       COALESCE(SUM(has_images), 0)      AS withImages,
       COALESCE(SUM(has_video), 0)       AS withVideo,
       COALESCE(SUM(has_alt_text), 0)    AS withAltText,
       COALESCE(SUM(is_reply), 0)        AS replies,
       COALESCE(SUM(is_quote), 0)        AS quotes,
       COALESCE(SUM(author_verified), 0) AS verifiedAuthors,
       COALESCE(SUM(has_labels), 0)      AS labelled,
       COALESCE(SUM(CASE WHEN item_state = 'not_found' THEN 1 ELSE 0 END), 0) AS deletedUpstream,
       COALESCE(SUM(CASE WHEN item_state = 'blocked'   THEN 1 ELSE 0 END), 0) AS blocked
     FROM bookmarks WHERE ${active}`,
    did,
  )

  const topAuthors = many<StatsBucket>(
    `SELECT author_handle AS value, MIN(author_display_name) AS label, count(*) AS count
     FROM bookmarks WHERE ${active} AND author_handle IS NOT NULL
     GROUP BY author_handle ORDER BY count DESC, value ASC LIMIT 10`,
    did,
  )

  const topDomains = many<StatsBucket>(
    `SELECT l.domain AS value, count(DISTINCT b.id) AS count
     FROM bookmark_links l JOIN bookmarks b ON b.id = l.bookmark_id
     WHERE b.did = ? AND b.status = 'active'
     GROUP BY l.domain ORDER BY count DESC, value ASC LIMIT 10`,
    did,
  )

  const topTags = many<StatsBucket>(
    `SELECT t.tag AS value, count(DISTINCT b.id) AS count
     FROM bookmark_tags t JOIN bookmarks b ON b.id = t.bookmark_id
     WHERE b.did = ? AND b.status = 'active'
     GROUP BY t.tag ORDER BY count DESC, value ASC LIMIT 10`,
    did,
  )

  const languages = many<StatsBucket>(
    `SELECT json_each.value AS value, count(DISTINCT b.id) AS count
     FROM bookmarks b, json_each(b.langs)
     WHERE b.did = ? AND b.status = 'active'
     GROUP BY json_each.value ORDER BY count DESC, value ASC LIMIT 10`,
    did,
  )

  const savedByMonth = many<{ month: string; count: number }>(
    `SELECT substr(bookmarked_at, 1, 7) AS month, count(*) AS count
     FROM bookmarks WHERE ${active} AND bookmarked_at IS NOT NULL
     GROUP BY month ORDER BY month ASC`,
    did,
  )

  const weekdayRows = many<{ day: string; count: number }>(
    `SELECT strftime('%w', bookmarked_at) AS day, count(*) AS count
     FROM bookmarks WHERE ${active} AND bookmarked_at IS NOT NULL
     GROUP BY day`,
    did,
  )
  const weekdayCounts = new Map(weekdayRows.map((r) => [Number(r.day), r.count]))
  const savedByWeekday = [1, 2, 3, 4, 5, 6, 0].map((index) => ({
    day: WEEKDAYS[index]!,
    count: weekdayCounts.get(index) ?? 0,
  }))

  const mostLiked = many<{
    uri: string
    text: string | null
    handle: string | null
    likeCount: number | null
  }>(
    `SELECT uri, text, author_handle AS handle, like_count AS likeCount
     FROM bookmarks WHERE ${active} AND like_count IS NOT NULL
     ORDER BY like_count DESC LIMIT 5`,
    did,
  ).map((row) => ({
    uri: row.uri,
    text: row.text ?? '',
    handle: row.handle,
    likeCount: row.likeCount ?? 0,
  }))

  return {
    totals: {
      active: totals.active,
      removed,
      all: totals.active + removed,
      authors: totals.authors,
      domains,
      tags,
      words: totals.words,
    },
    range,
    content,
    averages: {
      wordsPerPost: totals.active === 0 ? 0 : Math.round((totals.words / totals.active) * 10) / 10,
      linksPerPost: totals.active === 0 ? 0 : Math.round((totals.links / totals.active) * 100) / 100,
    },
    topAuthors,
    topDomains,
    topTags,
    languages,
    savedByMonth,
    savedByWeekday,
    mostLiked,
  }
}
