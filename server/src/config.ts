import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** Repo root when running from `src/`, and also when running from `dist/`. */
const serverRoot = resolve(here, '..')

function str(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function int(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(v)}`)
  return n
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

function list(name: string): string[] {
  const v = process.env[name]
  if (!v) return []
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

function resolvePath(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p)
}

/**
 * The encryption key protects PDS refresh tokens at rest. A caller-supplied
 * `ENCRYPTION_KEY` always wins; otherwise we generate one and keep it beside
 * the database so that restarts do not invalidate every stored session.
 */
function loadEncryptionKey(dataDir: string): Buffer {
  const provided = process.env['ENCRYPTION_KEY']
  if (provided) {
    const key = decodeKey(provided)
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must decode to 32 bytes (hex or base64)')
    }
    return key
  }

  const keyFile = join(dataDir, 'encryption.key')
  if (existsSync(keyFile)) {
    return decodeKey(readFileSync(keyFile, 'utf8').trim())
  }

  const key = randomBytes(32)
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  return key
}

function decodeKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex')
  return Buffer.from(value, 'base64')
}

export type Config = ReturnType<typeof loadConfig>

export function loadConfig() {
  const dataDir = resolvePath(str('DATA_DIR', './data'), process.cwd())
  mkdirSync(dataDir, { recursive: true })

  const publicUrl = str('PUBLIC_URL', '')
  const port = int('PORT', 8787)

  return {
    port,
    host: str('HOST', '0.0.0.0'),
    publicUrl: publicUrl || `http://localhost:${port}`,
    dataDir,
    databasePath: resolvePath(str('DATABASE_PATH', join(dataDir, 'bookmarks.db')), dataDir),
    encryptionKey: loadEncryptionKey(dataDir),

    /** Where the built front end lives. Serving it is optional. */
    webDir: resolvePath(str('WEB_DIR', join(serverRoot, '..', 'web', 'dist')), serverRoot),
    serveWeb: bool('SERVE_WEB', true),

    /** Public AppView, used unauthenticated for handle typeahead and profiles. */
    appviewUrl: str('APPVIEW_URL', 'https://public.api.bsky.app'),
    plcDirectoryUrl: str('PLC_DIRECTORY_URL', 'https://plc.directory'),
    defaultPdsUrl: str('DEFAULT_PDS_URL', 'https://bsky.social'),

    /** Sync cadence. A "quick" pass stops early; every Nth pass is a full reconcile. */
    syncIntervalMinutes: int('SYNC_INTERVAL_MINUTES', 10),
    fullSyncEvery: int('FULL_SYNC_EVERY', 6),
    syncPageSize: Math.min(100, Math.max(1, int('SYNC_PAGE_SIZE', 100))),
    /** Consecutive already-known pages before a quick sync gives up early. */
    quickSyncStablePages: int('QUICK_SYNC_STABLE_PAGES', 2),
    /** Pause between backfill pages, so a large archive stays a polite guest. */
    syncPageDelayMs: int('SYNC_PAGE_DELAY_MS', 120),
    syncOnLogin: bool('SYNC_ON_LOGIN', true),
    /** Turns off the background scheduler. Manual syncs still work. */
    syncEnabled: bool('SYNC_ENABLED', true),
    /** Purge soft-deleted bookmarks after this many days. 0 keeps them forever. */
    purgeRemovedAfterDays: int('PURGE_REMOVED_AFTER_DAYS', 0),

    /** Single-user by default: the first account to log in claims the instance. */
    multiUser: bool('MULTI_USER', false),
    allowedHandles: list('ALLOWED_HANDLES'),

    sessionTtlDays: int('SESSION_TTL_DAYS', 30),
    /**
     * Requests per minute per token on the agent API. Generous by default: it
     * is your own server, and an agent paging through a large archive should
     * not stall. Lower it if you expose the instance to the internet.
     */
    agentRateLimitPerMinute: Math.max(1, int('AGENT_RATE_LIMIT_PER_MINUTE', 600)),
    secureCookies: bool('SECURE_COOKIES', publicUrl.startsWith('https://')),
    trustProxy: bool('TRUST_PROXY', false),
    logLevel: str('LOG_LEVEL', 'info'),
  }
}
