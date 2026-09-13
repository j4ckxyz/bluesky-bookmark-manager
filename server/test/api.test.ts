import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { createApp } from '../src/app.ts'
import { AccountStore } from '../src/db/accounts.ts'
import { BookmarkStore } from '../src/db/bookmarks.ts'
import { openDatabase } from '../src/db/index.ts'
import { SearchService } from '../src/search/search.ts'
import { SyncEngine } from '../src/sync/engine.ts'
import { SyncRunStore } from '../src/sync/runs.ts'
import { SyncScheduler } from '../src/sync/scheduler.ts'
import { IdentityResolver } from '../src/atproto/identity.ts'
import { SessionManager } from '../src/atproto/session.ts'
import type { AppContext } from '../src/context.ts'
import { bookmarkView, pagedFetcher } from './fixtures/bookmarks.ts'
import { testConfig, TEST_DID } from './helpers.ts'

/**
 * Builds a real app over an in-memory database, with one signed-in account
 * and a browser session cookie already issued.
 */
function buildApp() {
  const config = testConfig()
  const db = openDatabase(':memory:')
  const accounts = new AccountStore(db, config.encryptionKey)
  const bookmarks = new BookmarkStore(db)
  const runs = new SyncRunStore(db)
  const search = new SearchService(db, bookmarks)
  const identity = new IdentityResolver(config)
  const sessions = new SessionManager(config, accounts, identity)
  const engine = new SyncEngine({ config, accounts, bookmarks, runs, clientFor: async () => null })
  const scheduler = new SyncScheduler({ config, accounts, engine })

  const ctx: AppContext = {
    config,
    db,
    accounts,
    bookmarks,
    runs,
    search,
    identity,
    sessions,
    engine,
    scheduler,
    close: () => db.close(),
  }

  accounts.upsert({
    did: TEST_DID,
    handle: 'owner.bsky.social',
    displayName: 'Owner',
    avatar: null,
    pdsUrl: 'https://bsky.social',
    session: {
      did: TEST_DID,
      handle: 'owner.bsky.social',
      accessJwt: 'a',
      refreshJwt: 'r',
      service: 'https://bsky.social',
    },
  })

  const cookie = `bskybm_session=${accounts.createAuthSession(TEST_DID, 30, 'test')}`
  return { ctx, cookie }
}

