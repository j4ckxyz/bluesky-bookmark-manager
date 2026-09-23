import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadConfig } from './config.ts'

/**
 * Takes a consistent copy of the database while the server keeps running.
 * A plain `cp` of a WAL-mode database can miss writes still in the -wal file;
 * SQLite's online backup API cannot.
 *
 *   node server/dist/backup.js [destination.db]
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = resolve(process.argv[2] ?? join(config.dataDir, 'backups', `bookmarks-${stamp}.db`))
  mkdirSync(dirname(destination), { recursive: true })

  const db = new Database(config.databasePath, { readonly: true, fileMustExist: true })
  try {
    await db.backup(destination)
  } finally {
    db.close()
  }
  console.log(destination)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
