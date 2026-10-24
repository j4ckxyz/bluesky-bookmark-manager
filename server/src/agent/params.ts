import { damerauLevenshtein } from '../lib/fuzzy.ts'
import { canonicalHas, HAS_FLAGS, normaliseDomain, parseDate } from '../search/query.ts'
import type { SearchOptions, SortOrder, StatusFilter } from '../search/search.ts'

/**
 * Parameter parsing for the agent API.
 *
 * Unlike the browser API, which quietly ignores anything it does not
 * understand, this surface is strict: an unknown parameter, a bad date or an
 * out-of-range number is a 400 that says exactly what to fix. An agent that
 * typos `autor=` should hear about it, not get every bookmark back.
 */

export class AgentRequestError extends Error {
  override name = 'AgentRequestError'
  readonly statusCode: number
  readonly code: string
  readonly hint: string | undefined

  constructor(code: string, message: string, hint?: string, statusCode = 400) {
    super(message)
    this.code = code
    this.hint = hint
    this.statusCode = statusCode
  }
}

export type ParamKind = 'text' | 'list' | 'repeat' | 'int' | 'date' | 'enum' | 'bool'

export type ParamSpec = {
  name: string
  kind: ParamKind
  description: string
  example?: string
  values?: readonly string[]
  default?: string
  min?: number
  max?: number
  /** Other names accepted for the same parameter. */
  aliases?: readonly string[]
}

export type RawQuery = Record<string, string | string[] | undefined>

/** Most values a list parameter takes, so one request cannot build a huge query. */
const MAX_LIST_VALUES = 50
const MAX_IDS = 200
const MAX_VALUE_LENGTH = 500

export const HAS_VALUES = [
  'link',
  'image',
  'video',
  'media',
  'alt',
  'quote',
  'tag',
  'mention',
  'labels',
  'text',
] as const

export const IS_VALUES = ['reply', 'root', 'quote', 'verified', 'selfreply', 'deleted', 'blocked'] as const

export const SORT_VALUES = [
  'relevance',
  'saved',
  'oldest-saved',
  'posted',
  'oldest-posted',
  'likes',
  'reposts',
  'replies',
  'random',
] as const satisfies readonly SortOrder[]

export const DATE_FORMATS =
  '2026, 2026-03, 2026-03-14, a full ISO timestamp, today, yesterday, or a relative age such as 12h, 7d, 2w, 3mo, 1y'

