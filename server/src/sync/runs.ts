import type { Db } from '../db/index.ts'
import type { SyncMode, SyncRun, SyncStatus, SyncTrigger } from '../types.ts'

type RunRow = {
  id: number
  did: string
  mode: string
  trigger: string
  status: string
  started_at: string
  finished_at: string | null
  pages: number
  scanned: number
  created: number
  updated: number
  removed: number
  restored: number
  error: string | null
}

const toRun = (row: RunRow): SyncRun => ({
  id: row.id,
  did: row.did,
  mode: row.mode as SyncMode,
  trigger: row.trigger as SyncTrigger,
  status: row.status as SyncStatus,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  pages: row.pages,
  scanned: row.scanned,
  created: row.created,
  updated: row.updated,
  removed: row.removed,
  restored: row.restored,
  error: row.error,
})

export class SyncRunStore {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  start(did: string, mode: SyncMode, trigger: SyncTrigger): SyncRun {
    const startedAt = new Date().toISOString()
    const result = this.#db
      .prepare(
        `INSERT INTO sync_runs (did, mode, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(did, mode, trigger, startedAt)
    return {
      id: Number(result.lastInsertRowid),
      did,
      mode,
      trigger,
      status: 'running',
      startedAt,
      finishedAt: null,
      pages: 0,
      scanned: 0,
      created: 0,
      updated: 0,
      removed: 0,
      restored: 0,
      error: null,
    }
  }

  update(run: SyncRun): void {
    this.#db
      .prepare(
        `UPDATE sync_runs SET
           status = @status, finished_at = @finishedAt, pages = @pages, scanned = @scanned,
           created = @created, updated = @updated, removed = @removed, restored = @restored,
           error = @error
         WHERE id = @id`,
      )
      .run({
        id: run.id,
        status: run.status,
        finishedAt: run.finishedAt,
        pages: run.pages,
        scanned: run.scanned,
        created: run.created,
        updated: run.updated,
        removed: run.removed,
        restored: run.restored,
        error: run.error,
      })
  }

  latest(did: string): SyncRun | null {
    const row = this.#db
      .prepare('SELECT * FROM sync_runs WHERE did = ? ORDER BY started_at DESC, id DESC LIMIT 1')
      .get(did) as RunRow | undefined
    return row ? toRun(row) : null
  }

  history(did: string, limit = 20): SyncRun[] {
    const rows = this.#db
      .prepare('SELECT * FROM sync_runs WHERE did = ? ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(did, limit) as RunRow[]
    return rows.map(toRun)
  }

  /**
   * A process that dies mid-sync leaves a `running` row behind. Clearing them
   * on boot stops the UI from waiting forever on a job that will never finish.
   */
  failStale(): number {
    const result = this.#db
      .prepare(
        `UPDATE sync_runs SET status = 'failed', finished_at = ?, error = 'Interrupted by a server restart'
         WHERE status = 'running'`,
      )
      .run(new Date().toISOString())
    return result.changes
  }
}
