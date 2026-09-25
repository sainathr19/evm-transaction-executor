import { buildApp } from './app'
import { ConfigError } from './config/error'
import { type AppConfig, loadConfig } from './config/load'
import { Monitor } from './executor/monitor'
import { recover } from './executor/recovery'
import { createChainRpc, type RuntimeChain, verifyChainId } from './executor/rpc'
import { SenderRegistry } from './executor/senders'
import { Worker } from './executor/worker'
import { createLogger } from './logger'
import { openDb } from './store/db'
import { Store } from './store/store'
import type { ChainId } from './types'

const config = loadConfigOrExit()
const logger = createLogger(config.logLevel)
await verifyChainsOrExit(config)
logger.info({ chains: [...config.chains.keys()], senders: [...config.signers.keys()] }, 'configuration loaded')

const db = openDb(config.dbPath)
const store = new Store(db)
const chains = new Map<ChainId, RuntimeChain>(
  [...config.chains].map(([id, chain]) => [id, { config: chain, rpc: createChainRpc(chain) }]),
)
const { signers } = config
const senders = new SenderRegistry()
const worker = new Worker({ store, chains, signers, senders, logger })
const monitors = [...chains.values()].map((chain) => new Monitor({ store, chain, signers, senders, worker, logger }))

// Pick up where the last run stopped, before anything new can arrive.
await recover({ store, chains, signers, senders, worker, logger })
for (const monitor of monitors) monitor.start()

const app = buildApp({
  store,
  chainIds: new Set(chains.keys()),
  signers,
  onAccepted: (tx) => worker.enqueue(tx.id),
  logger,
})
const server = app.listen(config.port, config.host, (error) => {
  if (error) {
    logger.fatal({ err: error }, 'failed to start')
    process.exit(1)
  }
  logger.info({ host: config.host, port: config.port }, 'listening')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal))
}

/** Stops taking requests, lets work in progress finish, then closes the database. */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'shutting down')
  await new Promise((resolve) => server.close(resolve))
  await Promise.all(monitors.map((monitor) => monitor.stop()))
  await worker.idle()
  db.close()
  process.exit(0)
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