describe('http api', () => {
  let app: FastifyInstance
  let ctx: AppContext
  let cookie: string

  before(async () => {
    const built = buildApp()
    ctx = built.ctx
    cookie = built.cookie
    app = await createApp(ctx)

    await ctx.engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher(
        [
          bookmarkView({
            uri: 'at://did:plc:a/app.bsky.feed.post/1',
            text: 'Portability is the whole point of the AT Protocol',
            handle: 'alice.bsky.social',
            tags: ['atproto'],
            links: ['https://atproto.com/guides/identity'],
            likeCount: 42,
          }),
          bookmarkView({
            uri: 'at://did:plc:b/app.bsky.feed.post/2',
            text: 'Firehose notes',
            handle: 'bob.bsky.social',
            images: [{ alt: 'A diagram of the relay' }],
          }),
        ],
        10,
      ),
    })
  })

  after(async () => {
    await app.close()
    ctx.close()
  })

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { cookie, ...headers } })

  it('rejects unauthenticated API calls', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search' })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorised')
  })

  it('describes the instance without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/instance' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.multiUser, false)
    assert.equal(body.claimed, true)
    assert.equal(body.syncIntervalMinutes, 10)
  })

  it('reports the signed-in account', async () => {
    const response = await get('/api/v1/auth/session')
    assert.equal(response.json().account.handle, 'owner.bsky.social')
  })

  it('searches over the HTTP surface', async () => {
    const response = await get('/api/v1/search?q=portability')
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.total, 1)
    assert.equal(body.results[0].authorHandle, 'alice.bsky.social')
    assert.ok(typeof body.took === 'number')
  })

  it('accepts structured filters as query parameters', async () => {
    assert.equal((await get('/api/v1/search?has=image')).json().total, 1)
    assert.equal((await get('/api/v1/search?from=alice.bsky.social')).json().total, 1)
    assert.equal((await get('/api/v1/search?domain=atproto.com')).json().total, 1)
    assert.equal((await get('/api/v1/search?tag=atproto&has=link')).json().total, 1)
  })

  it('returns facets on request', async () => {
    const body = (await get('/api/v1/search?facets=1')).json()
    assert.equal(body.facets.authors.length, 2)
  })

  it('fetches one bookmark by id and by URI', async () => {
    const list = (await get('/api/v1/bookmarks')).json()
    const first = list.results[0]

    const byId = await get(`/api/v1/bookmarks/${first.id}`)
    assert.equal(byId.json().uri, first.uri)

    const byUri = await get(`/api/v1/bookmarks/${encodeURIComponent(first.uri)}`)
    assert.equal(byUri.json().id, first.id)

    assert.equal((await get('/api/v1/bookmarks/999999')).statusCode, 404)
  })

  it('returns stats', async () => {
    const body = (await get('/api/v1/stats')).json()
    assert.equal(body.totals.active, 2)
    assert.equal(body.totals.authors, 2)
    assert.equal(body.content.withImages, 1)
    assert.equal(body.topTags[0].value, 'atproto')
  })

  it('suggests authors, tags and domains from the archive', async () => {
    const body = (await get('/api/v1/suggest?q=ali')).json()
    assert.equal(body.authors[0].value, 'alice.bsky.social')

    const tags = (await get('/api/v1/suggest?q=atpro')).json()
    assert.equal(tags.tags[0].value, 'atproto')
    assert.equal(tags.domains[0].value, 'atproto.com')
  })

  it('reports sync status and history', async () => {
    const status = (await get('/api/v1/sync/status')).json()
    assert.equal(status.status.status, 'completed')
    assert.equal(status.totalStored, 2)
    assert.equal(status.intervalMinutes, 10)

    const history = (await get('/api/v1/sync/history')).json()
    assert.equal(history.runs.length, 1)
    assert.equal(history.runs[0].mode, 'backfill')
  })

  it('exports Netscape bookmark HTML that importers understand', async () => {
    const response = await get('/api/v1/export?format=html')
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'] as string, /text\/html/)
    assert.match(response.headers['content-disposition'] as string, /attachment; filename=/)
    assert.equal(response.headers['x-bookmark-count'], '2')

    const body = response.body
    assert.match(body, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/)
    assert.match(body, /<DT><A HREF="https:\/\/bsky\.app\/profile\/alice\.bsky\.social\/post\/1"/)
    assert.match(body, /ADD_DATE="\d+"/)
    assert.match(body, /TAGS="[^"]*atproto[^"]*"/)
  })

  it('exports JSON, CSV and NDJSON', async () => {
    const json = (await get('/api/v1/export?format=json')).json()
    assert.equal(json.count, 2)
    assert.equal(json.account, 'owner.bsky.social')

    const csv = (await get('/api/v1/export?format=csv')).body
    const lines = csv.trim().split('\r\n')
    assert.equal(lines.length, 3, 'header plus two rows')
    assert.match(lines[0] ?? '', /^uri,url,bookmarked_at/)

    const ndjson = (await get('/api/v1/export?format=ndjson')).body
    assert.equal(ndjson.trim().split('\n').length, 2)
  })

  it('exports only what the filters match', async () => {
    const response = await get('/api/v1/export?format=json&has=image')
    assert.equal(response.json().count, 1)
  })

  it('rejects an unknown export format', async () => {
    const response = await get('/api/v1/export?format=pdf')
    assert.equal(response.statusCode, 400)
  })

  it('issues an API token that authenticates subsequent calls', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie },
      payload: { name: 'Obsidian' },
    })
    assert.equal(created.statusCode, 201)
    const token: string = created.json().token
    assert.ok(token)

    const withToken = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=firehose',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(withToken.statusCode, 200)
    assert.equal(withToken.json().total, 1)

    // A token must not be able to mint another token.
    const escalation = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'sneaky' },
    })
    assert.equal(escalation.statusCode, 403)

    const listed = (await get('/api/v1/tokens')).json()
    assert.equal(listed.tokens.length, 1)
    assert.equal(listed.tokens[0].name, 'Obsidian')
    assert.ok(!('token' in listed.tokens[0]), 'the raw token is never listed back')

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${encodeURIComponent(listed.tokens[0].hint)}`,
      headers: { cookie },
    })
    assert.equal(revoked.statusCode, 200)

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/search',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(afterRevoke.statusCode, 401)
  })

  it('rejects a login with no credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: '', password: '' },
    })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'invalid_credentials')
  })

  it('clears the session cookie on logout', async () => {
    const built = buildApp()
    const scoped = await createApp(built.ctx)
    const response = await scoped.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: built.cookie },
    })
    assert.equal(response.statusCode, 200)

    const after = await scoped.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: built.cookie },
    })
    assert.equal(after.json().account, null)
    await scoped.close()
    built.ctx.close()
  })

  it('returns JSON 404s for unknown API routes', async () => {
    const response = await get('/api/v1/nope')
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error, 'not_found')
  })

  it('serves health without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' })
    assert.equal(response.json().ok, true)
  })
})
