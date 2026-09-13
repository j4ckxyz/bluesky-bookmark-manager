import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { SearchService } from '../src/search/search.ts'
import { bookmarkView, pagedFetcher } from './fixtures/bookmarks.ts'
import { createHarness, TEST_DID, type TestHarness } from './helpers.ts'

/** A small, deliberately varied corpus that every search test shares. */
const CORPUS = [
  bookmarkView({
    uri: 'at://did:plc:a/app.bsky.feed.post/1',
    text: 'The AT Protocol makes account portability real. A deep dive into decentralised identity.',
    handle: 'alice.bsky.social',
    displayName: 'Alice Alpha',
    did: 'did:plc:alice',
    verified: true,
    tags: ['atproto', 'identity'],
    langs: ['en'],
    createdAt: '2026-01-10T09:00:00.000Z',
    bookmarkedAt: '2026-03-01T09:00:00.000Z',
    likeCount: 500,
    links: ['https://atproto.com/guides/identity'],
  }),
  bookmarkView({
    uri: 'at://did:plc:b/app.bsky.feed.post/2',
    text: 'Firehose consumers should handle backfill carefully. See the docs.',
    handle: 'bob.bsky.social',
    displayName: 'Bob Beta',
    did: 'did:plc:bob',
    createdAt: '2025-06-02T09:00:00.000Z',
    bookmarkedAt: '2026-02-01T09:00:00.000Z',
    likeCount: 12,
    external: {
      uri: 'https://docs.bsky.app/docs/advanced-guides/firehose',
      title: 'Firehose guide',
      description: 'How to consume the network firehose',
    },
  }),
  bookmarkView({
    uri: 'at://did:plc:c/app.bsky.feed.post/3',
    text: 'Replying to @alice.bsky.social about moderation labels and composable stacks',
    handle: 'carol.bsky.social',
    did: 'did:plc:carol',
    mentions: [{ did: 'did:plc:alice', handle: 'alice.bsky.social' }],
    replyTo: {
      parentUri: 'at://did:plc:alice/app.bsky.feed.post/1',
      rootUri: 'at://did:plc:alice/app.bsky.feed.post/1',
    },
    createdAt: '2026-02-14T09:00:00.000Z',
    bookmarkedAt: '2026-02-20T09:00:00.000Z',
    langs: ['en'],
  }),
  bookmarkView({
    uri: 'at://did:plc:d/app.bsky.feed.post/4',
    text: 'A photo essay from the coast',
    handle: 'dave.bsky.social',
    did: 'did:plc:dave',
    images: [{ alt: 'Waves breaking over a stone harbour wall at dusk' }],
    createdAt: '2026-01-20T09:00:00.000Z',
    bookmarkedAt: '2026-01-25T09:00:00.000Z',
  }),
  bookmarkView({
    uri: 'at://did:plc:e/app.bsky.feed.post/5',
    text: 'Short clip of the lexicon tooling in action',
    handle: 'erin.bsky.social',
    did: 'did:plc:erin',
    video: true,
    tags: ['lexicon'],
    langs: ['fr'],
    createdAt: '2025-12-01T09:00:00.000Z',
    bookmarkedAt: '2026-01-05T09:00:00.000Z',
  }),
  bookmarkView({
    uri: 'at://did:plc:f/app.bsky.feed.post/6',
    text: 'Quoting a great thread on network effects',
    handle: 'frank.bsky.social',
    did: 'did:plc:frank',
    quote: {
      uri: 'at://did:plc:alice/app.bsky.feed.post/99',
      handle: 'alice.bsky.social',
      text: 'Network effects compound when users can leave without losing their audience',
    },
    links: ['https://github.com/bluesky-social/atproto'],
    createdAt: '2026-03-05T09:00:00.000Z',
    bookmarkedAt: '2026-03-06T09:00:00.000Z',
  }),
]

