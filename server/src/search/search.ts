import type { Db } from '../db/index.ts'
import type { BookmarkStore, BookmarkRow } from '../db/bookmarks.ts'
import type { BookmarkRecord } from '../types.ts'
import { allowedEdits } from '../lib/fuzzy.ts'
import { isEmptyQuery, parseQuery, type ParsedQuery, type TextTerm } from './query.ts'

export type SortOrder =
  | 'relevance'
  | 'saved'
  | 'oldest-saved'
  | 'posted'
  | 'oldest-posted'
  | 'likes'
  | 'reposts'

export type StatusFilter = 'active' | 'removed' | 'all'

export type SearchOptions = {
  q?: string
  limit?: number
  offset?: number
  sort?: SortOrder
  status?: StatusFilter
  /** Structured filters from the UI panel, ANDed with anything in `q`. */
  filters?: {
    from?: string[]
    mentions?: string[]
    domains?: string[]
    tags?: string[]
    langs?: string[]
    has?: string[]
    is?: string[]
    before?: string | null
    after?: string | null
  }
  /** Compute facet counts over the matched set. Costs a few extra queries. */
  withFacets?: boolean
}

export type FacetBucket = { value: string; count: number; label?: string }

export type SearchFacets = {
  authors: FacetBucket[]
  domains: FacetBucket[]
  tags: FacetBucket[]
  langs: FacetBucket[]
  attributes: FacetBucket[]
}

export type SearchResult = {
  total: number
  limit: number
  offset: number
  sort: SortOrder
  took: number
  /** Terms actually searched for, including any typo corrections applied. */
  terms: string[]
  corrections: Array<{ from: string; to: string[] }>
  results: BookmarkRecord[]
  facets?: SearchFacets
}

/**
 * bm25 column weights, in schema order:
 * text, author, tags, link_text, alt_text, quoted_text.
 * A hit in the post's own words beats a hit in a quoted post's words.
 */
const BM25_WEIGHTS = '10.0, 6.0, 8.0, 3.0, 2.0, 2.0'
const RECENCY_WEIGHT = 1.6
const ENGAGEMENT_WEIGHT = 0.2
const EXACT_TERM_BONUS = 1.2
/** Never expand one term into more than this many alternative spellings. */
const MAX_FUZZY_ALTERNATIVES = 6

/** FTS5 rejects table aliases in MATCH and bm25(), so the name is used bare. */
const FTS = 'bookmarks_fts'

type MatchPlan = {
  positive: string | null
  negative: string | null
  /** Literal terms to bonus-score and to hand back for highlighting. */
  literals: string[]
  highlightTerms: string[]
  corrections: Array<{ from: string; to: string[] }>
}

export class SearchService {
  readonly #db: Db
  readonly #bookmarks: BookmarkStore

  constructor(db: Db, bookmarks: BookmarkStore) {
    this.#db = db
    this.#bookmarks = bookmarks
  }

  search(did: string, options: SearchOptions = {}): SearchResult {
    const startedAt = performance.now()

    const parsed = mergeFilters(parseQuery(options.q ?? ''), options.filters)
    const limit = Math.min(200, Math.max(1, options.limit ?? 25))
    const offset = Math.max(0, options.offset ?? 0)
    const plan = this.#planMatch(parsed)
    const scored = plan.positive !== null
    const sort: SortOrder = options.sort ?? (scored ? 'relevance' : 'saved')

    const where = this.#buildWhere(did, parsed, options.status ?? 'active')
    const from = scored ? `FROM bookmarks b JOIN ${FTS} ON ${FTS}.rowid = b.id` : 'FROM bookmarks b'

    const conditions = [where.sql]
    const conditionParams = [...where.params]
    if (plan.positive) {
      conditions.push(`${FTS} MATCH ?`)
      conditionParams.push(plan.positive)
    }
    if (plan.negative) {
      conditions.push(`b.id NOT IN (SELECT rowid FROM ${FTS} WHERE ${FTS} MATCH ?)`)
      conditionParams.push(plan.negative)
    }

    const tail = `${from} WHERE ${conditions.join(' AND ')}`

    const totalRow = this.#db.prepare(`SELECT count(*) AS c ${tail}`).get(...conditionParams) as {
      c: number
    }

    // Score placeholders sit in the SELECT list, so they bind before the
    // WHERE parameters. Positional binding follows textual order.
    const scoreSql = scored ? this.#scoreExpression(plan.literals.length) : '0'
    const scoreParams = scored ? plan.literals.map((t) => t.toLowerCase()) : []