/** Every filter. All endpoints that select bookmarks accept all of these. */
export const FILTER_PARAMS: ParamSpec[] = [
  {
    name: 'q',
    kind: 'text',
    description:
      'Full-text search with typo tolerance and prefix matching, plus the inline query language (`"exact phrase"`, `-exclude`, `from:`, `domain:`, `#tag`, `has:`, `is:`, `before:`, `after:` …). Combined with every other parameter using AND.',
    example: 'q=decentralised moderation',
  },
  {
    name: 'author',
    kind: 'list',
    aliases: ['from'],
    description: 'Posted by any of these accounts. Handles or DIDs; a leading @ is fine.',
    example: 'author=alice.bsky.social,did:plc:abc123',
  },
  {
    name: 'exclude_author',
    kind: 'list',
    description: 'Not posted by any of these accounts.',
    example: 'exclude_author=bot.example.com',
  },
  {
    name: 'mentions',
    kind: 'list',
    description: 'Mentions any of these accounts.',
    example: 'mentions=bob.bsky.social',
  },
  {
    name: 'domain',
    kind: 'list',
    description:
      'Links to any of these sites. Subdomains match too (`bbc.co.uk` matches `news.bbc.co.uk`). A full URL is reduced to its host.',
    example: 'domain=github.com,gitlab.com',
  },
  {
    name: 'exclude_domain',
    kind: 'list',
    description: 'Has no link to any of these sites (or their subdomains).',
    example: 'exclude_domain=youtube.com',
  },
  {
    name: 'url',
    kind: 'repeat',
    description:
      'Links to this exact page. Scheme, `www.`, a trailing slash, `#fragment` and tracking parameters (utm_*, fbclid, …) are ignored when comparing. Repeat the parameter to match any of several pages.',
    example: 'url=https://atproto.com/guides/overview',
  },
  {
    name: 'url_contains',
    kind: 'repeat',
    description:
      'Has a link whose URL contains this text (case-insensitive). Good for a path prefix or a repository. Repeat to match any of several.',
    example: 'url_contains=github.com/bluesky-social',
  },
  {
    name: 'text_contains',
    kind: 'repeat',
    description:
      'Post text contains this literal string (case-insensitive, no stemming or fuzzing). Use it for things word search cannot see, such as `C++` or `e.g.`. Repeat to require several.',
    example: 'text_contains=C%2B%2B',
  },
  { name: 'tag', kind: 'list', description: 'Has any of these hashtags (no #).', example: 'tag=atproto,bluesky' },
  { name: 'exclude_tag', kind: 'list', description: 'Has none of these hashtags.', example: 'exclude_tag=nsfw' },
  { name: 'lang', kind: 'list', description: 'Written in any of these languages (BCP-47 codes).', example: 'lang=en,de' },
  {
    name: 'has',
    kind: 'list',
    values: HAS_VALUES,
    description: 'Has every one of these features.',
    example: 'has=link,image',
  },
  {
    name: 'has_not',
    kind: 'list',
    values: HAS_VALUES,
    description: 'Has none of these features.',
    example: 'has_not=video',
  },
  {
    name: 'is',
    kind: 'list',
    values: IS_VALUES,
    description:
      'Is every one of these. `selfreply` = part of the author\'s own thread; `deleted`/`blocked` = the post is gone or hidden upstream but the archived copy remains.',
    example: 'is=reply',
  },
  { name: 'is_not', kind: 'list', values: IS_VALUES, description: 'Is none of these.', example: 'is_not=reply' },
  {
    name: 'posted_after',
    kind: 'date',
    aliases: ['after'],
    description: `Post was written on or after this. Accepts ${DATE_FORMATS}.`,
    example: 'posted_after=2026-01',
  },
  {
    name: 'posted_before',
    kind: 'date',
    aliases: ['before'],
    description: 'Post was written on or before this. A bare year, month or day covers the whole of it.',
    example: 'posted_before=2026-03-31',
  },
  {
    name: 'saved_after',
    kind: 'date',
    description: 'You bookmarked it on or after this.',
    example: 'saved_after=7d',
  },
  {
    name: 'saved_before',
    kind: 'date',
    description: 'You bookmarked it on or before this.',
    example: 'saved_before=2025',
  },
  { name: 'min_likes', kind: 'int', min: 0, description: 'At least this many likes.', example: 'min_likes=100' },
  { name: 'max_likes', kind: 'int', min: 0, description: 'At most this many likes.', example: 'max_likes=5' },
  { name: 'min_reposts', kind: 'int', min: 0, description: 'At least this many reposts.' },
  { name: 'min_replies', kind: 'int', min: 0, description: 'At least this many replies.' },
  { name: 'min_quotes', kind: 'int', min: 0, description: 'At least this many quote posts.' },
  { name: 'min_words', kind: 'int', min: 0, description: 'Post text has at least this many words.', example: 'min_words=50' },
  { name: 'max_words', kind: 'int', min: 0, description: 'Post text has at most this many words.' },
  {
    name: 'ids',
    kind: 'list',
    description: `Only these bookmark ids (up to ${MAX_IDS}). Handy for re-reading a set you found earlier.`,
    example: 'ids=12,40,41',
  },
  {
    name: 'thread',
    kind: 'repeat',
    description:
      'Bookmarks in the thread rooted at this post (the root itself included). Takes an at:// URI or a bsky.app post link.',
    example: 'thread=at://did:plc:abc/app.bsky.feed.post/3k2a',
  },
  {
    name: 'quoting',
    kind: 'repeat',
    description: 'Bookmarks that quote this post. Takes an at:// URI or a bsky.app post link.',
  },
  {
    name: 'status',
    kind: 'enum',
    values: ['active', 'removed', 'all'],
    default: 'active',
    description:
      '`active` = currently bookmarked. `removed` = you un-bookmarked it on Bluesky but the archive kept a copy. `all` = both.',
  },
]

