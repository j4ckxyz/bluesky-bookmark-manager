import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blockedBookmark, bookmarkView, notFoundBookmark, pagedFetcher } from './fixtures/bookmarks.ts'
import { createHarness, TEST_DID } from './helpers.ts'

describe('sync engine', () => {
  it('backfills every page and reports progress', async () => {
    const { engine, bookmarks } = createHarness()
    const views = Array.from({ length: 7 }, (_, i) =>
      bookmarkView({ text: `post number ${i}`, uri: `at://did:plc:a/app.bsky.feed.post/p${i}` }),
    )

    const progressEvents: number[] = []
    engine.on('progress', (p) => progressEvents.push(p.scanned))

    const result = await engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher(views, 2),
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.scanned, 7)
    assert.equal(result.created, 7)
    assert.equal(result.pages, 4)
    assert.equal(bookmarks.countActive(TEST_DID), 7)
    assert.ok(progressEvents.length >= 4, 'progress is emitted as pages land')
  })

  it('marks the account as backfilled so later runs go incremental', async () => {
    const { engine, accounts } = createHarness()
    await engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher([bookmarkView()], 10),
    })

    assert.ok(accounts.get(TEST_DID)?.backfillCompletedAt, 'backfill timestamp is recorded')
    // sync_counter is 1 after the backfill, so the next scheduled pass is quick.
    assert.equal(engine.nextScheduledMode(TEST_DID), 'quick')
  })

  it('stops a quick sync early once pages are all already known', async () => {
    const { engine, config } = createHarness({ quickSyncStablePages: 1 })
    const views = Array.from({ length: 10 }, (_, i) =>
      bookmarkView({ uri: `at://did:plc:a/app.bsky.feed.post/p${i}` }),
    )

    await engine.run(TEST_DID, { mode: 'backfill', trigger: 'login', fetcher: pagedFetcher(views, 2) })

    const quickFetcher = pagedFetcher(views, 2)
    const result = await engine.run(TEST_DID, { mode: 'quick', trigger: 'schedule', fetcher: quickFetcher })

    assert.equal(result.status, 'completed')
    assert.equal(result.created, 0)
    assert.equal(
      result.pages,
      config.quickSyncStablePages,
      'gives up after the configured run of unchanged pages',
    )
  })

  it('keeps walking a quick sync while new bookmarks keep appearing', async () => {
    const { engine } = createHarness({ quickSyncStablePages: 1 })
    const views = Array.from({ length: 6 }, (_, i) =>
      bookmarkView({ uri: `at://did:plc:a/app.bsky.feed.post/p${i}` }),
    )

    const result = await engine.run(TEST_DID, {
      mode: 'quick',
      trigger: 'schedule',
      fetcher: pagedFetcher(views, 2),
    })

    assert.equal(result.created, 6, 'every page held something new, so none were skipped')
  })

  it('soft-deletes bookmarks removed on the Bluesky side during a full sync', async () => {
    const { engine, bookmarks } = createHarness()
    const kept = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/keep', text: 'still saved' })
    const dropped = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/drop', text: 'removed later' })

    await engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher([kept, dropped], 10),
    })
    assert.equal(bookmarks.countActive(TEST_DID), 2)

    const result = await engine.run(TEST_DID, {
      mode: 'full',
      trigger: 'schedule',
      fetcher: pagedFetcher([kept], 10),
    })

    assert.equal(result.removed, 1)
    assert.equal(bookmarks.countActive(TEST_DID), 1)

    const gone = bookmarks.getByUri(TEST_DID, 'at://did:plc:a/app.bsky.feed.post/drop')
    assert.equal(gone?.status, 'removed')
    assert.ok(gone?.removedAt, 'removal is timestamped')
    assert.equal(gone?.text, 'removed later', 'the archived copy is still readable')
  })

  it('never removes anything on a quick sync', async () => {
    const { engine, bookmarks } = createHarness({ quickSyncStablePages: 1 })
    const a = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/a' })
    const b = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/b' })

    await engine.run(TEST_DID, { mode: 'backfill', trigger: 'login', fetcher: pagedFetcher([a, b], 10) })
    const result = await engine.run(TEST_DID, {
      mode: 'quick',
      trigger: 'schedule',
      fetcher: pagedFetcher([a], 10),
    })

    assert.equal(result.removed, 0)
    assert.equal(bookmarks.countActive(TEST_DID), 2, 'a partial walk is not evidence of removal')
  })

  it('restores a bookmark that comes back', async () => {
    const { engine, bookmarks } = createHarness()
    const uri = 'at://did:plc:a/app.bsky.feed.post/x'
    const view = bookmarkView({ uri })

    await engine.run(TEST_DID, { mode: 'backfill', trigger: 'login', fetcher: pagedFetcher([view], 10) })
    await engine.run(TEST_DID, { mode: 'full', trigger: 'schedule', fetcher: pagedFetcher([], 10) })
    assert.equal(bookmarks.countActive(TEST_DID), 0)

    const result = await engine.run(TEST_DID, {
      mode: 'full',
      trigger: 'schedule',
      fetcher: pagedFetcher([view], 10),
    })

    assert.equal(result.restored, 1)
    const restored = bookmarks.getByUri(TEST_DID, uri)
    assert.equal(restored?.status, 'active')
    assert.equal(restored?.removedAt, null, 'the removal timestamp is cleared')
  })

  it('reconciles correctly when two syncs land in the same millisecond', async () => {
    const { engine, bookmarks } = createHarness()
    const kept = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/keep' })
    const dropped = bookmarkView({ uri: 'at://did:plc:a/app.bsky.feed.post/drop' })

    // Freeze the clock so both runs share a timestamp. Reconciliation keys off
    // the sync run id, so it must still work.
    const realNow = Date.now
    Date.now = () => 1_800_000_000_000
    try {
      await engine.run(TEST_DID, {
        mode: 'backfill',
        trigger: 'login',
        fetcher: pagedFetcher([kept, dropped], 10),
      })
      const result = await engine.run(TEST_DID, {
        mode: 'full',
        trigger: 'schedule',
        fetcher: pagedFetcher([kept], 10),
      })
      assert.equal(result.removed, 1)
      assert.equal(bookmarks.countActive(TEST_DID), 1)
    } finally {
      Date.now = realNow
    }
  })

  it('keeps deleted and blocked posts in the archive', async () => {
    const { engine, bookmarks } = createHarness()
    const views = [
      notFoundBookmark('at://did:plc:a/app.bsky.feed.post/gone'),
      blockedBookmark('at://did:plc:b/app.bsky.feed.post/blocked', 'did:plc:b'),
    ]

    const result = await engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'login',
      fetcher: pagedFetcher(views, 10),
    })

    assert.equal(result.created, 2)
    assert.equal(
      bookmarks.getByUri(TEST_DID, 'at://did:plc:a/app.bsky.feed.post/gone')?.itemState,
      'not_found',
    )
    assert.equal(
      bookmarks.getByUri(TEST_DID, 'at://did:plc:b/app.bsky.feed.post/blocked')?.itemState,
      'blocked',
    )
  })

  it('records a failure instead of throwing', async () => {
    const { engine, runs } = createHarness()
    const result = await engine.run(TEST_DID, {
      mode: 'backfill',
      trigger: 'manual',
      fetcher: async () => {
        throw new Error('AuthenticationRequired')
      },
    })

    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /AuthenticationRequired/)
    assert.equal(runs.latest(TEST_DID)?.status, 'failed')
  })

  it('joins a concurrent run rather than walking the listing twice', async () => {
    const { engine } = createHarness()
    const fetcher = pagedFetcher(
      Array.from({ length: 4 }, (_, i) => bookmarkView({ uri: `at://did:plc:a/app.bsky.feed.post/p${i}` })),
      2,
    )

    const [first, second] = await Promise.all([
      engine.run(TEST_DID, { mode: 'backfill', trigger: 'login', fetcher }),
      engine.run(TEST_DID, { mode: 'backfill', trigger: 'manual', fetcher }),
    ])

    assert.equal(first.id, second.id, 'the second caller joins the job already in flight')
    assert.equal(first.created, 4)
  })
})
