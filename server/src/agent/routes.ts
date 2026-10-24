import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.ts'
import type { BookmarkRow } from '../db/bookmarks.ts'
import { urlKey } from '../lib/url.ts'
import type { SearchOptions, SortOrder } from '../search/search.ts'
import { computeStats } from '../stats.ts'
import type { AccountRecord, BookmarkRecord } from '../types.ts'
import { describeApi, paramsFor, UNAUTHENTICATED_PER_MINUTE } from './docs.ts'
import { AgentRequestError, parseParams, toSearchOptions, type Parsed, type RawQuery } from './params.ts'
import { compact, presenter } from './present.ts'
import { renderSkill } from './skill.ts'

type AgentRequest = FastifyRequest<{ Querystring: RawQuery; Params: Record<string, string> }>
type Handler = (request: AgentRequest, account: AccountRecord, parsed: Parsed) => unknown

/**
 * The agent API: a read-only, strictly validated view of one person's
 * archive, meant to be driven by an AI agent holding an `agent` token.
 *
 * Isolation: every query here is scoped to `account.did`, and the account
 * comes only from the token (or the browser session). No parameter names an
 * account, so there is nothing to point at someone else's archive.
 */
export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  // One bucket per token across every agent endpoint. Callers without a valid
  // token share a much smaller per-address budget, which also caps guessing.
  const limiter = app.rateLimit({
    timeWindow: 60_000,
    max: (request: FastifyRequest) =>
      request.account ? ctx.config.agentRateLimitPerMinute : UNAUTHENTICATED_PER_MINUTE,
    keyGenerator: (request: FastifyRequest) =>
      request.apiGrant
        ? `agent:token:${request.apiGrant.id}`
        : request.account
          ? `agent:session:${request.account.did}`
          : `agent:ip:${request.ip}`,
  })

  const route = (path: string, handler: Handler, options: { auth?: boolean } = {}) => {
    const specs = paramsFor(path)
    const url = path.replace(/\{(\w+)\}/g, ':$1')
    app.get<{ Querystring: RawQuery; Params: Record<string, string> }>(
      url,
      { onRequest: limiter },
      async (request, reply) => {
        const account = options.auth === false ? null : requireAgent(request, reply)
        if (options.auth !== false && !account) return reply
        try {
          return await handler(request, account!, parseParams(request.query, specs))
        } catch (err) {
          if (err instanceof AgentRequestError) return sendError(reply, err)
          throw err
        }
      },
    )
  }

  const baseUrl = (request: FastifyRequest): string => {
    const configured = process.env['PUBLIC_URL'] ? ctx.config.publicUrl : null
    return (configured ?? `${request.protocol}://${request.host}`).replace(/\/+$/, '')
  }

  route('/api/agent/v1', (request) => describeApi(baseUrl(request), ctx.config.agentRateLimitPerMinute), {
    auth: false,
  })

  app.get<{ Querystring: { base_url?: string } }>(
    '/api/agent/v1/skill',
    { onRequest: limiter },
    async (request, reply) => {
      let base = baseUrl(request)
      const override = request.query.base_url
      if (override) {
        // Only an http(s) origin, so the rendered file cannot carry anything else.
        try {
          const parsed = new URL(override)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme')
          base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
        } catch {
          return sendError(reply, new AgentRequestError('invalid_parameter', '`base_url` must be an http(s) URL.'))
        }
      }
      return reply
        .type('text/markdown; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(renderSkill({ baseUrl: base, requestsPerMinute: ctx.config.agentRateLimitPerMinute }))
    },
  )

  route('/api/agent/v1/me', (request, account) => {
    const archive = ctx.db
      .prepare(
        `SELECT
           SUM(status = 'active') AS active, SUM(status = 'removed') AS removed,
           MIN(CASE WHEN status = 'active' THEN bookmarked_at END) AS firstSavedAt,
           MAX(CASE WHEN status = 'active' THEN bookmarked_at END) AS lastSavedAt,
           MIN(CASE WHEN status = 'active' THEN created_at END) AS oldestPostAt
         FROM bookmarks WHERE did = ?`,
      )
      .get(account.did) as Record<string, number | string | null>
    const sync = ctx.engine.status(account.did)
    const grant = request.apiGrant
    return {
      account: { handle: account.handle, did: account.did, displayName: account.displayName },
      access: {
        via: grant ? 'token' : 'session',
        readOnly: true,
        ...(grant ? { tokenName: grant.name, scope: grant.scope, expiresAt: grant.expiresAt } : {}),
      },
      archive: {
        bookmarks: archive['active'] ?? 0,
        removed: archive['removed'] ?? 0,
        firstSavedAt: archive['firstSavedAt'],
        lastSavedAt: archive['lastSavedAt'],
        oldestPostAt: archive['oldestPostAt'],
      },
      sync: {
        lastSyncAt: account.lastSyncAt,
        lastStatus: account.lastSyncStatus,
        running: sync?.status === 'running',
        backfillComplete: account.backfillCompletedAt !== null,
        intervalMinutes: ctx.config.syncIntervalMinutes,
      },
      rateLimit: { requestsPerMinute: ctx.config.agentRateLimitPerMinute },
    }
  })

  route('/api/agent/v1/bookmarks', (_request, account, parsed) => {
    const options = toSearchOptions(parsed, atUriResolver(ctx, account.did))
    const limit = (parsed.get('limit') as number | undefined) ?? 20
    const offset = (parsed.get('offset') as number | undefined) ?? 0
    const present = presenter(
      ((parsed.get('view') as string | undefined) ?? 'compact') as 'compact' | 'full',
      (parsed.get('fields') as string[] | undefined) ?? [],
    )
    const sort = parsed.get('sort') as SortOrder | undefined

    const result = ctx.search.search(account.did, {
      ...options,
      limit,
      offset,
      ...(sort ? { sort } : {}),
      withFacets: parsed.get('facets') === true,
    })
    const count = result.results.length
    return {
      total: result.total,
      count,
      offset,
      limit,
      nextOffset: offset + count < result.total && count > 0 ? offset + count : null,
      sort: result.sort,
      tookMs: result.took,
      query: { terms: result.terms, corrections: result.corrections },
      results: result.results.map(present),
      ...(result.facets ? { facets: result.facets } : {}),
    }
  })

  const single = (record: BookmarkRecord | null, view: 'compact' | 'full', did: string, ref: string) => {
    if (!record) {
      throw new AgentRequestError(
        'not_found',
        `\`${ref}\` is not in this archive.`,
        'Only bookmarked posts are stored. Search with /api/agent/v1/bookmarks to find one.',
        404,
      )
    }
    const related = (filters: SearchOptions['filters'], limit: number) =>
      ctx.search
        .search(did, { filters, status: 'all', sort: 'oldest-posted', limit })
        .results.filter((r) => r.id !== record.id)
        .map(compact)

    const root = record.replyRootUri ?? record.uri
    const quoted = record.quotedUri ? ctx.bookmarks.getByUri(did, record.quotedUri) : null
    return {
      bookmark: presenter(view, [])(record),
      related: {
        thread: related({ threads: [root] }, 50),
        quoted: quoted ? compact(quoted) : null,
        quotedBy: related({ quoting: [record.uri] }, 20),
      },
    }
  }

  route('/api/agent/v1/bookmarks/{id}', (request, account, parsed) => {
    const id = request.params['id'] ?? ''
    const view = ((parsed.get('view') as string | undefined) ?? 'compact') as 'compact' | 'full'
    if (!/^\d+$/.test(id)) {
      throw new AgentRequestError(
        'invalid_parameter',
        `Bookmark ids are numbers, got \`${id}\`.`,
        'To find a bookmark by at:// URI or bsky.app link use /api/agent/v1/lookup?ref=…',
      )
    }
    return single(ctx.bookmarks.getById(account.did, Number.parseInt(id, 10)), view, account.did, id)
  })

  route('/api/agent/v1/lookup', (_request, account, parsed) => {
    const ref = (parsed.get('ref') as string | undefined) ?? ''
    if (!ref) throw new AgentRequestError('invalid_parameter', 'Pass `ref`: a bookmark id, an at:// URI or a bsky.app post link.')
    const view = ((parsed.get('view') as string | undefined) ?? 'compact') as 'compact' | 'full'
    return single(findByRef(ctx, account.did, ref), view, account.did, ref)
  })

  /** Shared plumbing for the breakdown endpoints. */
  const aggregate = (account: AccountRecord, parsed: Parsed) => {
    const options = toSearchOptions(parsed, atUriResolver(ctx, account.did))
    const matched = ctx.search.matchedIds(account.did, options)
    return {
      options,
      matched,
      limit: (parsed.get('limit') as number | undefined) ?? 50,
      offset: (parsed.get('offset') as number | undefined) ?? 0,
      sort: ((parsed.get('sort') as string | undefined) ?? 'count') as 'count' | 'recent' | 'name',
    }
  }

  const page = <T>(
    rows: T[],
    total: number,
    limit: number,
    offset: number,
  ): { total: number; count: number; offset: number; limit: number; nextOffset: number | null; results: T[] } => ({
    total,
    count: rows.length,
    offset,
    limit,
    nextOffset: offset + rows.length < total && rows.length > 0 ? offset + rows.length : null,
    results: rows,
  })

  route('/api/agent/v1/links', (_request, account, parsed) => {
    const { options, matched, limit, offset, sort } = aggregate(account, parsed)
    const filters = options.filters ?? {}

    // Narrow the listed links themselves, not only the bookmarks scanned:
    // "links to github.com" should not also list every other link in those posts.
    const linkClauses: string[] = []
    const linkParams: unknown[] = []
    const anyDomains = filters.anyDomains ?? []
    if (anyDomains.length > 0) {
      linkClauses.push(`(${anyDomains.map(() => '(l.domain = ? OR l.domain LIKE ?)').join(' OR ')})`)
      for (const d of anyDomains) linkParams.push(d, `%.${d}`)
    }
    for (const d of filters.notDomains ?? []) {
      linkClauses.push('NOT (l.domain = ? OR l.domain LIKE ?)')
      linkParams.push(d, `%.${d}`)
    }
    const urls = filters.urls ?? []
    if (urls.length > 0) {
      linkClauses.push(`url_key(l.url) IN (${urls.map(() => '?').join(', ')})`)
      linkParams.push(...urls.map(urlKey))
    }
    const contains = filters.urlContains ?? []
    if (contains.length > 0) {
      linkClauses.push(`(${contains.map(() => 'instr(lower(l.url), ?) > 0').join(' OR ')})`)
      linkParams.push(...contains.map((c) => c.toLowerCase()))
    }

    const base = `FROM bookmark_links l JOIN bookmarks b ON b.id = l.bookmark_id
      WHERE b.id IN (${matched.sql})${linkClauses.map((c) => ` AND ${c}`).join('')}`
    const params = [...matched.params, ...linkParams]

    const total = (
      ctx.db.prepare(`SELECT count(*) AS c FROM (SELECT url_key(l.url) ${base} GROUP BY 1)`).get(...params) as {
        c: number
      }
    ).c

    const order =
      sort === 'recent'
        ? 'lastSavedAt DESC, bookmarks DESC'
        : sort === 'name'
          ? 'url ASC'
          : 'bookmarks DESC, lastSavedAt DESC'
    const rows = ctx.db
      .prepare(
        `SELECT url_key(l.url) AS key, MIN(l.url) AS url, MIN(l.domain) AS domain, MAX(l.title) AS title,
                count(DISTINCT b.id) AS bookmarks,
                MIN(b.bookmarked_at) AS firstSavedAt, MAX(b.bookmarked_at) AS lastSavedAt,
                group_concat(DISTINCT b.id) AS ids
         ${base} GROUP BY key ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
      key: string
      url: string
      domain: string
      title: string | null
      bookmarks: number
      firstSavedAt: string | null
      lastSavedAt: string | null
      ids: string
    }>

    return page(
      rows.map(({ key: _key, ids, ...row }) => ({
        ...row,
        // Newest first, capped: pass them to /bookmarks?ids= to read the posts.
        bookmarkIds: ids
          .split(',')
          .map(Number)
          .sort((a, b) => b - a)
          .slice(0, 20),
      })),
      total,
      limit,
      offset,
    )
  })

  route('/api/agent/v1/domains', (_request, account, parsed) => {
    const { matched, limit, offset, sort } = aggregate(account, parsed)
    const base = `FROM bookmark_links l JOIN bookmarks b ON b.id = l.bookmark_id WHERE b.id IN (${matched.sql})`
    const total = (
      ctx.db.prepare(`SELECT count(DISTINCT l.domain) AS c ${base}`).get(...matched.params) as { c: number }
    ).c
    const order = sort === 'recent' ? 'lastSavedAt DESC' : sort === 'name' ? 'domain ASC' : 'bookmarks DESC, domain ASC'
    const rows = ctx.db
      .prepare(
        `SELECT l.domain AS domain, count(DISTINCT b.id) AS bookmarks, count(DISTINCT url_key(l.url)) AS links,
                MIN(b.bookmarked_at) AS firstSavedAt, MAX(b.bookmarked_at) AS lastSavedAt
         ${base} GROUP BY l.domain ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...matched.params, limit, offset)
    return page(rows, total, limit, offset)
  })

  route('/api/agent/v1/authors', (_request, account, parsed) => {
    const { matched, limit, offset, sort } = aggregate(account, parsed)
    const base = `FROM bookmarks b WHERE b.id IN (${matched.sql})
      AND (b.author_did IS NOT NULL OR b.author_handle IS NOT NULL)`
    const total = (
      ctx.db
        .prepare(`SELECT count(DISTINCT COALESCE(b.author_did, b.author_handle)) AS c ${base}`)
        .get(...matched.params) as { c: number }
    ).c
    const order = sort === 'recent' ? 'lastSavedAt DESC' : sort === 'name' ? 'handle ASC' : 'bookmarks DESC, handle ASC'
    const rows = ctx.db
      .prepare(
        `SELECT MAX(b.author_handle) AS handle, MAX(b.author_display_name) AS displayName, b.author_did AS did,
                count(*) AS bookmarks, MIN(b.bookmarked_at) AS firstSavedAt, MAX(b.bookmarked_at) AS lastSavedAt
         ${base} GROUP BY COALESCE(b.author_did, b.author_handle) ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...matched.params, limit, offset)
    return page(rows, total, limit, offset)
  })

  route('/api/agent/v1/tags', (_request, account, parsed) => {
    const { matched, limit, offset, sort } = aggregate(account, parsed)
    const base = `FROM bookmark_tags t JOIN bookmarks b ON b.id = t.bookmark_id WHERE b.id IN (${matched.sql})`
    const total = (ctx.db.prepare(`SELECT count(DISTINCT t.tag) AS c ${base}`).get(...matched.params) as { c: number }).c
    const order = sort === 'recent' ? 'lastSavedAt DESC' : sort === 'name' ? 'tag ASC' : 'bookmarks DESC, tag ASC'
    const rows = ctx.db
      .prepare(
        `SELECT t.tag AS tag, count(DISTINCT b.id) AS bookmarks,
                MIN(b.bookmarked_at) AS firstSavedAt, MAX(b.bookmarked_at) AS lastSavedAt
         ${base} GROUP BY t.tag ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...matched.params, limit, offset)
    return page(rows, total, limit, offset)
  })

  route('/api/agent/v1/timeline', (_request, account, parsed) => {
    const options = toSearchOptions(parsed, atUriResolver(ctx, account.did))
    const matched = ctx.search.matchedIds(account.did, options)
    const interval = (parsed.get('interval') as string | undefined) ?? 'month'
    const by = (parsed.get('by') as string | undefined) ?? 'saved'
    const column = by === 'posted' ? 'b.created_at' : 'b.bookmarked_at'
    const bucket =
      interval === 'day'
        ? `strftime('%Y-%m-%d', ${column})`
        : interval === 'week'
          ? `date(${column}, '-6 days', 'weekday 1')`
          : interval === 'year'
            ? `strftime('%Y', ${column})`
            : `strftime('%Y-%m', ${column})`
    const buckets = ctx.db
      .prepare(
        `SELECT ${bucket} AS period, count(*) AS count FROM bookmarks b
         WHERE b.id IN (${matched.sql}) AND ${column} IS NOT NULL
         GROUP BY period ORDER BY period ASC`,
      )
      .all(...matched.params) as Array<{ period: string; count: number }>
    return {
      interval,
      by,
      total: buckets.reduce((sum, b) => sum + b.count, 0),
      buckets,
    }
  })

  route('/api/agent/v1/stats', (_request, account) => computeStats(ctx.db, account.did))
}

