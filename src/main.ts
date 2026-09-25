import { buildApp } from './app'
import { createLogger } from './logger'

const logger = createLogger(process.env.LOG_LEVEL)
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 3000)

const server = buildApp().listen(port, host, (error) => {
  if (error) {
    logger.fatal({ err: error }, 'failed to start')
    process.exit(1)
  }
  logger.info({ host, port }, 'listening')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}