export const LIST_PARAMS: ParamSpec[] = [
  {
    name: 'sort',
    kind: 'enum',
    values: SORT_VALUES,
    description:
      'Defaults to `relevance` when there are search words, otherwise `saved` (newest bookmark first). `random` gives a fresh sample on every call, so do not page through it.',
  },
  { name: 'limit', kind: 'int', min: 1, max: 100, default: '20', description: 'Results per page.' },
  { name: 'offset', kind: 'int', min: 0, default: '0', description: 'Skip this many results. Use `nextOffset` from the previous page.' },
  {
    name: 'view',
    kind: 'enum',
    values: ['compact', 'full'],
    default: 'compact',
    description: '`compact` is a tidy, agent-friendly shape. `full` is every stored field.',
  },
  {
    name: 'fields',
    kind: 'list',
    description:
      'Return only these fields of the compact view, to save tokens. `id` is always included.',
    example: 'fields=url,text,savedAt',
  },
  {
    name: 'facets',
    kind: 'bool',
    default: 'false',
    description: 'Also return counts of the top authors, domains, tags, languages and features across all matches.',
  },
]

export const AGGREGATE_PARAMS: ParamSpec[] = [
  { name: 'limit', kind: 'int', min: 1, max: 500, default: '50', description: 'Rows per page.' },
  { name: 'offset', kind: 'int', min: 0, default: '0', description: 'Skip this many rows.' },
  {
    name: 'sort',
    kind: 'enum',
    values: ['count', 'recent', 'name'],
    default: 'count',
    description: '`count` = most bookmarks first, `recent` = most recently saved first, `name` = alphabetical.',
  },
]

export const TIMELINE_PARAMS: ParamSpec[] = [
  {
    name: 'interval',
    kind: 'enum',
    values: ['day', 'week', 'month', 'year'],
    default: 'month',
    description: 'Bucket size. Weeks start on Monday and are labelled by that Monday.',
  },
  {
    name: 'by',
    kind: 'enum',
    values: ['saved', 'posted'],
    default: 'saved',
    description: 'Bucket by when you bookmarked it, or when it was posted.',
  },
]

export const VIEW_PARAMS: ParamSpec[] = [
  { name: 'view', kind: 'enum', values: ['compact', 'full'], default: 'compact', description: 'Response shape.' },
]

export const LOOKUP_PARAMS: ParamSpec[] = [
  {
    name: 'ref',
    kind: 'text',
    description: 'A bookmark id, an at:// post URI, or a https://bsky.app/profile/…/post/… link.',
    example: 'ref=https://bsky.app/profile/alice.bsky.social/post/3k2a',
  },
  ...VIEW_PARAMS,
]

export type Parsed = Map<string, string | string[] | number | boolean>

/**
 * Validates a query string against the given specs. Throws
 * {@link AgentRequestError} on anything it cannot use.
 */
export function parseParams(raw: RawQuery, specs: ParamSpec[]): Parsed {
  const byName = new Map<string, ParamSpec>()
  for (const spec of specs) {
    byName.set(spec.name, spec)
    for (const alias of spec.aliases ?? []) byName.set(alias, spec)
  }

  const out: Parsed = new Map()
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const spec = byName.get(key)
    if (!spec) {
      const suggestion = closest(key, [...byName.keys()])
      throw new AgentRequestError(
        'unknown_parameter',
        `Unknown parameter \`${key}\`.${suggestion ? ` Did you mean \`${suggestion}\`?` : ''}`,
        `This endpoint accepts: ${specs.map((s) => s.name).join(', ')}.`,
      )
    }
    const values = (Array.isArray(value) ? value : [value]).map((v) => v.trim())
    if (values.some((v) => v.length > MAX_VALUE_LENGTH)) {
      throw new AgentRequestError('invalid_parameter', `\`${key}\` is longer than ${MAX_VALUE_LENGTH} characters.`)
    }
    const parsed = parseOne(spec, values)
    if (parsed === null) continue

    const existing = out.get(spec.name)
    if (Array.isArray(existing) && Array.isArray(parsed)) out.set(spec.name, [...existing, ...parsed])
    else out.set(spec.name, parsed)
  }
  return out
}

