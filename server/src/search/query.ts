/**
 * The search query language.
 *
 *   atproto firehose            fuzzy, ranked word search
 *   "exact phrase"              phrase match, no fuzzing
 *   from:@alice.bsky.social     posted by
 *   mentions:@bob  /  @bob      mentions an account
 *   domain:github.com           links to a domain
 *   tag:atproto  /  #atproto    hashtag
 *   lang:en                     post language
 *   has:link|image|video|media|alt|quote|tag|labels
 *   is:reply|root|quote|verified|removed|selfreply|deleted|blocked
 *   before:2026-01-01 after:2025-06-01     when it was posted
 *   saved-before: / saved-after:           when it was bookmarked
 *   -term / -from:x                        negation
 */

export type TextTerm = {
  /** Lower-cased, punctuation-stripped term used against the FTS index. */
  value: string
  /** Quoted terms are matched exactly, never fuzzed or prefix-expanded. */
  exact: boolean
  /** A multi-word quoted phrase. */
  phrase: boolean
  negated: boolean
}

export type ParsedQuery = {
  terms: TextTerm[]
  from: string[]
  notFrom: string[]
  mentions: string[]
  domains: string[]
  tags: string[]
  langs: string[]
  has: string[]
  notHas: string[]
  is: string[]
  notIs: string[]
  before: string | null
  after: string | null
  savedBefore: string | null
  savedAfter: string | null
  /** Everything that was not a filter, for display and highlighting. */
  freeText: string
}

export const HAS_FLAGS = [
  'link',
  'links',
  'image',
  'images',
  'video',
  'media',
  'alt',
  'quote',
  'tag',
  'tags',
  'mention',
  'mentions',
  'labels',
  'text',
] as const

export const IS_FLAGS = [
  'reply',
  'root',
  'quote',
  'verified',
  'removed',
  'active',
  'selfreply',
  'deleted',
  'blocked',
  'thread',
] as const

const FIELD_ALIASES: Record<string, string> = {
  from: 'from',
  author: 'from',
  by: 'from',
  mentions: 'mentions',
  mention: 'mentions',
  to: 'mentions',
  domain: 'domain',
  site: 'domain',
  host: 'domain',
  url: 'domain',
  tag: 'tag',
  hashtag: 'tag',
  lang: 'lang',
  language: 'lang',
  has: 'has',
  is: 'is',
  before: 'before',
  until: 'before',
  after: 'after',
  since: 'after',
  'saved-before': 'savedBefore',
  savedbefore: 'savedBefore',
  'saved-after': 'savedAfter',
  savedafter: 'savedAfter',
}

type Token = { text: string; quoted: boolean; negated: boolean }

/** Splits on whitespace while keeping quoted runs together. */
export function tokenise(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index++
    if (index >= input.length) break

    let negated = false
    if (input[index] === '-' && index + 1 < input.length && !/\s/.test(input[index + 1]!)) {
      negated = true
      index++
    }

    // A field prefix stays attached to the quotes that follow it, so
    // `from:"Alice Smith"` parses as one token.
    let prefix = ''
    const fieldMatch = /^([a-z-]+):/i.exec(input.slice(index))
    if (fieldMatch && input[index + fieldMatch[0].length] === '"') {
      prefix = fieldMatch[0]
      index += prefix.length
    }

    if (input[index] === '"') {
      const end = input.indexOf('"', index + 1)
      if (end === -1) {
        tokens.push({ text: prefix + input.slice(index + 1), quoted: true, negated })
        break
      }
      tokens.push({ text: prefix + input.slice(index + 1, end), quoted: true, negated })
      index = end + 1
      continue
    }

    let end = index
    while (end < input.length && !/\s/.test(input[end]!)) end++
    tokens.push({ text: input.slice(index, end), quoted: false, negated })
    index = end
  }

  return tokens
}

/** Strips punctuation that FTS5's unicode61 tokeniser would drop anyway. */
export function normaliseTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const cleanHandle = (value: string): string => value.trim().toLowerCase().replace(/^@/, '')

