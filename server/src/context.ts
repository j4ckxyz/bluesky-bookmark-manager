import type { Config } from './config.ts'
import { AccountStore } from './db/accounts.ts'
import { BookmarkStore } from './db/bookmarks.ts'
import { openDatabase, type Db } from './db/index.ts'
import { IdentityResolver } from './atproto/identity.ts'
import { SessionManager } from './atproto/session.ts'
import { SearchService } from './search/search.ts'
import { SyncEngine } from './sync/engine.ts'
import { SyncRunStore } from './sync/runs.ts'
import { SyncScheduler } from './sync/scheduler.ts'

/** Everything the HTTP layer needs, wired once at boot. */
export type AppContext = {
  config: Config
  db: Db
  accounts: AccountStore
  bookmarks: BookmarkStore
  runs: SyncRunStore
  search: SearchService
  identity: IdentityResolver
  sessions: SessionManager
  engine: SyncEngine
  scheduler: SyncScheduler
  close: () => void
}

export function createContext(
  config: Config,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
): AppContext {
  const db = openDatabase(config.databasePath)
  const accounts = new AccountStore(db, config.encryptionKey)
  const bookmarks = new BookmarkStore(db)
  const runs = new SyncRunStore(db)
  const search = new SearchService(db, bookmarks)
  const identity = new IdentityResolver(config)
  const sessions = new SessionManager(config, accounts, identity)

  const engine = new SyncEngine({
    config,
    accounts,
    bookmarks,
    runs,
    clientFor: (did) => sessions.clientFor(did),
    log,
  })

  const scheduler = new SyncScheduler({ config, accounts, engine, log })

  // A crash mid-sync leaves a `running` row behind; clear it so the UI does
  // not sit on a progress bar that will never move.
  const stale = runs.failStale()
  if (stale > 0) log('cleared interrupted sync runs', { count: stale })

  return {
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
    close: () => {
      scheduler.stop()
      sessions.dispose()
      db.close()
    },
  }
}
