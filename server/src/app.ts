import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from './context.ts'
import { registerAuth } from './routes/auth-plugin.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerBookmarkRoutes } from './routes/bookmarks.ts'
import { registerSyncRoutes } from './routes/sync.ts'
import { registerTokenRoutes } from './routes/tokens.ts'

export async function createApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.config.logLevel },
    trustProxy: ctx.config.trustProxy,
    // Bookmark exports of a large archive can be several megabytes.
    bodyLimit: 1_048_576,
  })

  await app.register(cookie)

  registerAuth(app, ctx)
  registerAuthRoutes(app, ctx)
  registerBookmarkRoutes(app, ctx)
  registerSyncRoutes(app, ctx)
  registerTokenRoutes(app, ctx)

  app.get('/api/v1/health', async () => ({
    ok: true,
    accounts: ctx.accounts.count(),
    uptimeSeconds: Math.round(process.uptime()),
  }))

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: `No route for ${request.url}` })
    }
    // Anything else is a client-side route; hand back the SPA shell.
    if (ctx.config.serveWeb && existsSync(join(ctx.config.webDir, 'index.html'))) {
      return reply.type('text/html').sendFile('index.html')
    }
    return reply.code(404).send({ error: 'not_found', message: 'Not found' })
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed')
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
    return reply.code(status).send({
      error: status === 500 ? 'internal' : 'request_failed',
      // Never leak an internal stack or message to the client.
      message: status === 500 ? 'Something went wrong.' : error.message,
    })
  })

  if (ctx.config.serveWeb && existsSync(ctx.config.webDir)) {
    await app.register(fastifyStatic, {
      root: ctx.config.webDir,
      index: ['index.html'],
      // Hashed asset filenames can be cached hard; index.html must not be.
      setHeaders: (reply, path) => {
        if (path.endsWith('index.html')) {
          reply.header('cache-control', 'no-cache')
        } else if (path.endsWith('sw.js')) {
          // A cached service worker would pin the app to an old build, so it
          // is always revalidated and allowed to control the whole origin.
          reply.header('cache-control', 'no-cache')
          reply.header('service-worker-allowed', '/')
        } else if (path.endsWith('.webmanifest')) {
          reply.header('cache-control', 'no-cache')
          reply.header('content-type', 'application/manifest+json; charset=utf-8')
        } else if (path.includes('/assets/')) {
          reply.header('cache-control', 'public, max-age=31536000, immutable')
        }
      },
    })
  }

  return app
}
