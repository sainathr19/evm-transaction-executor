import { buildApp } from './app'
import { ConfigError } from './config/error'
import { loadConfig, type AppConfig } from './config/load'
import { createLogger } from './logger'
import { verifyChainId } from './rpc'

const config = loadConfigOrExit()
const logger = createLogger(config.logLevel)
await verifyChainsOrExit(config)
logger.info({ chains: [...config.chains.keys()], senders: [...config.signers.keys()] }, 'configuration loaded')

const server = buildApp().listen(config.port, config.host, (error) => {
  if (error) {
    logger.fatal({ err: error }, 'failed to start')
    process.exit(1)
  }
  logger.info({ host: config.host, port: config.port }, 'listening')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down')
    server.close(() => process.exit(0))
  })
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig(process.env)
  } catch (error) {
    return exitOnConfigError(error)
  }
}

async function verifyChainsOrExit(config: AppConfig): Promise<void> {
  try {
    await Promise.all([...config.chains.values()].map(verifyChainId))
  } catch (error) {
    exitOnConfigError(error)
  }
}

function exitOnConfigError(error: unknown): never {
  if (!(error instanceof ConfigError)) throw error
  console.error(`Configuration error: ${error.message}`)
  process.exit(1)
}
