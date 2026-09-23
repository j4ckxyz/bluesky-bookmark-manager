import type { FastifyInstance } from 'fastify'
import { AuthError } from '../atproto/session.ts'
import { IdentityError, providerLabelFor } from '../atproto/identity.ts'
import type { AppContext } from '../context.ts'
import { clearSessionCookie, requireAccount, setSessionCookie, SESSION_COOKIE } from './auth-plugin.ts'

type LoginBody = {
  identifier?: unknown
  password?: unknown
  service?: unknown
  authFactorToken?: unknown
}

/**
 * Per-IP limits for the routes anyone can hit without signing in. Login is
 * tight because each attempt is forwarded to someone's PDS; typeahead fires
 * on keystrokes, so it gets more room.
 */
const LOGIN_LIMIT = { rateLimit: { max: 10, timeWindow: '5 minutes' } }
const RESOLVE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } }
const TYPEAHEAD_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } }

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** What the sign-in screen needs to know before anyone types anything. */
  app.get('/api/v1/instance', async () => {
    const accounts = ctx.accounts.list()
    return {
      multiUser: ctx.config.multiUser,
      claimed: accounts.length > 0,
      openToNewAccounts: ctx.config.multiUser || accounts.length === 0,
      restrictedToHandles: ctx.config.allowedHandles.length > 0 ? ctx.config.allowedHandles : null,
      syncIntervalMinutes: ctx.config.syncIntervalMinutes,
      defaultProvider: providerLabelFor(ctx.config.defaultPdsUrl),
    }
  })

  app.get('/api/v1/auth/session', async (request) => {
    if (!request.account) return { account: null }
    return {
      account: request.account,
      providerLabel: providerLabelFor(request.account.pdsUrl),
      sync: ctx.engine.status(request.account.did),
    }
  })

  app.post<{ Body: LoginBody }>(
    '/api/v1/auth/login',
    { config: LOGIN_LIMIT },
    async (request, reply) => {
      const body = request.body ?? {}
      const identifier = asText(body.identifier)
      const password = asText(body.password)
      const service = asText(body.service)
      const authFactorToken = asText(body.authFactorToken)

      try {
        const result = await ctx.sessions.login({
          identifier,
          password,
          service: service || undefined,
          authFactorToken: authFactorToken || undefined,
        })

        const token = ctx.accounts.createAuthSession(
          result.did,
          ctx.config.sessionTtlDays,
          request.headers['user-agent'] ?? null,
        )
        setSessionCookie(reply, token, ctx)

        // Kick off the first walk immediately; the UI follows it over SSE.
        if (ctx.config.syncOnLogin) {
          const mode = ctx.engine.nextScheduledMode(result.did)
          void ctx.engine
            .run(result.did, { mode, trigger: 'login' })
            .catch((err: unknown) => request.log.error({ err }, 'login sync failed'))
        }

        return {
          account: ctx.accounts.get(result.did),
          providerLabel: result.providerLabel,
          sync: ctx.engine.status(result.did),
        }
      } catch (err) {
        if (err instanceof AuthError) {
          const status = err.code === 'not_allowed' ? 403 : err.code === 'unavailable' ? 502 : 401
          return reply.code(status).send({ error: err.code, message: err.message })
        }
        if (err instanceof IdentityError) {
          return reply.code(400).send({ error: 'identity', message: err.message })
        }
        request.log.error({ err }, 'login failed')
        return reply.code(500).send({ error: 'internal', message: 'Something went wrong signing in.' })
      }
    },
  )

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const cookie = request.cookies[SESSION_COOKIE]
    if (cookie) ctx.accounts.revokeAuthSession(cookie)
    clearSessionCookie(reply)
    return { ok: true }
  })

  /**
   * Signs out everywhere and forgets the stored PDS credentials. The archive
   * is kept, so signing back in resumes rather than re-downloads.
   */
  app.post('/api/v1/auth/disconnect', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return

    await ctx.sessions.logout(account.did)
    ctx.accounts.clearSession(account.did, 'Disconnected')
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/v1/identity/typeahead',
    { config: TYPEAHEAD_LIMIT },
    async (request, reply) => {
      const q = asText(request.query.q)
      if (q.length === 0) return { actors: [] }
      try {
        const limit = Number.parseInt(request.query.limit ?? '8', 10)
        const actors = await ctx.identity.typeahead(q, Number.isFinite(limit) ? limit : 8)
        return { actors }
      } catch (err) {
        request.log.warn({ err }, 'typeahead failed')
        // A directory outage should not block someone from typing their handle.
        return reply.code(200).send({ actors: [], degraded: true })
      }
    },
  )

  /** Resolves a handle to its hosting provider, for the sign-in screen. */
  app.get<{ Querystring: { handle?: string } }>(
    '/api/v1/identity/resolve',
    { config: RESOLVE_LIMIT },
    async (request, reply) => {
      const handle = asText(request.query.handle)
      if (!handle) {
        return reply.code(400).send({ error: 'bad_request', message: 'Pass a handle to resolve.' })
      }
      try {
        return await ctx.identity.resolve(handle)
      } catch (err) {
        if (err instanceof IdentityError) {
          return reply.code(404).send({ error: 'not_found', message: err.message })
        }
        request.log.warn({ err }, 'identity resolution failed')
        return reply.code(502).send({
          error: 'unavailable',
          message: 'Could not reach the directory. Enter a hosting provider manually.',
        })
      }
    },
  )
}
