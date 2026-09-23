import type { Db } from './index.ts'
import type { AccountRecord } from '../types.ts'
import { decryptJson, encryptJson, generateToken, hashToken } from '../lib/crypto.ts'

type AccountRow = {
  did: string
  handle: string
  display_name: string | null
  avatar: string | null
  pds_url: string
  session_blob: string | null
  is_owner: number
  disabled: number
  created_at: string
  updated_at: string
  last_sync_at: string | null
  last_sync_status: string | null
  backfill_completed_at: string | null
  sync_counter: number
}

export type StoredSession = {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
  service: string
  [key: string]: unknown
}

export function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    did: row.did,
    handle: row.handle,
    displayName: row.display_name,
    avatar: row.avatar,
    pdsUrl: row.pds_url,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    backfillCompletedAt: row.backfill_completed_at,
  }
}

export class AccountStore {
  readonly #db: Db
  readonly #key: Buffer

  constructor(db: Db, encryptionKey: Buffer) {
    this.#db = db
    this.#key = encryptionKey
  }

  count(): number {
    const row = this.#db.prepare('SELECT count(*) AS c FROM accounts').get() as { c: number }
    return row.c
  }

  list(): AccountRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM accounts ORDER BY created_at ASC')
      .all() as AccountRow[]
    return rows.map(toAccountRecord)
  }

  get(did: string): AccountRecord | null {
    const row = this.#db.prepare('SELECT * FROM accounts WHERE did = ?').get(did) as
      | AccountRow
      | undefined
    return row ? toAccountRecord(row) : null
  }

  /** Creates or refreshes an account row and stores its encrypted PDS session. */
  upsert(input: {
    did: string
    handle: string
    displayName: string | null
    avatar: string | null
    pdsUrl: string
    session: StoredSession
  }): AccountRecord {
    const now = new Date().toISOString()
    const blob = encryptJson(this.#key, input.session)

    this.#db
      .prepare(
        `INSERT INTO accounts (did, handle, display_name, avatar, pds_url, session_blob, is_owner, created_at, updated_at)
         VALUES (@did, @handle, @displayName, @avatar, @pdsUrl, @blob,
                 (SELECT count(*) = 0 FROM accounts), @now, @now)
         ON CONFLICT(did) DO UPDATE SET
           handle       = excluded.handle,
           display_name = excluded.display_name,
           avatar       = excluded.avatar,
           pds_url      = excluded.pds_url,
           session_blob = excluded.session_blob,
           disabled     = 0,
           updated_at   = excluded.updated_at`,
      )
      .run({
        did: input.did,
        handle: input.handle,
        displayName: input.displayName,
        avatar: input.avatar,
        pdsUrl: input.pdsUrl,
        blob,
        now,
      })

    return this.get(input.did)!
  }

  /** Persists refreshed tokens without touching the rest of the profile. */
  saveSession(did: string, session: StoredSession): void {
    this.#db
      .prepare('UPDATE accounts SET session_blob = ?, updated_at = ? WHERE did = ?')
      .run(encryptJson(this.#key, session), new Date().toISOString(), did)
  }

  loadSession(did: string): StoredSession | null {
    const row = this.#db.prepare('SELECT session_blob FROM accounts WHERE did = ?').get(did) as
      | { session_blob: string | null }
      | undefined
    if (!row?.session_blob) return null
    return decryptJson<StoredSession>(this.#key, row.session_blob)
  }

  /** Called when the PDS tells us the refresh token is dead. */
  clearSession(did: string, reason = 'session expired'): void {
    this.#db
      .prepare(
        'UPDATE accounts SET session_blob = NULL, disabled = 1, last_sync_status = ?, updated_at = ? WHERE did = ?',
      )
      .run(reason, new Date().toISOString(), did)
    this.#db.prepare('DELETE FROM auth_sessions WHERE did = ?').run(did)
  }

  isDisabled(did: string): boolean {
    const row = this.#db.prepare('SELECT disabled FROM accounts WHERE did = ?').get(did) as
      | { disabled: number }
      | undefined
    return row?.disabled === 1
  }

  markSync(did: string, status: string, backfillCompleted: boolean): void {
    const now = new Date().toISOString()
    this.#db
      .prepare(
        `UPDATE accounts
         SET last_sync_at = ?, last_sync_status = ?, sync_counter = sync_counter + 1,
             backfill_completed_at = CASE WHEN ? = 1 AND backfill_completed_at IS NULL THEN ? ELSE backfill_completed_at END,
             updated_at = ?
         WHERE did = ?`,
      )
      .run(now, status, backfillCompleted ? 1 : 0, now, now, did)
  }

  syncCounter(did: string): number {
    const row = this.#db.prepare('SELECT sync_counter FROM accounts WHERE did = ?').get(did) as
      | { sync_counter: number }
      | undefined
    return row?.sync_counter ?? 0
  }

  /** Accounts eligible for scheduled syncing. */
  syncable(): AccountRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM accounts WHERE disabled = 0 AND session_blob IS NOT NULL')
      .all() as AccountRow[]
    return rows.map(toAccountRecord)
  }

  delete(did: string): void {
    this.#db.prepare('DELETE FROM accounts WHERE did = ?').run(did)
  }

  // --- browser sessions -----------------------------------------------------

  createAuthSession(did: string, ttlDays: number, userAgent: string | null): string {
    const token = generateToken()
    const now = new Date()
    const expires = new Date(now.getTime() + ttlDays * 86_400_000)
    this.#db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, did, created_at, expires_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), did, now.toISOString(), expires.toISOString(), now.toISOString(), userAgent)
    return token
  }

  resolveAuthSession(token: string): AccountRecord | null {
    const now = new Date().toISOString()
    const row = this.#db
      .prepare(
        `SELECT a.* FROM auth_sessions s
         JOIN accounts a ON a.did = s.did
         WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = 0`,
      )
      .get(hashToken(token), now) as AccountRow | undefined
    if (!row) return null
    this.#db
      .prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(now, hashToken(token))
    return toAccountRecord(row)
  }

  revokeAuthSession(token: string): void {
    this.#db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token))
  }

  pruneExpiredSessions(): void {
    this.#db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString())
  }

  // --- API tokens -----------------------------------------------------------

  createApiToken(did: string, name: string): { token: string; hint: string; createdAt: string } {
    const token = generateToken(24)
    const hint = `${token.slice(0, 6)}…${token.slice(-4)}`
    const createdAt = new Date().toISOString()
    this.#db
      .prepare(
        'INSERT INTO api_tokens (token_hash, did, name, hint, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hashToken(token), did, name, hint, createdAt)
    return { token, hint, createdAt }
  }

  listApiTokens(did: string): Array<{
    name: string
    hint: string
    createdAt: string
    lastUsedAt: string | null
  }> {
    const rows = this.#db
      .prepare(
        'SELECT name, hint, created_at, last_used_at FROM api_tokens WHERE did = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      )
      .all(did) as Array<{
      name: string
      hint: string
      created_at: string
      last_used_at: string | null
    }>
    return rows.map((r) => ({
      name: r.name,
      hint: r.hint,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }))
  }

  resolveApiToken(token: string): AccountRecord | null {
    const hash = hashToken(token)
    const row = this.#db
      .prepare(
        `SELECT a.* FROM api_tokens t
         JOIN accounts a ON a.did = t.did
         WHERE t.token_hash = ? AND t.revoked_at IS NULL AND a.disabled = 0`,
      )
      .get(hash) as AccountRow | undefined
    if (!row) return null
    this.#db
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?')
      .run(new Date().toISOString(), hash)
    return toAccountRecord(row)
  }

  revokeApiToken(did: string, hint: string): boolean {
    const result = this.#db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE did = ? AND hint = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), did, hint)
    return result.changes > 0
  }
}