function requireAgent(request: FastifyRequest, reply: FastifyReply): AccountRecord | null {
  if (request.account) return request.account
  if (request.badToken) {
    void reply.code(401).send({
      error: 'invalid_token',
      message: 'That token is unknown, revoked or expired.',
      hint: 'Ask the archive owner for a new agent token (Settings → Agent access).',
    })
    return null
  }
  void reply.code(401).send({
    error: 'unauthorised',
    message: 'Send an agent token as `Authorization: Bearer <token>`.',
    hint: 'The archive owner creates one under Settings → Agent access. GET /api/agent/v1 describes the API without one.',
  })
  return null
}

function sendError(reply: FastifyReply, err: AgentRequestError): FastifyReply {
  return reply.code(err.statusCode).send({
    error: err.code,
    message: err.message,
    ...(err.hint ? { hint: err.hint } : {}),
  })
}

/** `https://bsky.app/profile/{actor}/post/{rkey}`, on bsky.app or any client using its paths. */
const POST_LINK = /^https?:\/\/[^/]+\/profile\/([^/?#]+)\/post\/([A-Za-z0-9._~:-]+)\/?(?:[?#].*)?$/

function parsePostLink(ref: string): { actor: string; rkey: string } | null {
  const match = POST_LINK.exec(ref.trim())
  if (!match) return null
  return { actor: decodeURIComponent(match[1]!).toLowerCase().replace(/^@/, ''), rkey: match[2]! }
}

/** Finds the author DID for a handle among this account's own bookmarks. */
function didForHandle(ctx: AppContext, did: string, handle: string): string | null {
  const row = ctx.db
    .prepare(
      `SELECT author_did FROM bookmarks WHERE did = ? AND lower(author_handle) = ? AND author_did IS NOT NULL
       ORDER BY bookmarked_at DESC LIMIT 1`,
    )
    .get(did, handle) as { author_did: string } | undefined
  return row?.author_did ?? null
}

/** Converts an at:// URI or a post link into the AT-URI the archive stores. */
function atUriResolver(ctx: AppContext, did: string): (ref: string) => string {
  return (ref) => {
    if (ref.startsWith('at://')) return ref
    const link = parsePostLink(ref)
    if (!link) {
      throw new AgentRequestError('invalid_parameter', `Expected an at:// URI or a bsky.app post link, got \`${ref}\`.`)
    }
    const actor = link.actor.startsWith('did:') ? link.actor : didForHandle(ctx, did, link.actor)
    if (!actor) {
      throw new AgentRequestError(
        'invalid_parameter',
        `No bookmarked posts by @${link.actor}, so that link cannot be resolved.`,
        'Pass the at:// URI instead.',
      )
    }
    return `at://${actor}/app.bsky.feed.post/${link.rkey}`
  }
}

function findByRef(ctx: AppContext, did: string, ref: string): BookmarkRecord | null {
  const trimmed = ref.trim()
  if (/^\d+$/.test(trimmed)) return ctx.bookmarks.getById(did, Number.parseInt(trimmed, 10))
  if (trimmed.startsWith('at://')) return ctx.bookmarks.getByUri(did, trimmed)

  const link = parsePostLink(trimmed)
  if (!link) {
    throw new AgentRequestError(
      'invalid_parameter',
      `\`ref\` must be a bookmark id, an at:// URI or a bsky.app post link, got \`${ref}\`.`,
    )
  }
  if (link.actor.startsWith('did:')) {
    return ctx.bookmarks.getByUri(did, `at://${link.actor}/app.bsky.feed.post/${link.rkey}`)
  }
  // Handles are matched against the archive itself, so no network lookup.
  const suffix = `/app.bsky.feed.post/${link.rkey}`
  const row = ctx.db
    .prepare('SELECT * FROM bookmarks WHERE did = ? AND lower(author_handle) = ? AND substr(uri, ?) = ? LIMIT 1')
    .get(did, link.actor, -suffix.length, suffix) as BookmarkRow | undefined
  return row ? ctx.bookmarks.hydrate(row) : null
}
