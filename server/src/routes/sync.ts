import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.ts'
import type { SyncProgress } from '../sync/engine.ts'
import type { SyncMode } from '../types.ts'
import { requireAccount } from './auth-plugin.ts'

const MODES: SyncMode[] = ['backfill', 'quick', 'full']

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/sync/status', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    return {
      status: ctx.engine.status(account.did),
      intervalMinutes: ctx.config.syncIntervalMinutes,
      nextMode: ctx.engine.nextScheduledMode(account.did),
      totalStored: ctx.bookmarks.countActive(account.did),
    }
  })

  app.get<{ Querystring: { limit?: string } }>('/api/v1/sync/history', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    const limit = Number.parseInt(request.query.limit ?? '20', 10)
    return { runs: ctx.runs.history(account.did, Number.isFinite(limit) ? limit : 20) }
  })

  app.post<{ Body?: { mode?: string } }>('/api/v1/sync', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return

    if (ctx.engine.isRunning(account.did)) {
      return reply.code(202).send({
        started: false,
        message: 'A sync is already running.',
        status: ctx.engine.status(account.did),
      })
    }

    const requested = request.body?.mode
    const mode: SyncMode =
      requested && MODES.includes(requested as SyncMode)
        ? (requested as SyncMode)
        : ctx.engine.nextScheduledMode(account.did)

    // Fire and forget: the client watches progress over SSE.
    void ctx.engine
      .run(account.did, { mode, trigger: 'manual' })
      .catch((err: unknown) => request.log.error({ err }, 'manual sync failed'))

    return reply.code(202).send({ started: true, mode, status: ctx.engine.status(account.did) })
  })

  app.post('/api/v1/sync/cancel', async (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return
    const cancelled = ctx.engine.cancel(account.did)
    return { cancelled, status: ctx.engine.status(account.did) }
  })

  /**
   * Live backfill progress over server-sent events. The client gets the
   * current state immediately, then every update for its own account.
   */
  app.get('/api/v1/sync/events', (request, reply) => {
    const account = requireAccount(request, reply)
    if (!account) return

    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers SSE into uselessness without this.
      'x-accel-buffering': 'no',
    })

    const send = (event: string, data: unknown): void => {
      if (raw.writableEnded) return
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    send('status', ctx.engine.status(account.did))

    const onProgress = (progress: SyncProgress): void => {
      if (progress.did !== account.did) return
      send('status', progress)
    }
    ctx.engine.on('progress', onProgress)

    // Proxies and load balancers drop idle connections; a comment keeps it warm.
    const heartbeat = setInterval(() => {
      if (raw.writableEnded) return
      raw.write(': keep-alive\n\n')
    }, 25_000)
    heartbeat.unref?.()

    const cleanup = (): void => {
      clearInterval(heartbeat)
      ctx.engine.off('progress', onProgress)
    }
    request.raw.on('close', cleanup)
    raw.on('close', cleanup)
  })
}
