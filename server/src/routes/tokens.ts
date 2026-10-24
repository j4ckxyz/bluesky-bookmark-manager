import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.ts'
import type { TokenScope } from '../db/accounts.ts'
import { requireAccount } from './auth-plugin.ts'

const MAX_EXPIRY_DAYS = 3650

/**
 * Personal API tokens. A `full` token lets other tools use the same `/api/v1`
 * surface the front end uses, without sharing a PDS app password. An `agent`
 * token only reads, and only through `/api/agent/v1`.
 */
export function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/tokens', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    return { tokens: ctx.accounts.listApiTokens(account.did) }
  })

  app.post<{ Body?: { name?: string; scope?: string; expiresInDays?: number | null } }>(
    '/api/v1/tokens',
    async (request, reply) => {
      const account = requireAccount(request, reply)
      if (!account) return

      // An API token must not be able to mint more API tokens.
      if (request.headers.authorization?.startsWith('Bearer ')) {
        return reply.code(403).send({
          error: 'forbidden',
          message: 'Create tokens from the web interface, not with another token.',
        })
      }

      const name = (request.body?.name ?? '').trim() || 'Untitled token'
      if (name.length > 80) {
        return reply.code(400).send({ error: 'bad_request', message: 'Token names cap at 80 characters.' })
      }

      const scopeParam = request.body?.scope ?? 'full'
      if (scopeParam !== 'full' && scopeParam !== 'agent') {
        return reply.code(400).send({ error: 'bad_request', message: 'Scope must be `full` or `agent`.' })
      }
      const scope: TokenScope = scopeParam

      const days = request.body?.expiresInDays
      if (
        days !== undefined &&
        days !== null &&
        (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS)
      ) {
        return reply.code(400).send({
          error: 'bad_request',
          message: `Expiry must be a whole number of days between 1 and ${MAX_EXPIRY_DAYS}, or null for never.`,
        })
      }
      const expiresAt = typeof days === 'number' ? new Date(Date.now() + days * 86_400_000).toISOString() : null

      const created = ctx.accounts.createApiToken(account.did, name, { scope, expiresAt })
      return reply.code(201).send({
        name,
        hint: created.hint,
        scope: created.scope,
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        lastUsedAt: null,
        expired: false,
        // Shown once; only the hash is stored.
        token: created.token,
      })
    },
  )

  app.delete<{ Params: { hint: string } }>('/api/v1/tokens/:hint', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    const revoked = ctx.accounts.revokeApiToken(account.did, decodeURIComponent(request.params.hint))
    if (!revoked) {
      return reply.code(404).send({ error: 'not_found', message: 'No such token.' })
    }
    return { revoked: true }
  })
}
