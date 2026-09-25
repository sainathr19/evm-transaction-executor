import type { LevelWithSilent } from 'pino'
import { type Hex, parseGwei } from 'viem'
import { type ChainId, chainId } from '../types'
import { ConfigError } from './error'

export type Env = Record<string, string | undefined>

/** What env sets for one chain. Settings left out come from DEFAULTS (ADR 0005). */
export type ChainEnv = {
  /** In fallback order. */
  rpcUrls: string[]
  pollIntervalMs?: number
  stuckAfterMs?: number
  maxFeePerGasWei?: bigint
}

export type EnvConfig = {
  chains: Map<ChainId, ChainEnv>
  privateKeys: Hex[]
  host: string
  port: number
  dbPath: string
  logLevel: LevelWithSilent
}

/** Per-chain variables: RPC_URL_<chainId> enables a chain, the others tune it. */
const CHAIN_VAR = /^(RPC_URL|POLL_INTERVAL_MS|STUCK_AFTER_MS|MAX_FEE_GWEI)_(.+)$/
type ChainSetting = 'RPC_URL' | 'POLL_INTERVAL_MS' | 'STUCK_AFTER_MS' | 'MAX_FEE_GWEI'

const POSITIVE_INTEGER = /^[1-9]\d*$/
const GWEI = /^\d+(\.\d{1,9})?$/
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
const LOG_LEVELS: readonly string[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']

// Error messages name the variable and entry, never the value: RPC URLs often embed API keys.
export function parseEnv(env: Env): EnvConfig {
  return {
    chains: parseChains(env),
    privateKeys: parsePrivateKeys(env.SIGNER_PRIVATE_KEYS),
    host: env.HOST || '127.0.0.1',
    port: parsePort(env.PORT),
    dbPath: env.DB_PATH || './data/executor.db',
    logLevel: parseLogLevel(env.LOG_LEVEL),
  }
}

function parseChains(env: Env): Map<ChainId, ChainEnv> {
  const vars = Object.entries(env).flatMap(([name, value]) => {
    const match = CHAIN_VAR.exec(name)
    if (!match) return []
    const setting = match[1] as ChainSetting
    return [{ name, setting, id: parseChainId(name, setting, match[2]), value: value ?? '' }]
  })

  const chains = new Map<ChainId, ChainEnv>()
  for (const { name, setting, id, value } of vars) {
    if (setting === 'RPC_URL') chains.set(id, { rpcUrls: parseRpcUrls(name, value) })
  }
  if (chains.size === 0) {
    throw new ConfigError('No chains configured: set RPC_URL_<chainId> for at least one chain')
  }

  for (const { name, setting, id, value } of vars) {
    if (setting === 'RPC_URL') continue
    // A setting for a chain that isn't enabled is most likely a typo in the chain id.
    const chain = chains.get(id)
    if (!chain) throw new ConfigError(`${name} is set, but RPC_URL_${id} is not`)
    switch (setting) {
      case 'POLL_INTERVAL_MS':
        chain.pollIntervalMs = parseMilliseconds(name, value)
        break
      case 'STUCK_AFTER_MS':
        chain.stuckAfterMs = parseMilliseconds(name, value)
        break
      case 'MAX_FEE_GWEI':
        chain.maxFeePerGasWei = parseFeeCap(name, value)
        break
    }
  }
  return chains
}

function parseChainId(name: string, setting: ChainSetting, suffix: string): ChainId {
  if (!POSITIVE_INTEGER.test(suffix) || !Number.isSafeInteger(Number(suffix))) {
    throw new ConfigError(`${name}: the suffix must be a chain id, as in ${setting}_84532`)
  }
  return chainId(Number(suffix))
}

function parseRpcUrls(name: string, value: string): string[] {
  const urls = splitList(value)
  if (urls.length === 0) throw new ConfigError(`${name} is empty`)
  urls.forEach((url, i) => {
    if (!isHttpUrl(url)) throw new ConfigError(`${name} entry ${i + 1} is not an http(s) URL`)
  })
  return urls
}

function parseMilliseconds(name: string, value: string): number {
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ConfigError(`${name} must be a positive whole number of milliseconds`)
  }
  return Number(value)
}

function parseFeeCap(name: string, value: string): bigint {
  const wei = GWEI.test(value) ? parseGwei(value) : 0n
  if (wei === 0n) throw new ConfigError(`${name} must be a positive amount of gwei, such as 50 or 0.5`)
  return wei
}

function parsePrivateKeys(value: string | undefined): Hex[] {
  const keys = splitList(value)
  if (keys.length === 0) throw new ConfigError('No signers configured: set SIGNER_PRIVATE_KEYS')
  keys.forEach((key, i) => {
    if (!PRIVATE_KEY.test(key)) {
      throw new ConfigError(`SIGNER_PRIVATE_KEYS entry ${i + 1} is not a 0x-prefixed 32-byte hex key`)
    }
  })
  return keys as Hex[]
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError('PORT must be an integer from 1 to 65535')
  }
  return port
}

function parseLogLevel(value: string | undefined): LevelWithSilent {
  if (!value) return 'info'
  if (!LOG_LEVELS.includes(value)) throw new ConfigError(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`)
  return value as LevelWithSilent
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