    const rows = this.#db
      .prepare(`SELECT b.*, ${scoreSql} AS score ${tail} ORDER BY ${orderBy(sort, scored)} LIMIT ? OFFSET ?`)
      .all(...scoreParams, ...conditionParams, limit, offset) as Array<BookmarkRow & { score: number }>

    const results = rows.map((row) => {
      const record = this.#bookmarks.hydrate(row)
      record.score = Math.round(row.score * 10_000) / 10_000
      if (plan.highlightTerms.length > 0) record.highlights = plan.highlightTerms
      return record
    })

    const result: SearchResult = {
      total: totalRow.c,
      limit,
      offset,
      sort,
      took: Math.round((performance.now() - startedAt) * 100) / 100,
      terms: plan.highlightTerms,
      corrections: plan.corrections,
      results,
    }

    if (options.withFacets) {
      result.facets = this.#facets(from, conditions, conditionParams)
    }

    return result
  }

  /**
   * Turns parsed text terms into FTS5 match expressions.
   *
   * Quoted terms match verbatim. Bare terms also match as prefixes, so a
   * partial word hits, and — only when the term is nowhere in the index —
   * they expand to near-spellings drawn from the term vocabulary.
   */
  #planMatch(query: ParsedQuery): MatchPlan {
    const positives: string[] = []
    const negatives: string[] = []
    const literals: string[] = []
    const highlightTerms = new Set<string>()
    const corrections: Array<{ from: string; to: string[] }> = []

    for (const term of query.terms) {
      if (term.negated) {
        negatives.push(ftsPhrase(term.value))
        continue
      }

      literals.push(term.value)
      highlightTerms.add(term.value)

      if (term.exact) {
        positives.push(ftsPhrase(term.value))
        continue
      }

      const alternatives = this.#expandTerm(term)
      if (alternatives.length > 0) {
        corrections.push({ from: term.value, to: alternatives })
        for (const alt of alternatives) highlightTerms.add(alt)
      }

      const group = [ftsPhrase(term.value), `${ftsPhrase(term.value)}*`]
      for (const alt of alternatives) group.push(ftsPhrase(alt))
      positives.push(`(${group.join(' OR ')})`)
    }

    return {
      positive: positives.length > 0 ? positives.join(' AND ') : null,
      negative: negatives.length > 0 ? negatives.join(' OR ') : null,
      literals,
      highlightTerms: [...highlightTerms],
      corrections,
    }
  }

  /**
   * Finds near-spellings for a term the index does not contain. A correctly
   * spelled term costs two indexed lookups and no scan.
   */
  #expandTerm(term: TextTerm): string[] {
    const maxEdits = allowedEdits(term.value)
    if (maxEdits === 0) return []

    const exact = this.#db.prepare(`SELECT cnt FROM bookmarks_vocab WHERE term = ?`).get(term.value) as
      | { cnt: number }
      | undefined
    if (exact && exact.cnt > 0) return []

    // Prefix matching already covers "the word continues"; fuzzing is for typos.
    const prefixHit = this.#db
      .prepare(`SELECT 1 AS hit FROM bookmarks_vocab WHERE term > ? AND term < ? LIMIT 1`)
      .get(term.value, `${term.value}\u{10FFFF}`) as { hit: number } | undefined
    if (prefixHit) return []

    const rows = this.#db
      .prepare(
        `SELECT term FROM bookmarks_vocab
         WHERE length(term) BETWEEN ? AND ?
           AND edit_distance(term, ?) <= ?
         ORDER BY cnt DESC
         LIMIT ?`,
      )
      .all(
        Math.max(1, term.value.length - maxEdits),
        term.value.length + maxEdits,
        term.value,
        maxEdits,
        MAX_FUZZY_ALTERNATIVES,
      ) as Array<{ term: string }>

    return rows.map((r) => r.term)
  }

  /**
   * Relevance = text match strength, plus a nudge for recently saved and
   * widely liked posts, plus a bonus per literal query term that appears in
   * the post text, so exact hits outrank fuzzy ones.
   */
  #scoreExpression(literalCount: number): string {
    const parts = [
      `(-bm25(${FTS}, ${BM25_WEIGHTS}))`,
      `${RECENCY_WEIGHT} * (1.0 / (1.0 + MAX(0, julianday('now') - julianday(COALESCE(b.bookmarked_at, b.created_at, b.first_seen_at))) / 365.0))`,
      `${ENGAGEMENT_WEIGHT} * log10(1 + COALESCE(b.like_count, 0))`,
    ]
    for (let i = 0; i < literalCount; i++) {
      parts.push(
        `${EXACT_TERM_BONUS} * (CASE WHEN instr(lower(COALESCE(b.text, '')), ?) > 0 THEN 1 ELSE 0 END)`,
      )
    }
    return parts.join(' + ')
  }

  #buildWhere(did: string, query: ParsedQuery, status: StatusFilter): { sql: string; params: unknown[] } {
    const clauses: string[] = ['b.did = ?']
    const params: unknown[] = [did]

    const effectiveStatus: StatusFilter = query.is.includes('removed') ? 'removed' : status
    if (effectiveStatus === 'active') clauses.push("b.status = 'active'")
    else if (effectiveStatus === 'removed') clauses.push("b.status = 'removed'")

    if (query.from.length > 0) {
      clauses.push(
        `(${placeholders('b.author_handle', query.from)} OR ${placeholders('b.author_did', query.from)})`,
      )
      params.push(...query.from, ...query.from)
    }
    if (query.notFrom.length > 0) {
      clauses.push(
        `NOT (${placeholders('b.author_handle', query.notFrom)} OR ${placeholders('b.author_did', query.notFrom)})`,
      )
      params.push(...query.notFrom, ...query.notFrom)
    }

    if (query.mentions.length > 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM bookmark_mentions m WHERE m.bookmark_id = b.id
           AND (${placeholders('m.handle', query.mentions)} OR ${placeholders('m.did', query.mentions)}))`,
      )
      params.push(...query.mentions, ...query.mentions)
    }

    // A domain filter also matches subdomains: `domain:bbc.co.uk` catches
    // `news.bbc.co.uk`.
    for (const domain of query.domains) {
      clauses.push(
        'EXISTS (SELECT 1 FROM bookmark_links l WHERE l.bookmark_id = b.id AND (l.domain = ? OR l.domain LIKE ?))',
      )
      params.push(domain, `%.${domain}`)
    }

    if (query.tags.length > 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id AND ${placeholders('t.tag', query.tags)})`,
      )
      params.push(...query.tags)
    }

    if (query.langs.length > 0) {
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(b.langs) WHERE ${placeholders('json_each.value', query.langs)})`,
      )
      params.push(...query.langs)
    }

    for (const flag of query.has) {
      const clause = hasClause(flag)
      if (clause) clauses.push(clause)
    }
    for (const flag of query.notHas) {
      const clause = hasClause(flag)
      if (clause) clauses.push(`NOT (${clause})`)
    }
    for (const flag of query.is) {
      const clause = isClause(flag)
      if (clause) clauses.push(clause)
    }
    for (const flag of query.notIs) {
      const clause = isClause(flag)
      if (clause) clauses.push(`NOT (${clause})`)
    }

    if (query.after) {
      clauses.push('b.created_at >= ?')
      params.push(query.after)
    }
    if (query.before) {
      clauses.push('b.created_at <= ?')
      params.push(query.before)
    }
    if (query.savedAfter) {
      clauses.push('b.bookmarked_at >= ?')
      params.push(query.savedAfter)
    }
    if (query.savedBefore) {
      clauses.push('b.bookmarked_at <= ?')
      params.push(query.savedBefore)
    }

    return { sql: clauses.join(' AND '), params }
  }

  /** Facet counts over exactly the matched set, one grouped query each. */
  #facets(from: string, conditions: string[], params: unknown[]): SearchFacets {
    const where = conditions.join(' AND ')

    const bucket = (sql: string): FacetBucket[] =>
      (this.#db.prepare(sql).all(...params) as Array<{
        value: string | null
        count: number
        label?: string | null
      }>)
        .filter((r): r is { value: string; count: number; label?: string | null } => Boolean(r.value))
        .map((r) => ({ value: r.value, count: r.count, ...(r.label ? { label: r.label } : {}) }))

    const authors = bucket(
      `SELECT b.author_handle AS value, MIN(b.author_display_name) AS label, count(*) AS count
       ${from} WHERE ${where} AND b.author_handle IS NOT NULL
       GROUP BY b.author_handle ORDER BY count DESC, value ASC LIMIT 15`,
    )

    const domains = bucket(
      `SELECT l.domain AS value, count(DISTINCT b.id) AS count
       ${from} JOIN bookmark_links l ON l.bookmark_id = b.id WHERE ${where}
       GROUP BY l.domain ORDER BY count DESC, value ASC LIMIT 15`,
    )

    const tags = bucket(
      `SELECT t.tag AS value, count(DISTINCT b.id) AS count
       ${from} JOIN bookmark_tags t ON t.bookmark_id = b.id WHERE ${where}
       GROUP BY t.tag ORDER BY count DESC, value ASC LIMIT 15`,
    )

    const langs = bucket(
      `SELECT json_each.value AS value, count(DISTINCT b.id) AS count
       ${from} JOIN json_each(b.langs) WHERE ${where}
       GROUP BY json_each.value ORDER BY count DESC, value ASC LIMIT 10`,
    )

    const attributeRow = this.#db
      .prepare(
        `SELECT
           SUM(b.has_links) AS link, SUM(b.has_images) AS image, SUM(b.has_video) AS video,
           SUM(b.has_external) AS external, SUM(b.is_reply) AS reply, SUM(b.is_quote) AS quote,
           SUM(b.author_verified) AS verified, SUM(b.has_alt_text) AS alt, SUM(b.has_labels) AS labels
         ${from} WHERE ${where}`,
      )
      .get(...params) as Record<string, number | null>

    const attributes: FacetBucket[] = Object.entries(attributeRow)
      .map(([value, count]) => ({ value, count: count ?? 0 }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count)

    return { authors, domains, tags, langs, attributes }
  }
}

function orderBy(sort: SortOrder, scored: boolean): string {
  switch (sort) {
    case 'relevance':
      return scored ? 'score DESC, b.bookmarked_at DESC' : 'b.bookmarked_at DESC, b.id DESC'
    case 'saved':
      return 'b.bookmarked_at DESC, b.id DESC'
    case 'oldest-saved':
      return 'b.bookmarked_at ASC, b.id ASC'
    case 'posted':
      return 'b.created_at DESC, b.id DESC'
    case 'oldest-posted':
      return 'b.created_at ASC, b.id ASC'
    case 'likes':
      return 'COALESCE(b.like_count, 0) DESC, b.bookmarked_at DESC'
    case 'reposts':
      return 'COALESCE(b.repost_count, 0) DESC, b.bookmarked_at DESC'
  }
}

function placeholders(column: string, values: string[]): string {
  return `${column} IN (${values.map(() => '?').join(', ')})`
}

function hasClause(flag: string): string | null {
  switch (flag) {
    case 'link':
      return 'b.has_links = 1'
    case 'image':
      return 'b.has_images = 1'
    case 'video':
      return 'b.has_video = 1'
    case 'media':
      return 'b.has_media = 1'
    case 'alt':
      return 'b.has_alt_text = 1'
    case 'quote':
      return 'b.is_quote = 1'
    case 'tag':
      return 'b.tag_count > 0'
    case 'mention':
      return 'b.mention_count > 0'
    case 'labels':
      return 'b.has_labels = 1'
    case 'text':
      return "COALESCE(b.text, '') <> ''"
    default:
      return null
  }
}

function isClause(flag: string): string | null {
  switch (flag) {
    case 'reply':
      return 'b.is_reply = 1'
    case 'root':
      return 'b.is_root = 1'
    case 'thread':
    case 'selfreply':
      return 'b.is_self_reply = 1'
    case 'quote':
      return 'b.is_quote = 1'
    case 'verified':
      return 'b.author_verified = 1'
    case 'deleted':
      return "b.item_state = 'not_found'"
    case 'blocked':
      return "b.item_state = 'blocked'"
    // `removed` and `active` steer the status filter instead.
    default:
      return null
  }
}

/** Quotes a term for FTS5, escaping any embedded double quotes. */
function ftsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Folds UI filter selections into the parsed query. */
function mergeFilters(query: ParsedQuery, filters: SearchOptions['filters']): ParsedQuery {
  if (!filters) return query
  return {
    ...query,
    from: [...query.from, ...(filters.from ?? []).map(clean)],
    mentions: [...query.mentions, ...(filters.mentions ?? []).map(clean)],
    domains: [...query.domains, ...(filters.domains ?? []).map((d) => d.toLowerCase())],
    tags: [...query.tags, ...(filters.tags ?? []).map((t) => t.toLowerCase().replace(/^#/, ''))],
    langs: [...query.langs, ...(filters.langs ?? []).map((l) => l.toLowerCase())],
    has: [...query.has, ...(filters.has ?? [])],
    is: [...query.is, ...(filters.is ?? [])],
    before: filters.before ?? query.before,
    after: filters.after ?? query.after,
  }
}

const clean = (value: string): string => value.trim().toLowerCase().replace(/^@/, '')

export { isEmptyQuery, parseQuery }
