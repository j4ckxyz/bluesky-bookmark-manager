import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './schema.ts'
import { damerauLevenshtein } from '../lib/fuzzy.ts'
import { urlKey } from '../lib/url.ts'

export type Db = Database.Database

/**
 * Opens (and migrates) the bookmark database.
 * Pass `:memory:` for tests.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  registerFunctions(db)
  migrate(db)
  return db
}

/**
 * SQL helpers used by fuzzy search. Registering them here keeps ranking logic
 * in one place instead of pulling every candidate row into JavaScript.
 */
function registerFunctions(db: Db): void {
  db.function('edit_distance', { deterministic: true }, (a: unknown, b: unknown) => {
    if (typeof a !== 'string' || typeof b !== 'string') return 99
    return damerauLevenshtein(a, b)
  })
  // Lets "is this exact link saved?" ignore scheme, `www.`, trailing slashes
  // and tracking parameters without storing a second copy of every URL.
  db.function('url_key', { deterministic: true }, (url: unknown) =>
    typeof url === 'string' ? urlKey(url) : null,
  )
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((r) => (r as { name: string }).name),
  )

  const record = db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue
    db.transaction(() => {
      db.exec(migration.sql)
      record.run(migration.name, new Date().toISOString())
    })()
  }
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}