function parseOne(spec: ParamSpec, values: string[]): string | string[] | number | boolean | null {
  const last = values[values.length - 1] ?? ''
  switch (spec.kind) {
    case 'text':
      return last
    case 'repeat':
    case 'list': {
      const items =
        spec.kind === 'list'
          ? values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
          : values.filter(Boolean)
      if (items.length > MAX_LIST_VALUES) {
        throw new AgentRequestError('invalid_parameter', `\`${spec.name}\` takes at most ${MAX_LIST_VALUES} values.`)
      }
      if (spec.values) {
        const allowed = spec.values
        const normalised = items.map((v) => normaliseFlag(spec, v.toLowerCase()))
        const bad = normalised.filter((v) => !allowed.includes(v))
        if (bad.length > 0) {
          throw new AgentRequestError(
            'invalid_parameter',
            `\`${spec.name}\` does not accept ${bad.map((b) => `\`${b}\``).join(', ')}.`,
            `Valid values: ${allowed.join(', ')}.${bad.some((b) => b === 'removed' || b === 'active') ? ' To see un-bookmarked posts use status=removed.' : ''}`,
          )
        }
        return normalised
      }
      return items
    }
    case 'int': {
      if (!/^\d+$/.test(last)) {
        throw new AgentRequestError('invalid_parameter', `\`${spec.name}\` must be a whole number, got \`${last}\`.`)
      }
      const n = Number.parseInt(last, 10)
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        throw new AgentRequestError(
          'invalid_parameter',
          `\`${spec.name}\` must be between ${spec.min ?? 0} and ${spec.max ?? '∞'}, got ${n}.`,
        )
      }
      return n
    }
    case 'bool': {
      const v = last.toLowerCase()
      if (['', '1', 'true', 'yes'].includes(v)) return true
      if (['0', 'false', 'no'].includes(v)) return false
      throw new AgentRequestError('invalid_parameter', `\`${spec.name}\` must be true or false, got \`${last}\`.`)
    }
    case 'enum': {
      const v = last.toLowerCase()
      if (!v) return null
      if (!spec.values?.includes(v)) {
        throw new AgentRequestError(
          'invalid_parameter',
          `\`${spec.name}\` does not accept \`${last}\`.`,
          `Valid values: ${spec.values?.join(', ')}.`,
        )
      }
      return v
    }
    case 'date': {
      if (!last) return null
      const end = spec.name.endsWith('before')
      const date = parseAgentDate(last, end)
      if (!date) {
        throw new AgentRequestError(
          'invalid_parameter',
          `\`${spec.name}\` is not a date I understand: \`${last}\`.`,
          `Use ${DATE_FORMATS}.`,
        )
      }
      return date
    }
  }
}

/** Accepts the plural spellings people reach for (`has=links`). */
function normaliseFlag(spec: ParamSpec, value: string): string {
  if (spec.name === 'has' || spec.name === 'has_not') {
    return (HAS_FLAGS as readonly string[]).includes(value) ? canonicalHas(value) : value
  }
  if ((spec.name === 'is' || spec.name === 'is_not') && value === 'thread') return 'selfreply'
  return value
}

const RELATIVE = /^(\d{1,5})\s*(h|d|w|mo|y)$/

/**
 * Everything {@link parseDate} accepts, plus `today`, `yesterday` and
 * relative ages (`7d` = seven days ago). All dates are UTC.
 */
