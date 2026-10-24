import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { parseAgentDate } from '../src/agent/params.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { urlKey } from '../src/lib/url.ts'
import { bookmarkView, pagedFetcher } from './fixtures/bookmarks.ts'
import { addAccount, buildApp, TEST_DID } from './helpers.ts'

const OTHER_DID = 'did:plc:someoneelse'
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

const ROOT = 'at://did:plc:alice/app.bsky.feed.post/root1'

/** The owner's archive: varied enough that every filter has something to bite on. */
const OWNER_BOOKMARKS = [
  bookmarkView({
    uri: ROOT,
    did: 'did:plc:alice',
    handle: 'alice.bsky.social',
    text: 'Portability is the whole point of the AT Protocol. A thread 🧵',
    tags: ['atproto'],
    links: ['https://www.atproto.com/guides/identity/?utm_source=bsky'],
    likeCount: 420,
    createdAt: '2025-11-03T10:00:00.000Z',
    bookmarkedAt: daysAgo(2),
    langs: ['en'],
  }),
  bookmarkView({
    uri: 'at://did:plc:alice/app.bsky.feed.post/reply1',
    did: 'did:plc:alice',
    handle: 'alice.bsky.social',
    text: 'Second part of the thread about identity and handles',
    replyTo: { parentUri: ROOT, rootUri: ROOT },
    links: ['https://atproto.com/guides/identity'],
    likeCount: 12,
    createdAt: '2025-11-03T10:05:00.000Z',
    bookmarkedAt: daysAgo(3),
  }),
  bookmarkView({
    uri: 'at://did:plc:bob/app.bsky.feed.post/gh1',
    did: 'did:plc:bob',
    handle: 'bob.bsky.social',
    text: 'The social-app repo is a great read if you write C++ or TypeScript',
    links: ['https://github.com/bluesky-social/social-app', 'https://gist.github.com/bob/123'],
    tags: ['opensource'],
    likeCount: 90,
    createdAt: '2026-01-20T08:00:00.000Z',
    bookmarkedAt: '2026-02-10T12:00:00.000Z',
  }),
  bookmarkView({
    uri: 'at://did:plc:bob/app.bsky.feed.post/yt1',
    did: 'did:plc:bob',
    handle: 'bob.bsky.social',
    text: 'Conference talk on federation',
    external: {
      uri: 'https://www.youtube.com/watch?v=abc',
      title: 'Federation talk',
      description: 'A long video',
    },
    video: false,
    likeCount: 3,
    createdAt: '2026-03-01T08:00:00.000Z',
    bookmarkedAt: '2026-03-02T12:00:00.000Z',
  }),
  bookmarkView({
    uri: 'at://did:plc:carol/app.bsky.feed.post/quote1',
    did: 'did:plc:carol',
    handle: 'carol.example.com',
    text: 'This is exactly right, and here is a much longer explanation of why moderation needs composable labelling services rather than one central team deciding everything for everyone on the network',
    quote: { uri: ROOT, handle: 'alice.bsky.social', text: 'Portability is the whole point' },
    images: [{ alt: 'A chart of labeller adoption' }],
    likeCount: 0,
    createdAt: '2026-04-01T08:00:00.000Z',
    bookmarkedAt: '2026-04-02T12:00:00.000Z',
  }),
]

/** Someone else on the same multi-user instance. Nothing here may leak. */
const OTHER_BOOKMARKS = [
  bookmarkView({
    uri: 'at://did:plc:secret/app.bsky.feed.post/s1',
    did: 'did:plc:secret',
    handle: 'secretauthor.bsky.social',
    text: 'Zanzibar quokka password manifesto',
    links: ['https://private.example.org/plans'],
    tags: ['hidden'],
  }),
]

