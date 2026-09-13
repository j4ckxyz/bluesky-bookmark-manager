import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.ts'
import { EXPORT_FORMATS, exportFilename, renderExport, type ExportFormat } from '../export.ts'
import type { SearchOptions, SortOrder, StatusFilter } from '../search/search.ts'
import { computeStats } from '../stats.ts'
import { requireAccount } from './auth-plugin.ts'

type SearchQuery = {
  q?: string
  limit?: string
  offset?: string
  sort?: string
  status?: string
  facets?: string
  from?: string | string[]
  mentions?: string | string[]
  domain?: string | string[]
  tag?: string | string[]
  lang?: string | string[]
  has?: string | string[]
  is?: string | string[]
  before?: string
  after?: string
}

const SORTS: SortOrder[] = [
  'relevance',
  'saved',
  'oldest-saved',
  'posted',
  'oldest-posted',
  'likes',
  'reposts',
]

const asList = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
}

const asInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const isTruthy = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', ''].includes(value.toLowerCase())

/** Maps query-string parameters onto {@link SearchOptions}. */
function toSearchOptions(query: SearchQuery, defaults: Partial<SearchOptions> = {}): SearchOptions {
  const sortParam = query.sort as SortOrder | undefined
  const statusParam = query.status as StatusFilter | undefined

  const filters: NonNullable<SearchOptions['filters']> = {
    from: asList(query.from),
    mentions: asList(query.mentions),
    domains: asList(query.domain),
    tags: asList(query.tag),
    langs: asList(query.lang),
    has: asList(query.has),
    is: asList(query.is),
    before: query.before ?? null,
    after: query.after ?? null,
  }

  return {
    q: query.q ?? '',
    limit: asInt(query.limit, defaults.limit ?? 25),
    offset: asInt(query.offset, 0),
    ...(sortParam && SORTS.includes(sortParam) ? { sort: sortParam } : {}),
    status:
      statusParam && ['active', 'removed', 'all'].includes(statusParam) ? statusParam : 'active',
    filters,
    withFacets: isTruthy(query.facets),
  }
}

export function registerBookmarkRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: SearchQuery }>('/api/v1/search', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    return ctx.search.search(account.did, toSearchOptions(request.query))
  })

  /** Same engine as /search; a friendlier name for plain listing. */
  app.get<{ Querystring: SearchQuery }>('/api/v1/bookmarks', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    return ctx.search.search(account.did, toSearchOptions(request.query, { limit: 50 }))
  })

  app.get<{ Params: { id: string } }>('/api/v1/bookmarks/:id', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return

    const id = Number.parseInt(request.params.id, 10)
    const bookmark = Number.isFinite(id)
      ? ctx.bookmarks.getById(account.did, id)
      : ctx.bookmarks.getByUri(account.did, decodeURIComponent(request.params.id))

    if (!bookmark) {
      return reply.code(404).send({ error: 'not_found', message: 'No such bookmark.' })
    }
    return bookmark
  })

  app.get('/api/v1/stats', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    return {
      ...computeStats(ctx.db, account.did),
      sync: ctx.engine.status(account.did),
    }
  })

  /**
   * Autocomplete for the search box: authors, tags and domains already
   * present in the archive.
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/v1/suggest',
    async (request, reply) => {
      const account = requireAccount(request, reply)
      if (!account) return

      const q = (request.query.q ?? '').trim().toLowerCase().replace(/^[@#]/, '')
      const limit = Math.min(20, asInt(request.query.limit, 8))
      if (!q) return { authors: [], tags: [], domains: [] }

      const like = `%${q}%`
      const prefix = `${q}%`

      const authors = ctx.db
        .prepare(
          `SELECT author_handle AS value, MIN(author_display_name) AS label, count(*) AS count
           FROM bookmarks
           WHERE did = ? AND status = 'active' AND author_handle IS NOT NULL
             AND (author_handle LIKE ? OR lower(COALESCE(author_display_name, '')) LIKE ?)
           GROUP BY author_handle
           ORDER BY (author_handle LIKE ?) DESC, count DESC LIMIT ?`,
        )
        .all(account.did, like, like, prefix, limit)

      const tags = ctx.db
        .prepare(
          `SELECT t.tag AS value, count(*) AS count
           FROM bookmark_tags t JOIN bookmarks b ON b.id = t.bookmark_id
           WHERE b.did = ? AND b.status = 'active' AND t.tag LIKE ?
           GROUP BY t.tag ORDER BY (t.tag LIKE ?) DESC, count DESC LIMIT ?`,
        )
        .all(account.did, like, prefix, limit)

      const domains = ctx.db
        .prepare(
          `SELECT l.domain AS value, count(DISTINCT b.id) AS count
           FROM bookmark_links l JOIN bookmarks b ON b.id = l.bookmark_id
           WHERE b.did = ? AND b.status = 'active' AND l.domain LIKE ?
           GROUP BY l.domain ORDER BY (l.domain LIKE ?) DESC, count DESC LIMIT ?`,
        )
        .all(account.did, like, prefix, limit)

      return { authors, tags, domains }
    },
  )

  app.get('/api/v1/export/formats', async () => ({
    formats: Object.entries(EXPORT_FORMATS).map(([id, meta]) => ({
      id,
      label: meta.label,
      extension: meta.extension,
      contentType: meta.contentType,
    })),
  }))

  /**
   * Exports the current selection. Accepts the same filters as /search, so
   * "export what I am looking at" works without a second concept.
   */
  app.get<{ Querystring: SearchQuery & { format?: string } }>(
    '/api/v1/export',
    async (request, reply) => {
      const account = requireAccount(request, reply)
      if (!account) return

      const format = (request.query.format ?? 'html').toLowerCase() as ExportFormat
      if (!(format in EXPORT_FORMATS)) {
        return reply.code(400).send({
          error: 'bad_request',
          message: `Unknown format. Choose one of: ${Object.keys(EXPORT_FORMATS).join(', ')}.`,
        })
      }

      // Page through everything that matches rather than capping at a page.
      const options = toSearchOptions(request.query, { limit: 500 })
      const all = []
      let offset = 0
      for (;;) {
        const page = ctx.search.search(account.did, { ...options, limit: 500, offset, withFacets: false })
        all.push(...page.results)
        offset += page.results.length
        if (page.results.length === 0 || offset >= page.total) break
      }

      const body = renderExport(format, all, account.handle)
      const meta = EXPORT_FORMATS[format]

      return reply
        .header('content-type', meta.contentType)
        .header(
          'content-disposition',
          `attachment; filename="${exportFilename(format, account.handle)}"`,
        )
        .header('x-bookmark-count', String(all.length))
        .send(body)
    },
  )
}
