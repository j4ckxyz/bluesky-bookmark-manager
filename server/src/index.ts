import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createContext } from './context.ts'

async function main(): Promise<void> {
  const config = loadConfig()
  const ctx = createContext(config, (msg, extra) => {
    console.log(JSON.stringify({ level: 'info', msg, ...extra }))
  })

  const app = await createApp(ctx)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`${signal} received, shutting down`)
    try {
      await app.close()
      ctx.close()
    } catch (err) {
      app.log.error({ err }, 'shutdown failed')
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ port: config.port, host: config.host })

  ctx.scheduler.start()

  // Catch up on anything missed while the process was down, without making
  // startup wait for a network round trip.
  if (config.syncEnabled) {
    setTimeout(() => void ctx.scheduler.tick(), 5_000).unref()
  }

  app.log.info(
    `Listening on ${config.publicUrl} — syncing every ${config.syncIntervalMinutes} minutes`,
  )
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
