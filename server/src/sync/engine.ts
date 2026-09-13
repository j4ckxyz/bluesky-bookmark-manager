import { EventEmitter } from 'node:events'
import type { Client } from '@atproto/lex-client'
import { app } from '@bsky/sdk/lexicons'
import type { Config } from '../config.ts'
import type { AccountStore } from '../db/accounts.ts'
import type { BookmarkStore } from '../db/bookmarks.ts'
import { extractMetadata } from '../metadata.ts'
import type { SyncMode, SyncRun, SyncTrigger } from '../types.ts'
import { SyncRunStore } from './runs.ts'

export type BookmarkPage = { bookmarks: unknown[]; cursor?: string | undefined }

/**
 * Fetches one page of bookmarks. Injectable so the engine can be exercised
 * against fixtures without touching the network.
 */
export type BookmarkPageFetcher = (params: {
  cursor?: string | undefined
  limit: number
}) => Promise<BookmarkPage>

/** Live view of a sync job, including the run currently in flight. */
export type SyncProgress = SyncRun & {
  /** Total bookmarks stored for the account right now. */
  totalStored: number
  /** True while the job is running; drives the progress bar in the UI. */
  active: boolean
}

export type RunOptions = {
  mode?: SyncMode
  trigger?: SyncTrigger
  /** Overrides the live PDS fetcher. Used by tests. */
  fetcher?: BookmarkPageFetcher
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wraps a live client as a page fetcher over `app.bsky.bookmark.getBookmarks`. */
export function createBookmarkFetcher(client: Client): BookmarkPageFetcher {
  return async ({ cursor, limit }) => {
    const result = await client.call(app.bsky.bookmark.getBookmarks, {
      limit,
      ...(cursor ? { cursor } : {}),
    })
    return { bookmarks: result.bookmarks as unknown[], cursor: result.cursor }
  }
}

export interface SyncEngineEvents {
  progress: [SyncProgress]
}

/**
 * Walks a PDS's bookmark listing and reconciles it into local storage.
 *
 * Three modes:
 * - `backfill`  — the first full walk after signing in.
 * - `quick`     — the every-few-minutes pass; stops once it has seen enough
 *                 consecutive already-known pages to be sure it has caught up.
 * - `full`      — a complete walk that also detects bookmarks removed
 *                 on the Bluesky side and soft-deletes them locally.
 */
export class SyncEngine extends EventEmitter<SyncEngineEvents> {
  readonly #config: Config
  readonly #accounts: AccountStore
  readonly #bookmarks: BookmarkStore
  readonly #runs: SyncRunStore
  readonly #clientFor: (did: string) => Promise<Client | null>
  readonly #log: (msg: string, extra?: Record<string, unknown>) => void

  readonly #active = new Map<string, SyncProgress>()
  readonly #inFlight = new Map<string, Promise<SyncProgress>>()
  readonly #cancelled = new Set<string>()

  constructor(options: {
    config: Config
    accounts: AccountStore
    bookmarks: BookmarkStore
    runs: SyncRunStore
    clientFor: (did: string) => Promise<Client | null>
    log?: (msg: string, extra?: Record<string, unknown>) => void
  }) {
    super()
    this.#config = options.config
    this.#accounts = options.accounts
    this.#bookmarks = options.bookmarks
    this.#runs = options.runs
    this.#clientFor = options.clientFor
    this.#log = options.log ?? (() => undefined)
  }

  isRunning(did: string): boolean {
    return this.#inFlight.has(did)
  }

  /** Current job if one is running, otherwise the last finished one. */
  status(did: string): SyncProgress | null {
    const active = this.#active.get(did)
    if (active) return active
    const last = this.#runs.latest(did)
    if (!last) return null
    return { ...last, totalStored: this.#bookmarks.countActive(did), active: false }
  }

  cancel(did: string): boolean {
    if (!this.#inFlight.has(did)) return false
    this.#cancelled.add(did)
    return true
  }

  /** Picks the mode for a scheduled pass. */
  nextScheduledMode(did: string): SyncMode {
    const account = this.#accounts.get(did)
    if (!account?.backfillCompletedAt) return 'backfill'
    const counter = this.#accounts.syncCounter(did)
    const every = Math.max(1, this.#config.fullSyncEvery)
    return counter % every === 0 ? 'full' : 'quick'
  }

  /**
   * Runs a sync. Concurrent calls for the same account join the job already
   * in flight rather than starting a second walk over the same listing.
   */
  async run(did: string, options: RunOptions = {}): Promise<SyncProgress> {
    const existing = this.#inFlight.get(did)
    if (existing) return existing

    const job = this.#execute(did, options).finally(() => {
      this.#inFlight.delete(did)
      this.#cancelled.delete(did)
    })
    this.#inFlight.set(did, job)
    return job
  }

  async #execute(did: string, options: RunOptions): Promise<SyncProgress> {
    const mode = options.mode ?? this.nextScheduledMode(did)
    const trigger = options.trigger ?? 'manual'

    const run = this.#runs.start(did, mode, trigger)
    let progress: SyncProgress = {
      ...run,
      totalStored: this.#bookmarks.countActive(did),
      active: true,
    }
    this.#publish(did, progress)

    const fetcher = options.fetcher ?? (await this.#liveFetcher(did))
    if (!fetcher) {
      progress = this.#finish(did, progress, 'failed', 'Not signed in to your hosting provider')
      return progress
    }

    // Every row touched by this run is stamped with the run id, so anything
    // left unstamped afterwards is provably absent from the remote listing.
    const seenAt = new Date().toISOString()
    const runId = run.id
    const limit = this.#config.syncPageSize
    const isFullWalk = mode === 'backfill' || mode === 'full'

    let cursor: string | undefined
    let sortIndex = 0
    let stablePages = 0
    let completedWalk = false

    try {
      for (;;) {
        if (this.#cancelled.has(did)) {
          progress = this.#finish(did, progress, 'cancelled', null)
          return progress
        }

        const page = await this.#fetchWithRetry(fetcher, { cursor, limit })
        progress.pages += 1

        let newOnPage = 0
        for (const view of page.bookmarks) {
          const meta = extractMetadata(view)
          if (!meta) continue
          const outcome = this.#bookmarks.upsert(did, meta, {
            seenAt,
            runId,
            sortIndex: sortIndex++,
            raw: view,
          })
          progress.scanned += 1
          if (outcome === 'created') {
            progress.created += 1
            newOnPage += 1
          } else if (outcome === 'restored') {
            progress.restored += 1
            newOnPage += 1
          } else {
            progress.updated += 1
          }
        }

        progress.totalStored = this.#bookmarks.countActive(did)
        this.#publish(did, progress)

        cursor = page.cursor
        if (!cursor || page.bookmarks.length === 0) {
          completedWalk = true
          break
        }

        // A quick pass only needs to reach the point where everything is
        // already known; the periodic full pass handles the rest.
        if (!isFullWalk) {
          stablePages = newOnPage === 0 ? stablePages + 1 : 0
          if (stablePages >= Math.max(1, this.#config.quickSyncStablePages)) break
        }

        if (mode === 'backfill' && this.#config.syncPageDelayMs > 0) {
          await sleep(this.#config.syncPageDelayMs)
        }
      }

      // Only a complete walk proves a bookmark is gone.
      if (isFullWalk && completedWalk) {
        progress.removed = this.#bookmarks.markMissingAsRemoved(did, runId, new Date().toISOString())
        if (this.#config.purgeRemovedAfterDays > 0) {
          this.#bookmarks.purgeRemoved(did, this.#config.purgeRemovedAfterDays)
        }
      }

      progress.totalStored = this.#bookmarks.countActive(did)
      progress = this.#finish(did, progress, 'completed', null, isFullWalk && completedWalk)
      this.#log('sync completed', {
        did,
        mode,
        scanned: progress.scanned,
        created: progress.created,
        removed: progress.removed,
      })
      return progress
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.#log('sync failed', { did, mode, error: message })
      progress = this.#finish(did, progress, 'failed', message)
      return progress
    }
  }

  async #liveFetcher(did: string): Promise<BookmarkPageFetcher | null> {
    const client = await this.#clientFor(did)
    return client ? createBookmarkFetcher(client) : null
  }

  /** Retries transient page failures; a rate limit is worth waiting out. */
  async #fetchWithRetry(
    fetcher: BookmarkPageFetcher,
    params: { cursor?: string | undefined; limit: number },
    attempts = 3,
  ): Promise<BookmarkPage> {
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fetcher(params)
      } catch (err) {
        lastError = err
        const message = err instanceof Error ? err.message : String(err)
        // Credential failures will not fix themselves; stop immediately.
        if (/AuthenticationRequired|ExpiredToken|InvalidToken|401|403/i.test(message)) throw err
        if (attempt === attempts - 1) break
        await sleep(1000 * 2 ** attempt)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  #finish(
    did: string,
    progress: SyncProgress,
    status: SyncProgress['status'],
    error: string | null,
    backfillCompleted = false,
  ): SyncProgress {
    const finished: SyncProgress = {
      ...progress,
      status,
      error,
      finishedAt: new Date().toISOString(),
      active: false,
    }
    this.#runs.update(finished)
    this.#accounts.markSync(did, status === 'completed' ? 'ok' : (error ?? status), backfillCompleted)
    this.#active.delete(did)
    this.emit('progress', finished)
    return finished
  }

  /**
   * Publishes progress to listeners and checkpoints it to the database, so a
   * long backfill still reports sensible numbers after a page reload.
   */
  #publish(did: string, progress: SyncProgress): void {
    this.#active.set(did, progress)
    this.#runs.update(progress)
    this.emit('progress', { ...progress })
  }
}