describe('search', () => {
  let harness: TestHarness
  let search: SearchService

  before(async () => {
    harness = createHarness()
    await harness.engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher(CORPUS, 3),
    })
    search = new SearchService(harness.db, harness.bookmarks)
  })

  const uris = (result: { results: Array<{ uri: string }> }) => result.results.map((r) => r.uri)

  it('lists everything when the query is empty, newest saved first', () => {
    const result = search.search(TEST_DID, {})
    assert.equal(result.total, 6)
    assert.equal(result.sort, 'saved')
    assert.equal(result.results[0]?.uri, 'at://did:plc:f/app.bsky.feed.post/6')
  })

  it('finds posts by a word in the text', () => {
    const result = search.search(TEST_DID, { q: 'firehose' })
    assert.equal(result.total, 1)
    assert.equal(result.results[0]?.uri, 'at://did:plc:b/app.bsky.feed.post/2')
  })

  it('ANDs multiple bare words', () => {
    assert.equal(search.search(TEST_DID, { q: 'protocol portability' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'protocol nonexistentword' }).total, 0)
  })

  it('matches a quoted phrase only in order', () => {
    assert.equal(search.search(TEST_DID, { q: '"account portability"' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: '"portability account"' }).total, 0)
  })

  it('matches unquoted words regardless of order', () => {
    assert.equal(search.search(TEST_DID, { q: 'portability account' }).total, 1)
  })

  it('matches word prefixes so partial typing still finds things', () => {
    const result = search.search(TEST_DID, { q: 'decentral' })
    assert.equal(result.total, 1)
    assert.equal(result.results[0]?.uri, 'at://did:plc:a/app.bsky.feed.post/1')
  })

  it('corrects a typo and says what it corrected', () => {
    const result = search.search(TEST_DID, { q: 'firehse' })
    assert.equal(result.total, 1, 'a one-edit typo still finds the post')
    assert.deepEqual(result.corrections[0]?.to, ['firehose'])
  })

  it('does not fuzz a quoted term', () => {
    assert.equal(search.search(TEST_DID, { q: '"firehse"' }).total, 0)
  })

  it('does not fuzz very short terms', () => {
    // "cat" is one edit from nothing in the corpus, and must not match "car".
    const result = search.search(TEST_DID, { q: 'xyz' })
    assert.equal(result.total, 0)
    assert.equal(result.corrections.length, 0)
  })

  it('searches alt text and quoted posts as well as the post body', () => {
    assert.equal(search.search(TEST_DID, { q: 'harbour' }).total, 1, 'alt text is indexed')
    assert.equal(search.search(TEST_DID, { q: 'compound' }).total, 1, 'quoted text is indexed')
  })

  it('searches link titles and URLs', () => {
    assert.equal(search.search(TEST_DID, { q: 'consume' }).total, 1, 'external description is indexed')
    assert.equal(search.search(TEST_DID, { q: 'guides' }).total >= 1, true, 'URL words are indexed')
  })

  it('excludes negated terms', () => {
    const withoutFirehose = search.search(TEST_DID, { q: '-firehose' })
    assert.equal(withoutFirehose.total, 5)
    assert.ok(!uris(withoutFirehose).includes('at://did:plc:b/app.bsky.feed.post/2'))
  })

  it('combines a positive term with a negated one', () => {
    assert.equal(search.search(TEST_DID, { q: 'the -firehose' }).total > 0, true)
    assert.equal(search.search(TEST_DID, { q: 'firehose -backfill' }).total, 0)
  })

  it('filters by author', () => {
    assert.equal(search.search(TEST_DID, { q: 'from:@bob.bsky.social' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'from:did:plc:bob' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: '-from:@bob.bsky.social' }).total, 5)
  })

  it('filters by mention', () => {
    const result = search.search(TEST_DID, { q: '@alice.bsky.social' })
    assert.equal(result.total, 1)
    assert.equal(result.results[0]?.uri, 'at://did:plc:c/app.bsky.feed.post/3')
  })

  it('filters by link domain, including subdomains', () => {
    assert.equal(search.search(TEST_DID, { q: 'domain:github.com' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'domain:bsky.app' }).total, 1, 'matches docs.bsky.app')
    assert.equal(search.search(TEST_DID, { q: 'domain:example.invalid' }).total, 0)
  })

  it('filters by tag and language', () => {
    assert.equal(search.search(TEST_DID, { q: '#atproto' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'lang:en' }).total, 2)
    assert.equal(search.search(TEST_DID, { q: 'lang:fr' }).total, 1)
  })

  it('filters by content attributes', () => {
    assert.equal(search.search(TEST_DID, { q: 'has:image' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'has:video' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'has:media' }).total, 2)
    assert.equal(search.search(TEST_DID, { q: 'has:link' }).total, 3)
    assert.equal(search.search(TEST_DID, { q: 'has:alt' }).total, 2, 'video alt text counts')
  })

  it('filters by post kind and verification', () => {
    assert.equal(search.search(TEST_DID, { q: 'is:reply' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'is:root' }).total, 5)
    assert.equal(search.search(TEST_DID, { q: 'is:quote' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'is:verified' }).total, 1)
  })

  it('filters by when a post was written', () => {
    assert.equal(search.search(TEST_DID, { q: 'after:2026-01-01' }).total, 4)
    assert.equal(search.search(TEST_DID, { q: 'before:2025-12-31' }).total, 2)
    assert.equal(search.search(TEST_DID, { q: 'after:2026-01-01 before:2026-01-31' }).total, 2)
  })

  it('filters by when a post was bookmarked, separately from when it was written', () => {
    assert.equal(search.search(TEST_DID, { q: 'saved-after:2026-03-01' }).total, 2)
    assert.equal(
      search.search(TEST_DID, { q: 'saved-after:2026-03-01 before:2026-02-01' }).total,
      1,
      'saved in March, written before February',
    )
  })

  it('combines free text with filters', () => {
    assert.equal(search.search(TEST_DID, { q: 'protocol from:@alice.bsky.social' }).total, 1)
    assert.equal(search.search(TEST_DID, { q: 'protocol from:@bob.bsky.social' }).total, 0)
  })

  it('ranks an exact text hit above a fuzzy or incidental one', () => {
    const result = search.search(TEST_DID, { q: 'lexicon' })
    assert.equal(result.results[0]?.uri, 'at://did:plc:e/app.bsky.feed.post/5')
  })

  it('respects the requested sort order', () => {
    const byLikes = search.search(TEST_DID, { sort: 'likes' })
    assert.equal(byLikes.results[0]?.uri, 'at://did:plc:a/app.bsky.feed.post/1')

    const oldest = search.search(TEST_DID, { sort: 'oldest-posted' })
    assert.equal(oldest.results[0]?.uri, 'at://did:plc:b/app.bsky.feed.post/2')
  })

  it('paginates without dropping or repeating results', () => {
    const first = search.search(TEST_DID, { limit: 2, offset: 0 })
    const second = search.search(TEST_DID, { limit: 2, offset: 2 })
    assert.equal(first.total, 6)
    assert.equal(first.results.length, 2)
    assert.equal(second.results.length, 2)
    assert.equal(new Set([...uris(first), ...uris(second)]).size, 4)
  })

  it('returns facet counts over the matched set', () => {
    const result = search.search(TEST_DID, { withFacets: true })
    assert.equal(result.facets?.authors.length, 6)
    assert.deepEqual(
      result.facets?.langs.map((l) => l.value).sort(),
      ['en', 'fr'],
    )
    const link = result.facets?.attributes.find((a) => a.value === 'link')
    assert.equal(link?.count, 3)

    const narrowed = search.search(TEST_DID, { q: 'from:@alice.bsky.social', withFacets: true })
    assert.equal(narrowed.facets?.authors.length, 1, 'facets reflect the filtered set')
  })

  it('hides removed bookmarks by default and finds them on request', async () => {
    const scoped = createHarness()
    const kept = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/keep', text: 'kept forever' })
    const dropped = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/drop', text: 'dropped later' })
    await scoped.engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher([kept, dropped], 10),
    })
    await scoped.engine.run(TEST_DID, {
      mode: 'full',
      trigger: 'schedule',
      fetcher: pagedFetcher([kept], 10),
    })

    const scopedSearch = new SearchService(scoped.db, scoped.bookmarks)
    assert.equal(scopedSearch.search(TEST_DID, { q: 'dropped' }).total, 0)
    assert.equal(scopedSearch.search(TEST_DID, { q: 'dropped', status: 'removed' }).total, 1)
    assert.equal(scopedSearch.search(TEST_DID, { q: 'dropped is:removed' }).total, 1)
    assert.equal(scopedSearch.search(TEST_DID, { status: 'all' }).total, 2)
  })

  it('keeps one account out of another account\'s results', async () => {
    const scoped = createHarness({ multiUser: true })
    scoped.accounts.upsert({
      did: 'did:plc:other',
      handle: 'other.bsky.social',
      displayName: null,
      avatar: null,
      pdsUrl: 'https://bsky.social',
      session: {
        did: 'did:plc:other',
        handle: 'other.bsky.social',
        accessJwt: 'a',
        refreshJwt: 'r',
        service: 'https://bsky.social',
      },
    })
    await scoped.engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher([bookmarkView({ text: 'mine alone' })], 10),
    })

    const scopedSearch = new SearchService(scoped.db, scoped.bookmarks)
    assert.equal(scopedSearch.search(TEST_DID, { q: 'mine' }).total, 1)
    assert.equal(scopedSearch.search('did:plc:other', { q: 'mine' }).total, 0)
  })

  it('survives characters that would break a raw FTS expression', () => {
    for (const q of ['"', 'a AND', 'NOT', '*', '((', 'foo"bar', 'a OR b', '^caret']) {
      assert.doesNotThrow(() => search.search(TEST_DID, { q }), `query ${JSON.stringify(q)} threw`)
    }
  })
})
