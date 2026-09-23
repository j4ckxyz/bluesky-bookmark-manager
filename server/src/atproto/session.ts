import { Client } from '@atproto/lex-client'
import { LexAuthFactorError, PasswordSession } from '@atproto/lex-password-session'
import type { SessionData } from '@atproto/lex-password-session'
import type { AccountStore, StoredSession } from '../db/accounts.ts'
import { IdentityError, IdentityResolver, normaliseServiceUrl, providerLabelFor } from './identity.ts'
import type { Config } from '../config.ts'
import { timedFetch } from '../lib/http.ts'

export class AuthError extends Error {
  override name = 'AuthError'
  readonly code: 'invalid_credentials' | 'auth_factor_required' | 'not_allowed' | 'unavailable'

  constructor(
    code: AuthError['code'],
    message: string,
  ) {
    super(message)
    this.code = code
  }
}

export type LoginInput = {
  identifier: string
  password: string
  /** Optional override when auto-resolution picks the wrong host. */
  service?: string | undefined
  authFactorToken?: string | undefined
}

export type LoginResult = {
  did: string
  handle: string
  displayName: string | null
  avatar: string | null
  pdsUrl: string
  providerLabel: string
}

/**
 * Owns every PDS session on the instance: logging in with an app password,
 * resuming persisted sessions on restart, and keeping refreshed tokens
 * encrypted in the database.
 */
export class SessionManager {
  readonly #config: Config
  readonly #accounts: AccountStore
  readonly #identity: IdentityResolver
  /** Live sessions, keyed by DID, so refreshes are shared across requests. */
  readonly #sessions = new Map<string, PasswordSession>()
  /** De-duplicates concurrent resume attempts for the same account. */
  readonly #resuming = new Map<string, Promise<PasswordSession | null>>()

