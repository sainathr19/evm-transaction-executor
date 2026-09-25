import type { LevelWithSilent } from 'pino'
import type { Hex } from 'viem'
import { type ChainId, chainId } from '../types'
import { ConfigError } from './error'

export type Env = Record<string, string | undefined>

export type EnvConfig = {
  /** chainId → RPC URLs, in fallback order. */
  rpcUrls: Map<ChainId, string[]>
  privateKeys: Hex[]
  host: string
  port: number
  dbPath: string
  logLevel: LevelWithSilent
}

const RPC_URL_VAR = /^RPC_URL_(.+)$/
const CHAIN_ID = /^[1-9]\d*$/
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/
const LOG_LEVELS: readonly string[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']

// Error messages name the variable and entry, never the value: RPC URLs often embed API keys.
export function parseEnv(env: Env): EnvConfig {
  return {
    rpcUrls: parseRpcUrls(env),
    privateKeys: parsePrivateKeys(env.SIGNER_PRIVATE_KEYS),
    host: env.HOST || '127.0.0.1',
    port: parsePort(env.PORT),
    dbPath: env.DB_PATH || './data/executor.db',
    logLevel: parseLogLevel(env.LOG_LEVEL),
  }
}

function parseRpcUrls(env: Env): Map<ChainId, string[]> {
  const rpcUrls = new Map<ChainId, string[]>()
  for (const [name, value] of Object.entries(env)) {
    const suffix = RPC_URL_VAR.exec(name)?.[1]
    if (suffix === undefined) continue
    if (!CHAIN_ID.test(suffix) || !Number.isSafeInteger(Number(suffix))) {
      throw new ConfigError(`${name}: the suffix must be a chain id, as in RPC_URL_84532`)
    }
    const urls = splitList(value)
    if (urls.length === 0) throw new ConfigError(`${name} is empty`)
    urls.forEach((url, i) => {
      if (!isHttpUrl(url)) throw new ConfigError(`${name} entry ${i + 1} is not an http(s) URL`)
    })
    rpcUrls.set(chainId(Number(suffix)), urls)
  }
  if (rpcUrls.size === 0) {
    throw new ConfigError('No chains configured: set RPC_URL_<chainId> for at least one chain')
  }
  return rpcUrls
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
