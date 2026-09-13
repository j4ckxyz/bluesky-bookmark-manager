import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.ts'
import { requireAccount } from './auth-plugin.ts'

/**
 * Personal API tokens. These let other tools read the archive over the same
 * `/api/v1` surface the front end uses, without sharing a PDS app password.
 */
export function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/tokens', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    return { tokens: ctx.accounts.listApiTokens(account.did) }
  })

  app.post<{ Body?: { name?: string } }>('/api/v1/tokens', async (request, reply) => {
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

    const created = ctx.accounts.createApiToken(account.did, name)
    return reply.code(201).send({
      name,
      hint: created.hint,
      createdAt: created.createdAt,
      // Shown once; only the hash is stored.
      token: created.token,
    })
  })

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