  constructor(config: Config, accounts: AccountStore, identity: IdentityResolver) {
    this.#config = config
    this.#accounts = accounts
    this.#identity = identity
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const identifier = input.identifier.trim().replace(/^@/, '').toLowerCase()
    if (!identifier) throw new AuthError('invalid_credentials', 'Enter your handle')
    if (!input.password) throw new AuthError('invalid_credentials', 'Enter an app password')

    this.#assertAllowed(identifier)

    // An explicit hosting provider skips resolution; otherwise find their PDS.
    let service: string
    let resolvedHandle = identifier
    let displayName: string | null = null
    let avatar: string | null = null
    let profileLoaded = false

    if (input.service) {
      service = normaliseServiceUrl(input.service)
    } else {
      try {
        const identity = await this.#identity.resolve(identifier)
        service = identity.pdsUrl
        resolvedHandle = identity.handle
        displayName = identity.displayName
        avatar = identity.avatar
        profileLoaded = true
      } catch (err) {
        if (err instanceof IdentityError) {
          throw new AuthError('invalid_credentials', err.message)
        }
        throw new AuthError(
          'unavailable',
          'Could not work out where your account is hosted. Set a hosting provider and try again.',
        )
      }
    }

    let session: PasswordSession
    try {
      session = await PasswordSession.login({
        service,
        identifier,
        password: input.password,
        ...(input.authFactorToken ? { authFactorToken: input.authFactorToken } : {}),
        ...this.#sessionHooks(),
      })
    } catch (err) {
      throw toAuthError(err)
    }

    const did = session.did
    this.#assertAllowed(session.handle)

    // Resolution already fetched the profile unless a provider was given; an
    // account with no display name or avatar is common and needs no retry.
    if (!profileLoaded) {
      const profile = await this.#identity.profile(did)
      displayName = profile?.displayName ?? null
      avatar = profile?.avatar ?? null
      resolvedHandle = profile?.handle ?? session.handle
    }

    // Checked after the last await, so the check and the insert below run
    // back to back and two first-time logins cannot both claim the instance.
    this.#assertCapacity(did)
    this.#accounts.upsert({
      did,
      handle: resolvedHandle || session.handle,
      displayName,
      avatar,
      pdsUrl: service,
      session: session.session as StoredSession,
    })

    const previous = this.#sessions.get(did)
    if (previous && previous !== session) this.#sessions.delete(did)
    this.#sessions.set(did, session)

    return {
      did,
      handle: resolvedHandle || session.handle,
      displayName,
      avatar,
      pdsUrl: service,
      providerLabel: providerLabelFor(service),
    }
  }

  /**
   * Returns an authenticated client for an account, resuming the persisted
   * session if this process has not used it yet. Null means the account needs
   * to sign in again.
   */
  async clientFor(did: string): Promise<Client | null> {
    const session = await this.#sessionFor(did)
    return session ? new Client(session) : null
  }

  async #sessionFor(did: string): Promise<PasswordSession | null> {
    const live = this.#sessions.get(did)
    if (live && !live.destroyed) return live

    const inFlight = this.#resuming.get(did)
    if (inFlight) return inFlight

    const attempt = this.#resume(did).finally(() => this.#resuming.delete(did))
    this.#resuming.set(did, attempt)
    return attempt
  }

  async #resume(did: string): Promise<PasswordSession | null> {
    const stored = this.#accounts.loadSession(did)
    if (!stored) return null

    try {
      const session = await PasswordSession.resume(stored as SessionData, this.#sessionHooks())
      this.#sessions.set(did, session)
      return session
    } catch {
      // resume() only rejects when the session is definitively dead.
      this.#accounts.clearSession(did, 'Sign-in expired — log in again to resume syncing')
      this.#sessions.delete(did)
      return null
    }
  }

  async logout(did: string): Promise<void> {
    const session = this.#sessions.get(did)
    this.#sessions.delete(did)
    if (session && !session.destroyed) {
      await session.logout().catch(() => undefined)
      return
    }
    const stored = this.#accounts.loadSession(did)
    if (stored) {
      await PasswordSession.delete(stored as SessionData).catch(() => undefined)
    }
  }

  /** Forgets in-memory sessions; used on shutdown. */
  dispose(): void {
    this.#sessions.clear()
  }

  #sessionHooks() {
    const accounts = this.#accounts
    return {
      fetch: timedFetch,
      onUpdated(this: PasswordSession, data: SessionData) {
        accounts.saveSession(data.did, data as StoredSession)
      },
      onDeleted(this: PasswordSession, data: SessionData) {
        accounts.clearSession(data.did, 'Sign-in expired — log in again to resume syncing')
      },
    }
  }

  #assertAllowed(handle: string): void {
    const allowed = this.#config.allowedHandles
    if (allowed.length === 0) return
    if (!allowed.includes(handle.toLowerCase().replace(/^@/, ''))) {
      throw new AuthError('not_allowed', 'This instance is not open to that account.')
    }
  }

  /** Single-user instances accept exactly one identity unless MULTI_USER is on. */
  #assertCapacity(did: string): void {
    if (this.#config.multiUser) return
    const existing = this.#accounts.list()
    if (existing.length === 0) return
    if (existing.some((account) => account.did === did)) return
    throw new AuthError(
      'not_allowed',
      'This instance is already claimed by another account. Set MULTI_USER=true to allow more.',
    )
  }
}

function toAuthError(err: unknown): AuthError {
  if (err instanceof LexAuthFactorError) {
    return new AuthError(
      'auth_factor_required',
      'Enter the confirmation code your provider emailed you.',
    )
  }

  const message = err instanceof Error ? err.message : String(err)
  if (/AuthenticationRequired|Invalid identifier or password|401/i.test(message)) {
    return new AuthError(
      'invalid_credentials',
      'That handle and app password did not work. App passwords look like xxxx-xxxx-xxxx-xxxx.',
    )
  }
  if (/AccountTakedown/i.test(message)) {
    return new AuthError('not_allowed', 'That account has been suspended by its provider.')
  }
  if (/RateLimitExceeded|429/i.test(message)) {
    return new AuthError('unavailable', 'Your provider is rate limiting sign-ins. Try again shortly.')
  }
  return new AuthError('unavailable', `Could not reach your hosting provider: ${message}`)
}
