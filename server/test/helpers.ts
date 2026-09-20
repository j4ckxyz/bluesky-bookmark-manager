import { randomBytes } from 'node:crypto'
import { AccountStore } from '../src/db/accounts.ts'
import { BookmarkStore } from '../src/db/bookmarks.ts'
import { openDatabase, type Db } from '../src/db/index.ts'
import { SyncEngine } from '../src/sync/engine.ts'
import { SyncRunStore } from '../src/sync/runs.ts'
import type { Config } from '../src/config.ts'

export const TEST_DID = 'did:plc:testowner'

/** A config object with production defaults, overridable per test. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = {
    port: 0,
    host: '127.0.0.1',
    publicUrl: 'http://localhost:8787',
    dataDir: '/tmp',
    databasePath: ':memory:',
    encryptionKey: randomBytes(32),
    webDir: '/tmp/web',
    serveWeb: false,
    appviewUrl: 'https://public.api.bsky.app',
    plcDirectoryUrl: 'https://plc.directory',
    defaultPdsUrl: 'https://bsky.social',
    syncIntervalMinutes: 10,
    fullSyncEvery: 6,
    syncPageSize: 100,
    quickSyncStablePages: 2,
    syncPageDelayMs: 0,
    syncOnLogin: true,
    syncEnabled: true,
    purgeRemovedAfterDays: 0,
    multiUser: false,
    allowedHandles: [] as string[],
    sessionTtlDays: 30,
    secureCookies: false,
    trustProxy: false,
    logLevel: 'silent',
  } satisfies Config
  return { ...base, ...overrides }
}

export type TestHarness = {
  db: Db
  config: Config
  accounts: AccountStore
  bookmarks: BookmarkStore
  runs: SyncRunStore
  engine: SyncEngine
}

/** Spins up an in-memory instance with one signed-in account. */
export function createHarness(overrides: Partial<Config> = {}): TestHarness {
  const config = testConfig(overrides)
  const db = openDatabase(':memory:')
  const accounts = new AccountStore(db, config.encryptionKey)
  const bookmarks = new BookmarkStore(db)
  const runs = new SyncRunStore(db)

  accounts.upsert({
    did: TEST_DID,
    handle: 'owner.bsky.social',
    displayName: 'Owner',
    avatar: null,
    pdsUrl: 'https://bsky.social',
    session: {
      did: TEST_DID,
      handle: 'owner.bsky.social',
      accessJwt: 'access',
      refreshJwt: 'refresh',
      service: 'https://bsky.social',
    },
  })

  const engine = new SyncEngine({
    config,
    accounts,
    bookmarks,
    runs,
    clientFor: async () => null,
  })

  return { db, config, accounts, bookmarks, runs, engine }
}