/** Accepts `2026`, `2026-03` and `2026-03-14`, expanding to a full instant. */
export function parseDate(value: string, endOfRange: boolean): string | null {
  const trimmed = value.trim()
  if (/^\d{4}$/.test(trimmed)) {
    return endOfRange ? `${trimmed}-12-31T23:59:59.999Z` : `${trimmed}-01-01T00:00:00.000Z`
  }
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    if (!endOfRange) return `${trimmed}-01T00:00:00.000Z`
    const [year, month] = trimmed.split('-').map(Number) as [number, number]
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return `${trimmed}-${String(lastDay).padStart(2, '0')}T23:59:59.999Z`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return endOfRange ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function parseQuery(input: string): ParsedQuery {
  const query: ParsedQuery = {
    terms: [],
    from: [],
    notFrom: [],
    mentions: [],
    domains: [],
    tags: [],
    langs: [],
    has: [],
    notHas: [],
    is: [],
    notIs: [],
    before: null,
    after: null,
    savedBefore: null,
    savedAfter: null,
    freeText: '',
  }

  const freeParts: string[] = []

  for (const token of tokenise(input ?? '')) {
    const colon = token.text.indexOf(':')
    const rawField = colon > 0 ? token.text.slice(0, colon).toLowerCase() : ''
    const field = FIELD_ALIASES[rawField]

    if (field && colon > 0) {
      const value = token.text.slice(colon + 1)
      if (value.length === 0) continue
      applyField(query, field, value, token.negated)
      continue
    }

    // Bare `@handle` and `#tag` are shorthands people type without thinking.
    if (!token.quoted && /^@[^\s]+$/.test(token.text)) {
      const handle = cleanHandle(token.text)
      if (handle) query.mentions.push(handle)
      continue
    }
    if (!token.quoted && /^#[^\s]+$/.test(token.text)) {
      const tag = token.text.slice(1).toLowerCase()
      if (tag) query.tags.push(tag)
      continue
    }

    const normalised = normaliseTerm(token.text)
    if (!normalised) continue

    if (token.quoted) {
      query.terms.push({
        value: normalised,
        exact: true,
        phrase: normalised.includes(' '),
        negated: token.negated,
      })
      if (!token.negated) freeParts.push(normalised)
      continue
    }

    // An unquoted token can still contain several words after normalisation.
    for (const word of normalised.split(' ')) {
      if (!word) continue
      query.terms.push({ value: word, exact: false, phrase: false, negated: token.negated })
      if (!token.negated) freeParts.push(word)
    }
  }

  query.freeText = freeParts.join(' ')
  return query
}

function applyField(query: ParsedQuery, field: string, rawValue: string, negated: boolean): void {
  const value = rawValue.trim()
  if (!value) return

  switch (field) {
    case 'from': {
      const handle = cleanHandle(value)
      if (handle) (negated ? query.notFrom : query.from).push(handle)
      return
    }
    case 'mentions': {
      const handle = cleanHandle(value)
      if (handle) query.mentions.push(handle)
      return
    }
    case 'domain': {
      query.domains.push(normaliseDomain(value))
      return
    }
    case 'tag': {
      query.tags.push(value.toLowerCase().replace(/^#/, ''))
      return
    }
    case 'lang': {
      query.langs.push(value.toLowerCase())
      return
    }
    case 'has': {
      const flag = value.toLowerCase()
      if ((HAS_FLAGS as readonly string[]).includes(flag)) {
        ;(negated ? query.notHas : query.has).push(canonicalHas(flag))
      }
      return
    }
    case 'is': {
      const flag = value.toLowerCase()
      if ((IS_FLAGS as readonly string[]).includes(flag)) {
        ;(negated ? query.notIs : query.is).push(flag)
      }
      return
    }
    case 'before':
      query.before = parseDate(value, true)
      return
    case 'after':
      query.after = parseDate(value, false)
      return
    case 'savedBefore':
      query.savedBefore = parseDate(value, true)
      return
    case 'savedAfter':
      query.savedAfter = parseDate(value, false)
      return
    default:
      return
  }
}

/** Collapses plural aliases so `has:links` and `has:link` behave the same. */
export function canonicalHas(flag: string): string {
  switch (flag) {
    case 'links':
      return 'link'
    case 'images':
      return 'image'
    case 'tags':
      return 'tag'
    case 'mentions':
      return 'mention'
    default:
      return flag
  }
}

/** `https://www.github.com/x` and `GitHub.com` both mean `github.com`. */
export function normaliseDomain(value: string): string {
  let host = value.trim().toLowerCase()
  host = host.replace(/^[a-z]+:\/\//, '')
  const slash = host.indexOf('/')
  if (slash !== -1) host = host.slice(0, slash)
  if (host.startsWith('www.')) host = host.slice(4)
  return host
}

/** True when the query has nothing to narrow by, so we can list everything. */
export function isEmptyQuery(query: ParsedQuery): boolean {
  return (
    query.terms.length === 0 &&
    query.from.length === 0 &&
    query.notFrom.length === 0 &&
    query.mentions.length === 0 &&
    query.domains.length === 0 &&
    query.tags.length === 0 &&
    query.langs.length === 0 &&
    query.has.length === 0 &&
    query.notHas.length === 0 &&
    query.is.length === 0 &&
    query.notIs.length === 0 &&
    !query.before &&
    !query.after &&
    !query.savedBefore &&
    !query.savedAfter
  )
}