describe('agent api', () => {
  let app: FastifyInstance
  let ctx: AppContext
  let cookie: string
  let token: string
  let otherToken: string
  let otherBookmarkId: number

  const agent = (url: string, bearer = token) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } })
  const json = async (url: string, bearer = token) => {
    const response = await agent(url, bearer)
    assert.equal(response.statusCode, 200, `${url} → ${response.statusCode} ${response.body}`)
    return response.json()
  }
  const total = async (url: string) => (await json(url)).total as number

  before(async () => {
    const built = buildApp({ multiUser: true })
    ctx = built.ctx
    cookie = built.cookie
    app = await createApp(ctx)

    await ctx.engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher(OWNER_BOOKMARKS, 10),
    })

    addAccount(ctx.accounts, OTHER_DID, 'someoneelse.bsky.social')
    await ctx.engine.run(OTHER_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher(OTHER_BOOKMARKS, 10),
    })
    otherBookmarkId = ctx.bookmarks.getByUri(OTHER_DID, 'at://did:plc:secret/app.bsky.feed.post/s1')!.id
    otherToken = ctx.accounts.createApiToken(OTHER_DID, 'theirs', { scope: 'agent' }).token

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie },
      payload: { name: 'Claude', scope: 'agent', expiresInDays: 30 },
    })
    assert.equal(created.statusCode, 201)
    token = created.json().token
  })

  after(async () => {
    await app.close()
    ctx.close()
  })

  describe('tokens', () => {
    it('issues agent tokens with a recognisable prefix, scope and expiry', async () => {
      assert.match(token, /^bbm_agent_/)
      const listed = (await app.inject({ method: 'GET', url: '/api/v1/tokens', headers: { cookie } })).json()
      const mine = listed.tokens.find((t: { name: string }) => t.name === 'Claude')
      assert.equal(mine.scope, 'agent')
      assert.ok(mine.expiresAt > new Date().toISOString())
      assert.equal(mine.expired, false)
      assert.ok(!('token' in mine))
    })

    it('rejects a bad scope or expiry when creating', async () => {
      for (const payload of [
        { scope: 'admin' },
        { scope: 'agent', expiresInDays: 0 },
        { scope: 'agent', expiresInDays: 1.5 },
        { scope: 'agent', expiresInDays: '30' },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/tokens', headers: { cookie }, payload })
        assert.equal(response.statusCode, 400, JSON.stringify(payload))
      }
    })

    it('says who the token belongs to', async () => {
      const me = await json('/api/agent/v1/me')
      assert.equal(me.account.did, TEST_DID)
      assert.equal(me.access.via, 'token')
      assert.equal(me.access.scope, 'agent')
      assert.equal(me.access.tokenName, 'Claude')
      assert.equal(me.access.readOnly, true)
      assert.equal(me.archive.bookmarks, OWNER_BOOKMARKS.length)
      assert.equal(me.rateLimit.requestsPerMinute, 600)
    })

    it('distinguishes a missing token from a bad one', async () => {
      const missing = await app.inject({ method: 'GET', url: '/api/agent/v1/me' })
      assert.equal(missing.statusCode, 401)
      assert.equal(missing.json().error, 'unauthorised')
      assert.ok(missing.json().hint)

      const bad = await agent('/api/agent/v1/me', 'bbm_agent_nope')
      assert.equal(bad.statusCode, 401)
      assert.equal(bad.json().error, 'invalid_token')
    })

    it('stops working once expired or revoked', async () => {
      const expired = ctx.accounts.createApiToken(TEST_DID, 'old', {
        scope: 'agent',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      assert.equal((await agent('/api/agent/v1/me', expired.token)).json().error, 'invalid_token')

      const revocable = ctx.accounts.createApiToken(TEST_DID, 'short-lived', { scope: 'agent' })
      assert.equal((await agent('/api/agent/v1/me', revocable.token)).statusCode, 200)
      ctx.accounts.revokeApiToken(TEST_DID, revocable.hint)
      assert.equal((await agent('/api/agent/v1/me', revocable.token)).json().error, 'invalid_token')
    })

    it('also accepts full tokens and the browser session', async () => {
      const full = ctx.accounts.createApiToken(TEST_DID, 'script').token
      assert.equal((await json('/api/agent/v1/me', full)).access.scope, 'full')
      const viaCookie = await app.inject({ method: 'GET', url: '/api/agent/v1/me', headers: { cookie } })
      assert.equal(viaCookie.json().access.via, 'session')
    })
  })

  describe('least privilege', () => {
    it('keeps agent tokens off the rest of the API', async () => {
      const attempts: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
        { method: 'GET', url: '/api/v1/search?q=portability' },
        { method: 'GET', url: '/api/v1/bookmarks' },
        { method: 'GET', url: '/api/v1/tokens' },
        { method: 'POST', url: '/api/v1/tokens' },
        { method: 'DELETE', url: '/api/v1/tokens/whatever' },
        { method: 'POST', url: '/api/v1/sync' },
        { method: 'POST', url: '/api/v1/sync/cancel' },
        { method: 'POST', url: '/api/v1/auth/disconnect' },
        { method: 'POST', url: '/api/v1/auth/logout' },
        { method: 'GET', url: '/api/v1/export?format=json' },
      ]
      for (const attempt of attempts) {
        const response = await app.inject({ ...attempt, headers: { authorization: `Bearer ${token}` } })
        assert.equal(response.statusCode, 403, `${attempt.method} ${attempt.url}`)
        assert.match(response.json().message, /agent token/)
      }
      // And the account is still connected afterwards.
      assert.equal(ctx.accounts.isDisabled(TEST_DID), false)
    })

    it('cannot path-trick its way out of the agent prefix', async () => {
      for (const url of [
        '/api/agent/v1/../../v1/search',
        '/api/agent/v1/%2e%2e/%2e%2e/v1/search',
        '/api/agent/v1/..%2f..%2fv1%2fsearch',
      ]) {
        const response = await agent(url)
        assert.notEqual(response.statusCode, 200, url)
        assert.ok(!response.body.includes('Portability'), url)
      }
    })
  })

  describe('isolation between accounts', () => {
    it('never searches another account’s archive', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?q=quokka'), 0)
      assert.equal(await total('/api/agent/v1/bookmarks?text_contains=Zanzibar'), 0)
      assert.equal(await total('/api/agent/v1/bookmarks?author=secretauthor.bsky.social'), 0)
      assert.equal(await total('/api/agent/v1/bookmarks?domain=private.example.org'), 0)
      assert.equal(await total('/api/agent/v1/bookmarks?tag=hidden'), 0)
      assert.equal(await total('/api/agent/v1/bookmarks?status=all'), OWNER_BOOKMARKS.length)
      assert.equal(await total(`/api/agent/v1/bookmarks?ids=${otherBookmarkId}`), 0)
    })

    it('cannot read another account’s bookmark by id, URI or link', async () => {
      assert.equal((await agent(`/api/agent/v1/bookmarks/${otherBookmarkId}`)).statusCode, 404)
      for (const ref of [
        String(otherBookmarkId),
        'at://did:plc:secret/app.bsky.feed.post/s1',
        'https://bsky.app/profile/did:plc:secret/post/s1',
        'https://bsky.app/profile/secretauthor.bsky.social/post/s1',
      ]) {
        const response = await agent(`/api/agent/v1/lookup?ref=${encodeURIComponent(ref)}`)
        assert.ok([400, 404].includes(response.statusCode), `${ref} → ${response.statusCode}`)
        assert.ok(!response.body.includes('quokka'))
      }
    })

    it('keeps breakdowns and stats to the caller’s archive', async () => {
      const bodies = await Promise.all(
        [
          '/api/agent/v1/links?limit=500',
          '/api/agent/v1/domains?limit=500',
          '/api/agent/v1/authors?limit=500',
          '/api/agent/v1/tags?limit=500',
          '/api/agent/v1/timeline',
          '/api/agent/v1/stats',
        ].map((url) => agent(url)),
      )
      for (const body of bodies) {
        assert.equal(body.statusCode, 200, body.body)
        assert.ok(!body.body.includes('secret'), body.body.slice(0, 200))
        assert.ok(!body.body.includes('private.example.org'))
      }
    })

    it('gives the other account only its own archive', async () => {
      const theirs = await json('/api/agent/v1/bookmarks', otherToken)
      assert.equal(theirs.total, 1)
      assert.equal(theirs.results[0].author.handle, 'secretauthor.bsky.social')
    })
  })

  describe('searching and filtering', () => {
    it('ranks full-text search and reports the query it ran', async () => {
      const body = await json('/api/agent/v1/bookmarks?q=portabilty')
      // The post itself, then Carol's post quoting it: own words outrank quoted ones.
      assert.equal(body.total, 2)
      assert.equal(body.results[0].uri, ROOT)
      assert.ok(body.results[0].score > body.results[1].score)
      assert.deepEqual(body.query.corrections[0].from, 'portabilty')
      assert.equal(body.sort, 'relevance')
    })

    it('returns the compact shape by default', async () => {
      const body = await json('/api/agent/v1/bookmarks?ids=' + ctx.bookmarks.getByUri(TEST_DID, ROOT)!.id)
      const result = body.results[0]
      assert.equal(result.url, 'https://bsky.app/profile/alice.bsky.social/post/root1')
      assert.equal(result.author.handle, 'alice.bsky.social')
      assert.deepEqual(result.tags, ['atproto'])
      assert.equal(result.engagement.likes, 420)
      assert.equal(result.reply, null)
      assert.equal(result.links.length, 1)
      assert.ok(!('raw' in result))
      assert.ok(!('sortIndex' in result))
    })

    it('filters by author, with exclusions and aliases', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?author=alice.bsky.social'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?from=@alice.bsky.social,bob.bsky.social'), 4)
      assert.equal(await total('/api/agent/v1/bookmarks?author=did:plc:carol'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?exclude_author=alice.bsky.social'), 3)
    })

    it('filters by domain, matching subdomains and any of several', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?domain=github.com'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?domain=https://www.github.com/x'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?domain=atproto.com,youtube.com'), 3)
      assert.equal(await total('/api/agent/v1/bookmarks?has=link&exclude_domain=youtube.com'), 3)
    })

    it('matches an exact page however its URL was written', async () => {
      for (const url of [
        'https://atproto.com/guides/identity',
        'http://www.ATPROTO.com/guides/identity/',
        'atproto.com/guides/identity?utm_campaign=x#section',
      ]) {
        assert.equal(await total(`/api/agent/v1/bookmarks?url=${encodeURIComponent(url)}`), 2, url)
      }
      assert.equal(await total('/api/agent/v1/bookmarks?url=https://atproto.com/guides'), 0)
      // Several pages, any of them.
      const either =
        '/api/agent/v1/bookmarks?url=https://atproto.com/guides/identity&url=https://github.com/bluesky-social/social-app'
      assert.equal(await total(either), 3)
    })

    it('matches part of a URL', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?url_contains=github.com/bluesky-social'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?url_contains=GUIDES/IDENTITY'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?url_contains=watch?v=abc'), 1)
    })

    it('matches literal text the word index cannot see', async () => {
      assert.equal(await total(`/api/agent/v1/bookmarks?text_contains=${encodeURIComponent('C++')}`), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?text_contains=thread&text_contains=identity'), 1)
    })

    it('filters by hashtag, features and kinds', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?tag=atproto,opensource'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?has=link&exclude_tag=atproto'), 3)
      assert.equal(await total('/api/agent/v1/bookmarks?has=image,alt'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?has=links'), 4, 'plural spelling accepted')
      assert.equal(await total('/api/agent/v1/bookmarks?has_not=link'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?is=reply'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?is_not=reply'), 4)
      assert.equal(await total('/api/agent/v1/bookmarks?is=quote'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?lang=en'), 1)
    })

    it('filters by when it was posted and when it was saved', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?saved_after=7d'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?saved_after=1w&saved_before=today'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?posted_before=2025'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?posted_after=2026-03&posted_before=2026-03'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?after=2026-01-20'), 3)
      assert.equal(await total('/api/agent/v1/bookmarks?saved_after=2026-02&saved_before=2026-03-31'), 2)
    })

    it('filters by engagement and length', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?min_likes=90'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?max_likes=3'), 2)
      assert.equal(await total('/api/agent/v1/bookmarks?min_words=25'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?max_words=5'), 1)
    })

    it('finds a thread and the posts that quote something', async () => {
      assert.equal(await total(`/api/agent/v1/bookmarks?thread=${encodeURIComponent(ROOT)}`), 2)
      const viaLink = encodeURIComponent('https://bsky.app/profile/alice.bsky.social/post/root1')
      assert.equal(await total(`/api/agent/v1/bookmarks?thread=${viaLink}`), 2)
      assert.equal(await total(`/api/agent/v1/bookmarks?quoting=${encodeURIComponent(ROOT)}`), 1)
    })

    it('combines the query language with parameters', async () => {
      assert.equal(await total('/api/agent/v1/bookmarks?q=from:bob.bsky.social&has=link&exclude_domain=youtube.com'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?q=thread -handles'), 1)
    })

    it('sorts, pages and trims fields', async () => {
      const first = await json('/api/agent/v1/bookmarks?sort=likes&limit=2&fields=engagement')
      assert.equal(first.count, 2)
      assert.equal(first.nextOffset, 2)
      assert.deepEqual(Object.keys(first.results[0]).sort(), ['engagement', 'id'])
      assert.equal(first.results[0].engagement.likes, 420)

      const last = await json('/api/agent/v1/bookmarks?sort=likes&limit=2&offset=4')
      assert.equal(last.count, 1)
      assert.equal(last.nextOffset, null)

      const oldest = await json('/api/agent/v1/bookmarks?sort=oldest-posted&limit=1&fields=postedAt')
      assert.equal(oldest.results[0].postedAt, '2025-11-03T10:00:00.000Z')

      const random = await json('/api/agent/v1/bookmarks?sort=random&limit=5')
      assert.equal(random.count, 5)
    })

    it('offers the full stored record and facets on request', async () => {
      const full = await json('/api/agent/v1/bookmarks?view=full&limit=1')
      assert.ok('authorHandle' in full.results[0])
      assert.ok(!('highlights' in full.results[0]))

      const faceted = await json('/api/agent/v1/bookmarks?facets=true')
      assert.equal(faceted.facets.authors[0].value, 'alice.bsky.social')
    })

    it('sees un-bookmarked posts only when asked', async () => {
      // A full sync that no longer lists the YouTube post marks it removed.
      await ctx.engine.run(TEST_DID, {
        mode: 'full',
        trigger: 'manual',
        fetcher: pagedFetcher(
          OWNER_BOOKMARKS.filter((b) => !JSON.stringify(b).includes('yt1')),
          10,
        ),
      })
      assert.equal(await total('/api/agent/v1/bookmarks'), 4)
      assert.equal(await total('/api/agent/v1/bookmarks?status=removed'), 1)
      assert.equal(await total('/api/agent/v1/bookmarks?status=all'), 5)
      // Put it back for the rest of the suite.
      await ctx.engine.run(TEST_DID, { mode: 'full', trigger: 'manual', fetcher: pagedFetcher(OWNER_BOOKMARKS, 10) })
      assert.equal(await total('/api/agent/v1/bookmarks'), 5)
    })
  })

  describe('validation', () => {
    const error = async (url: string) => {
      const response = await agent(url)
      assert.equal(response.statusCode, 400, `${url} → ${response.statusCode}`)
      return response.json() as { error: string; message: string; hint?: string }
    }

    it('rejects unknown parameters and suggests the right one', async () => {
      const body = await error('/api/agent/v1/bookmarks?autor=alice')
      assert.equal(body.error, 'unknown_parameter')
      assert.match(body.message, /Did you mean `author`/)
      assert.match(body.hint ?? '', /author, exclude_author/)
      assert.equal((await error('/api/agent/v1/links?view=full')).error, 'unknown_parameter')
    })

    it('rejects values it cannot use, and says why', async () => {
      assert.match((await error('/api/agent/v1/bookmarks?saved_after=last tuesday')).hint ?? '', /7d/)
      assert.match((await error('/api/agent/v1/bookmarks?has=gif')).hint ?? '', /Valid values: link/)
      assert.match((await error('/api/agent/v1/bookmarks?is=removed')).hint ?? '', /status=removed/)
      assert.match((await error('/api/agent/v1/bookmarks?limit=1000')).message, /between 1 and 100/)
      assert.match((await error('/api/agent/v1/bookmarks?min_likes=-1')).message, /whole number/)
      assert.match((await error('/api/agent/v1/bookmarks?sort=best')).hint ?? '', /relevance/)
      assert.match((await error('/api/agent/v1/bookmarks?fields=body')).hint ?? '', /text/)
      assert.match((await error('/api/agent/v1/bookmarks?view=full&fields=text')).message, /compact/)
      assert.match((await error('/api/agent/v1/bookmarks?ids=abc')).message, /numeric/)
      assert.match((await error('/api/agent/v1/bookmarks?thread=nope')).message, /at:\/\//)
      assert.match((await error('/api/agent/v1/bookmarks/at%3A%2F%2Fx')).hint ?? '', /lookup/)
    })
  })

  describe('single bookmarks', () => {
    it('reads one by id, with its thread and quotes', async () => {
      const id = ctx.bookmarks.getByUri(TEST_DID, ROOT)!.id
      const body = await json(`/api/agent/v1/bookmarks/${id}`)
      assert.equal(body.bookmark.uri, ROOT)
      assert.equal(body.related.thread.length, 1)
      assert.equal(body.related.thread[0].reply.rootUri, ROOT)
      assert.equal(body.related.quotedBy.length, 1)
      assert.equal(body.related.quotedBy[0].author.handle, 'carol.example.com')

      const quoting = ctx.bookmarks.getByUri(TEST_DID, 'at://did:plc:carol/app.bsky.feed.post/quote1')!.id
      const quoteBody = await json(`/api/agent/v1/bookmarks/${quoting}`)
      assert.equal(quoteBody.related.quoted.uri, ROOT)
    })

    it('looks one up by id, AT-URI, or bsky.app link with a handle or DID', async () => {
      const id = ctx.bookmarks.getByUri(TEST_DID, ROOT)!.id
      for (const ref of [
        String(id),
        ROOT,
        'https://bsky.app/profile/alice.bsky.social/post/root1',
        'https://bsky.app/profile/did:plc:alice/post/root1',
        'https://bsky.app/profile/Alice.bsky.social/post/root1/',
      ]) {
        const body = await json(`/api/agent/v1/lookup?ref=${encodeURIComponent(ref)}`)
        assert.equal(body.bookmark.id, id, ref)
      }
    })

    it('says plainly when a post is not bookmarked', async () => {
      const response = await agent(
        `/api/agent/v1/lookup?ref=${encodeURIComponent('https://bsky.app/profile/alice.bsky.social/post/nothere')}`,
      )
      assert.equal(response.statusCode, 404)
      assert.equal(response.json().error, 'not_found')
      assert.equal((await agent('/api/agent/v1/bookmarks/999999')).statusCode, 404)
    })
  })

  describe('breakdowns', () => {
    it('lists distinct links, folding variants of the same URL together', async () => {
      const body = await json('/api/agent/v1/links')
      const identity = body.results.find((l: { domain: string }) => l.domain === 'atproto.com')
      assert.equal(identity.bookmarks, 2, 'www/utm/trailing-slash variants are one link')
      assert.equal(identity.bookmarkIds.length, 2)
      assert.equal(body.results[0].domain, 'atproto.com', 'most-bookmarked first')
    })

    it('narrows the listed links, not just the bookmarks scanned', async () => {
      const body = await json('/api/agent/v1/links?domain=github.com')
      // gist.github.com is a subdomain, so both links in Bob's post match.
      assert.deepEqual(
        body.results.map((l: { url: string }) => l.url).sort(),
        ['https://gist.github.com/bob/123', 'https://github.com/bluesky-social/social-app'],
      )
      const exact = await json('/api/agent/v1/links?url_contains=social-app')
      assert.equal(exact.total, 1)
    })

    it('counts domains, authors and tags', async () => {
      const domains = await json('/api/agent/v1/domains')
      assert.equal(domains.results[0].domain, 'atproto.com')
      assert.equal(domains.results[0].bookmarks, 2)
      assert.equal(domains.results[0].links, 1)

      const authors = await json('/api/agent/v1/authors?limit=2')
      assert.equal(authors.total, 3)
      assert.equal(authors.count, 2)
      assert.equal(authors.nextOffset, 2)
      assert.equal(authors.results[0].bookmarks, 2)

      const tags = await json('/api/agent/v1/tags?sort=name')
      assert.deepEqual(
        tags.results.map((t: { tag: string }) => t.tag),
        ['atproto', 'opensource'],
      )

      const filtered = await json('/api/agent/v1/authors?domain=youtube.com')
      assert.equal(filtered.total, 1)
      assert.equal(filtered.results[0].handle, 'bob.bsky.social')
    })

    it('buckets bookmarks over time', async () => {
      const posted = await json('/api/agent/v1/timeline?by=posted&interval=year')
      assert.deepEqual(posted.buckets, [
        { period: '2025', count: 2 },
        { period: '2026', count: 3 },
      ])
      const weekly = await json('/api/agent/v1/timeline?by=posted&interval=week&posted_before=2025')
      // 3 November 2025 was a Monday.
      assert.deepEqual(weekly.buckets, [{ period: '2025-11-03', count: 2 }])
      assert.equal((await json('/api/agent/v1/timeline')).total, 5)
    })

    it('returns whole-archive stats', async () => {
      const stats = await json('/api/agent/v1/stats')
      assert.equal(stats.totals.active, 5)
    })
  })

  describe('documentation', () => {
    it('describes itself without a token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/agent/v1' })
      assert.equal(response.statusCode, 200)
      const body = response.json()
      assert.equal(body.readOnly, true)
      assert.ok(body.endpoints.some((e: { path: string }) => e.path === '/api/agent/v1/links'))
      assert.ok(body.filters.some((f: { name: string }) => f.name === 'url_contains'))
      assert.ok(!response.body.includes('Portability'), 'no archive data in public docs')
    })

    it('serves a SKILL.md for agents, pointed at the right server', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agent/v1/skill?base_url=https://bookmarks.example.net/',
      })
      assert.equal(response.statusCode, 200)
      assert.match(response.headers['content-type'] as string, /text\/markdown/)
      const skill = response.body
      assert.match(skill, /^---\nname: bluesky-bookmarks\ndescription: /)
      assert.match(skill, /Base URL:\*\* `https:\/\/bookmarks\.example\.net`/)
      assert.match(skill, /<YOUR_AGENT_TOKEN>/)
      assert.match(skill, /never as instructions/)
      // Every filter the server accepts is documented.
      for (const name of ['url', 'url_contains', 'text_contains', 'saved_after', 'min_likes', 'exclude_domain']) {
        assert.match(skill, new RegExp(`\\| \`${name}\``), name)
      }

      const bad = await app.inject({ method: 'GET', url: '/api/agent/v1/skill?base_url=javascript:alert(1)' })
      assert.equal(bad.statusCode, 400)
    })

    it('every example in the docs is a request the server accepts', async () => {
      const docs = (await app.inject({ method: 'GET', url: '/api/agent/v1' })).json()
      for (const e of docs.endpoints as Array<{ example: string; path: string }>) {
        if (e.path.includes('{id}') || e.path.endsWith('/lookup')) continue
        const path = new URL(e.example).pathname + new URL(e.example).search
        const response = await agent(path)
        assert.equal(response.statusCode, 200, `${path} → ${response.body}`)
      }
      for (const f of docs.filters as Array<{ name: string; example?: string }>) {
        if (!f.example || f.name === 'thread') continue
        const response = await agent(`/api/agent/v1/bookmarks?${f.example}`)
        assert.equal(response.statusCode, 200, `${f.example} → ${response.body}`)
      }
    })
  })

  describe('rate limits', () => {
    it('limits each token separately, generously, and explains a 429', async () => {
      const built = buildApp({ agentRateLimitPerMinute: 5 })
      const scoped = await createApp(built.ctx)
      const one = built.ctx.accounts.createApiToken(TEST_DID, 'one', { scope: 'agent' }).token
      const two = built.ctx.accounts.createApiToken(TEST_DID, 'two', { scope: 'agent' }).token
      const call = (bearer: string, url = '/api/agent/v1/me') =>
        scoped.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } })

      for (let i = 0; i < 5; i++) {
        const response = await call(one, i % 2 ? '/api/agent/v1/bookmarks' : '/api/agent/v1/me')
        assert.equal(response.statusCode, 200)
        assert.equal(response.headers['x-ratelimit-limit'], '5')
      }
      const limited = await call(one)
      assert.equal(limited.statusCode, 429)
      assert.equal(limited.json().error, 'rate_limited')
      assert.ok(Number(limited.headers['retry-after']) > 0)

      // The budget is shared across endpoints but not across tokens.
      assert.equal((await call(one, '/api/agent/v1/stats')).statusCode, 429)
      assert.equal((await call(two)).statusCode, 200)

      await scoped.close()
      built.ctx.close()
    })

    it('gives unauthenticated callers a small budget, which caps token guessing', async () => {
      const built = buildApp()
      const scoped = await createApp(built.ctx)
      let last = 0
      for (let i = 0; i < 61; i++) {
        last = (
          await scoped.inject({
            method: 'GET',
            url: '/api/agent/v1/me',
            headers: { authorization: `Bearer guess-${i}` },
          })
        ).statusCode
      }
      assert.equal(last, 429)
      await scoped.close()
      built.ctx.close()
    })
  })
})

