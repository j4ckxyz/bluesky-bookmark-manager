import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normaliseDomain, parseDate, parseQuery, tokenise } from '../src/search/query.ts'

describe('query tokeniser', () => {
  it('keeps quoted runs together', () => {
    assert.deepEqual(
      tokenise('one "two three" four').map((t) => t.text),
      ['one', 'two three', 'four'],
    )
  })

  it('marks negated tokens', () => {
    const tokens = tokenise('keep -drop')
    assert.equal(tokens[0]?.negated, false)
    assert.equal(tokens[1]?.negated, true)
    assert.equal(tokens[1]?.text, 'drop')
  })

  it('keeps a field prefix attached to its quoted value', () => {
    assert.deepEqual(
      tokenise('from:"Alice Smith"').map((t) => t.text),
      ['from:Alice Smith'],
    )
  })

  it('tolerates an unclosed quote', () => {
    assert.deepEqual(
      tokenise('hello "unterminated').map((t) => t.text),
      ['hello', 'unterminated'],
    )
  })

  it('does not treat a bare hyphen as negation', () => {
    assert.deepEqual(
      tokenise('a - b').map((t) => t.text),
      ['a', '-', 'b'],
    )
  })
})

describe('query parser', () => {
  it('treats unquoted words as fuzzy terms', () => {
    const q = parseQuery('atproto firehose')
    assert.equal(q.terms.length, 2)
    assert.ok(q.terms.every((t) => !t.exact))
    assert.equal(q.freeText, 'atproto firehose')
  })

  it('treats quoted text as an exact phrase', () => {
    const q = parseQuery('"decentralised social"')
    assert.equal(q.terms.length, 1)
    assert.equal(q.terms[0]?.exact, true)
    assert.equal(q.terms[0]?.phrase, true)
    assert.equal(q.terms[0]?.value, 'decentralised social')
  })

  it('mixes exact phrases with fuzzy words', () => {
    const q = parseQuery('"at protocol" adoption')
    assert.deepEqual(
      q.terms.map((t) => [t.value, t.exact]),
      [
        ['at protocol', true],
        ['adoption', false],
      ],
    )
  })

  it('parses author filters and their aliases', () => {
    assert.deepEqual(parseQuery('from:@alice.bsky.social').from, ['alice.bsky.social'])
    assert.deepEqual(parseQuery('author:alice.bsky.social').from, ['alice.bsky.social'])
    assert.deepEqual(parseQuery('by:@Alice.BSKY.social').from, ['alice.bsky.social'])
  })

  it('parses negated author filters', () => {
    const q = parseQuery('-from:@spam.bsky.social kittens')
    assert.deepEqual(q.notFrom, ['spam.bsky.social'])
    assert.deepEqual(q.from, [])
    assert.equal(q.terms.length, 1)
  })

  it('treats a bare @handle as a mention filter', () => {
    assert.deepEqual(parseQuery('@bob.example.com').mentions, ['bob.example.com'])
    assert.deepEqual(parseQuery('mentions:@bob.example.com').mentions, ['bob.example.com'])
  })

  it('treats a bare #tag as a tag filter', () => {
    assert.deepEqual(parseQuery('#ATProto').tags, ['atproto'])
    assert.deepEqual(parseQuery('tag:atproto').tags, ['atproto'])
  })

  it('normalises domains from full URLs', () => {
    assert.deepEqual(parseQuery('domain:https://www.GitHub.com/foo').domains, ['github.com'])
    assert.equal(normaliseDomain('HTTPS://News.BBC.co.uk/x'), 'news.bbc.co.uk')
  })

  it('parses has and is flags, including negation', () => {
    const q = parseQuery('has:link has:images -has:video is:reply -is:verified')
    assert.deepEqual(q.has, ['link', 'image'])
    assert.deepEqual(q.notHas, ['video'])
    assert.deepEqual(q.is, ['reply'])
    assert.deepEqual(q.notIs, ['verified'])
  })

  it('ignores unknown flags rather than failing the whole query', () => {
    const q = parseQuery('has:banana is:purple real')
    assert.deepEqual(q.has, [])
    assert.deepEqual(q.is, [])
    assert.equal(q.terms.length, 1)
  })

  it('expands partial dates to the right end of the range', () => {
    assert.equal(parseDate('2026', false), '2026-01-01T00:00:00.000Z')
    assert.equal(parseDate('2026', true), '2026-12-31T23:59:59.999Z')
    assert.equal(parseDate('2026-02', true), '2026-02-28T23:59:59.999Z')
    assert.equal(parseDate('2024-02', true), '2024-02-29T23:59:59.999Z')
    assert.equal(parseDate('2026-03-14', false), '2026-03-14T00:00:00.000Z')
    assert.equal(parseDate('nonsense', false), null)
  })

  it('parses posted and saved date ranges separately', () => {
    const q = parseQuery('after:2025-01-01 before:2025-12-31 saved-after:2026-01-01')
    assert.equal(q.after, '2025-01-01T00:00:00.000Z')
    assert.equal(q.before, '2025-12-31T23:59:59.999Z')
    assert.equal(q.savedAfter, '2026-01-01T00:00:00.000Z')
    assert.equal(q.savedBefore, null)
  })

  it('strips punctuation the index would drop anyway', () => {
    const q = parseQuery('hello, world!')
    assert.deepEqual(
      q.terms.map((t) => t.value),
      ['hello', 'world'],
    )
  })

  it('handles an empty query', () => {
    const q = parseQuery('')
    assert.equal(q.terms.length, 0)
    assert.equal(q.freeText, '')
  })
})
