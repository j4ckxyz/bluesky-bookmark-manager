import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.ts'
import type { ApiGrant } from '../db/accounts.ts'
import type { AccountRecord } from '../types.ts'

export const SESSION_COOKIE = 'bskybm_session'

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in account, set by {@link requireAccount}. */
    account: AccountRecord | null
    /** The API token behind this request, when it used one. */
    apiGrant: ApiGrant | null
    /** True when a bearer token was sent but is unknown, revoked or expired. */
    badToken: boolean
  }
}

/** Routes an `agent`-scoped token may reach. Everything else is refused. */
export const AGENT_API_PREFIX = '/api/agent/v1'

/**
 * Resolves the caller from either the browser session cookie or an
 * `Authorization: Bearer` API token, and exposes `requireAccount`.
 */
export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('account', null)
  app.decorateRequest('apiGrant', null)
  app.decorateRequest('badToken', false)

  app.addHook('onRequest', async (request, reply) => {
    if (isCrossSiteWrite(request, ctx)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Cross-site requests are not allowed. Use an API token instead.',
      })
    }
    resolveCaller(request, ctx)

    // Least privilege: an agent token can search and read, nothing more. The
    // check uses the matched route pattern rather than the raw URL, so path
    // tricks such as `/api/agent/v1/../../v1/tokens` cannot slip past it.
    const route = request.routeOptions.url ?? ''
    if (request.apiGrant?.scope === 'agent' && !isAgentRoute(route)) {
      request.account = null
      return reply.code(403).send({
        error: 'forbidden',
        message: `This is an agent token. It can only read bookmarks through ${AGENT_API_PREFIX}. See GET ${AGENT_API_PREFIX} for what it can do.`,
      })
    }
  })
}

const isAgentRoute = (route: string): boolean =>
  route === AGENT_API_PREFIX || route.startsWith(`${AGENT_API_PREFIX}/`)

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF defence in depth on top of SameSite=Lax: a state-changing request that
 * relies on the browser cookie must come from this site. Bearer-token calls
 * cannot be forged cross-site, and clients that send neither header (curl,
 * scripts) are not browsers, so both are let through.
 */
function isCrossSiteWrite(request: FastifyRequest, ctx: AppContext): boolean {
  if (SAFE_METHODS.has(request.method)) return false
  if (request.headers.authorization?.startsWith('Bearer ')) return false

  const fetchSite = request.headers['sec-fetch-site']
  if (typeof fetchSite === 'string') return fetchSite !== 'same-origin' && fetchSite !== 'none'

  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true
  }
  if (originHost === request.host) return false
  try {
    return originHost !== new URL(ctx.config.publicUrl).host
  } catch {
    return true
  }
}

function resolveCaller(request: FastifyRequest, ctx: AppContext): void {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) {
    // A bearer token never falls back to the cookie: a bad token is a 401,
    // not a silent switch to whoever is signed in to this browser.
    const token = header.slice('Bearer '.length).trim()
    const grant = token ? ctx.accounts.resolveApiGrant(token) : null
    request.apiGrant = grant
    request.account = grant?.account ?? null
    request.badToken = grant === null
    return
  }

  const cookie = request.cookies[SESSION_COOKIE]
  if (cookie) request.account = ctx.accounts.resolveAuthSession(cookie)
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