describe('agent helpers', () => {
  it('normalises URLs for comparison', () => {
    assert.equal(urlKey('https://www.Example.com/a/?utm_source=x&fbclid=y#top'), 'example.com/a')
    assert.equal(urlKey('example.com/a'), 'example.com/a')
    assert.equal(urlKey('http://example.com:8080/a?id=1&utm_medium=z'), 'example.com:8080/a?id=1')
    assert.equal(urlKey('https://github.com/o/r?ref=main'), 'github.com/o/r?ref=main', 'meaningful params kept')
    assert.equal(urlKey('https://example.com/CaseSensitive'), 'example.com/CaseSensitive')
  })

  it('parses absolute, partial and relative dates', () => {
    const now = new Date('2026-10-24T12:00:00.000Z')
    assert.equal(parseAgentDate('7d', false, now), '2026-10-17T12:00:00.000Z')
    assert.equal(parseAgentDate('2w', false, now), '2026-10-10T12:00:00.000Z')
    assert.equal(parseAgentDate('3mo', false, now), '2026-07-24T12:00:00.000Z')
    assert.equal(parseAgentDate('1y', false, now), '2025-10-24T12:00:00.000Z')
    assert.equal(parseAgentDate('12h', false, now), '2026-10-24T00:00:00.000Z')
    assert.equal(parseAgentDate('today', false, now), '2026-10-24T00:00:00.000Z')
    assert.equal(parseAgentDate('yesterday', true, now), '2026-10-23T23:59:59.999Z')
    assert.equal(parseAgentDate('2026-02', true, now), '2026-02-28T23:59:59.999Z')
    assert.equal(parseAgentDate('2026-03-14T09:30:00Z', false, now), '2026-03-14T09:30:00.000Z')
    for (const bad of ['5', 'march', 'last week', '7 days', '10m']) {
      assert.equal(parseAgentDate(bad, false, now), null, bad)
    }
  })
})
