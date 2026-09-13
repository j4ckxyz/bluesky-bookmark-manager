import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.ts'
import type { AccountRecord } from '../types.ts'

export const SESSION_COOKIE = 'bskybm_session'

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in account, set by {@link requireAccount}. */
    account: AccountRecord | null
  }
}

/**
 * Resolves the caller from either the browser session cookie or an
 * `Authorization: Bearer` API token, and exposes `requireAccount`.
 */
export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('account', null)

  app.addHook('onRequest', async (request) => {
    request.account = resolveAccount(request, ctx)
  })
}

function resolveAccount(request: FastifyRequest, ctx: AppContext): AccountRecord | null {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    if (token) return ctx.accounts.resolveApiToken(token)
  }

  const cookie = request.cookies[SESSION_COOKIE]
  if (cookie) return ctx.accounts.resolveAuthSession(cookie)

  return null
}

/**
 * Guards a route. Returns the account, or replies 401 and returns null —
 * callers must return immediately when it returns null.
 */
export function requireAccount(
  request: FastifyRequest,
  reply: FastifyReply,
): AccountRecord | null {
  if (request.account) return request.account
  void reply.code(401).send({
    error: 'unauthorised',
    message: 'Sign in, or send an API token as `Authorization: Bearer <token>`.',
  })
  return null
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  ctx: AppContext,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    maxAge: ctx.config.sessionTtlDays * 86_400,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}
