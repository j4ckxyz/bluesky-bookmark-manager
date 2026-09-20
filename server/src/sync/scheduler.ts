import type { Config } from '../config.ts'
import type { AccountStore } from '../db/accounts.ts'
import type { SyncEngine } from './engine.ts'

/**
 * Drives periodic syncing. Every tick (10 minutes by default) each signed-in
 * account gets a pass: usually a quick one that stops as soon as it has caught
 * up, and every Nth tick a full walk that also reconciles removals.
 */
export class SyncScheduler {
  readonly #config: Config
  readonly #accounts: AccountStore
  readonly #engine: SyncEngine
  readonly #log: (msg: string, extra?: Record<string, unknown>) => void
  #timer: NodeJS.Timeout | null = null
  #ticking = false

  constructor(options: {
    config: Config
    accounts: AccountStore
    engine: SyncEngine
    log?: (msg: string, extra?: Record<string, unknown>) => void
  }) {
    this.#config = options.config
    this.#accounts = options.accounts
    this.#engine = options.engine
    this.#log = options.log ?? (() => undefined)
  }

  start(): void {
    if (this.#timer) return
    if (!this.#config.syncEnabled) {
      this.#log('sync scheduler disabled by configuration')
      return
    }
    const intervalMs = Math.max(1, this.#config.syncIntervalMinutes) * 60_000

    this.#timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
    // A pending sync should never hold the process open on shutdown.
    this.#timer.unref?.()

    this.#log('sync scheduler started', { everyMinutes: this.#config.syncIntervalMinutes })
  }

  stop(): void {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  /** Runs one scheduling pass. Exposed for tests and the manual refresh route. */
  async tick(): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      this.#accounts.pruneExpiredSessions()
      for (const account of this.#accounts.syncable()) {
        if (this.#engine.isRunning(account.did)) continue
        const mode = this.#engine.nextScheduledMode(account.did)
        try {
          await this.#engine.run(account.did, { mode, trigger: 'schedule' })
        } catch (err) {
          this.#log('scheduled sync threw', {
            did: account.did,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } finally {
      this.#ticking = false
    }
  }
}