export function parseAgentDate(value: string, endOfRange: boolean, now = new Date()): string | null {
  const v = value.trim().toLowerCase()

  if (v === 'today' || v === 'yesterday' || v === 'now') {
    if (v === 'now') return now.toISOString()
    const offset = v === 'yesterday' ? 1 : 0
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)
    return new Date(endOfRange ? start + 86_400_000 - 1 : start).toISOString()
  }

  const relative = RELATIVE.exec(v)
  if (relative) {
    const amount = Number.parseInt(relative[1]!, 10)
    const at = new Date(now)
    switch (relative[2]) {
      case 'h':
        at.setTime(at.getTime() - amount * 3_600_000)
        break
      case 'd':
        at.setTime(at.getTime() - amount * 86_400_000)
        break
      case 'w':
        at.setTime(at.getTime() - amount * 7 * 86_400_000)
        break
      case 'mo':
        at.setUTCMonth(at.getUTCMonth() - amount)
        break
      case 'y':
        at.setUTCFullYear(at.getUTCFullYear() - amount)
        break
    }
    return at.toISOString()
  }

  // `new Date()` accepts all sorts of nonsense ("5", "march"); insist on a year.
  if (!/^\d{4}(-\d{2}(-\d{2}([t ][\d:.]+(z|[+-]\d{2}:?\d{2})?)?)?)?$/.test(v)) return null
  return parseDate(value, endOfRange)
}

const list = (parsed: Parsed, name: string): string[] => {
  const v = parsed.get(name)
  return Array.isArray(v) ? v : []
}
const num = (parsed: Parsed, name: string): number | null => {
  const v = parsed.get(name)
  return typeof v === 'number' ? v : null
}
const str = (parsed: Parsed, name: string): string | null => {
  const v = parsed.get(name)
  return typeof v === 'string' ? v : null
}

/**
 * Turns validated filter parameters into search options. `toAtUri` converts
 * a bsky.app link into the AT-URI stored in the archive.
 */
export function toSearchOptions(parsed: Parsed, toAtUri: (ref: string) => string): SearchOptions {
  const ids = list(parsed, 'ids').map((id) => {
    if (!/^\d+$/.test(id)) {
      throw new AgentRequestError('invalid_parameter', `\`ids\` must be numeric bookmark ids, got \`${id}\`.`)
    }
    return Number.parseInt(id, 10)
  })
  if (ids.length > MAX_IDS) {
    throw new AgentRequestError('invalid_parameter', `\`ids\` takes at most ${MAX_IDS} ids.`)
  }

  const domains = (name: string) => list(parsed, name).map(normaliseDomain).filter(Boolean)

  return {
    q: str(parsed, 'q') ?? '',
    status: (str(parsed, 'status') as StatusFilter | null) ?? 'active',
    filters: {
      from: list(parsed, 'author'),
      notFrom: list(parsed, 'exclude_author'),
      mentions: list(parsed, 'mentions'),
      anyDomains: domains('domain'),
      notDomains: domains('exclude_domain'),
      urls: list(parsed, 'url'),
      urlContains: list(parsed, 'url_contains'),
      textContains: list(parsed, 'text_contains'),
      tags: list(parsed, 'tag'),
      notTags: list(parsed, 'exclude_tag').map((t) => t.toLowerCase().replace(/^#/, '')),
      langs: list(parsed, 'lang'),
      has: list(parsed, 'has'),
      notHas: list(parsed, 'has_not'),
      is: list(parsed, 'is'),
      notIs: list(parsed, 'is_not'),
      after: str(parsed, 'posted_after'),
      before: str(parsed, 'posted_before'),
      savedAfter: str(parsed, 'saved_after'),
      savedBefore: str(parsed, 'saved_before'),
      minLikes: num(parsed, 'min_likes'),
      maxLikes: num(parsed, 'max_likes'),
      minReposts: num(parsed, 'min_reposts'),
      minReplies: num(parsed, 'min_replies'),
      minQuotes: num(parsed, 'min_quotes'),
      minWords: num(parsed, 'min_words'),
      maxWords: num(parsed, 'max_words'),
      ids,
      threads: list(parsed, 'thread').map(toAtUri),
      quoting: list(parsed, 'quoting').map(toAtUri),
    },
  }
}

/** The nearest known name, for "did you mean" hints. */
function closest(input: string, candidates: string[]): string | null {
  let best: string | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const score = damerauLevenshtein(input.toLowerCase(), candidate)
    if (score < bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : null
}

