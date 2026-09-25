import type { LevelWithSilent } from 'pino'
import type { ChainId } from '../types'
import { DEFAULTS } from './defaults'
import { type ChainEnv, parseEnv, type Env } from './env'
import { buildSigners, type Signers } from './signers'
import type { ChainConfig } from './types'

export type AppConfig = {
  chains: Map<ChainId, ChainConfig>
  signers: Signers
  host: string
  port: number
  dbPath: string
  logLevel: LevelWithSilent
}

/**
 * Reads and checks everything the service needs to start (ADRs 0005 and 0006). Checking each
 * RPC's eth_chainId needs the network, so it happens later, at startup.
 *
 * Removes SIGNER_PRIVATE_KEYS from `env` once read: after this, the keys only live inside the
 * signer accounts.
 */
export function loadConfig(env: Env): AppConfig {
  const { chains, privateKeys, ...server } = parseEnv(env)
  const signers = buildSigners(privateKeys)
  delete env.SIGNER_PRIVATE_KEYS

  const configs = new Map([...chains].map(([id, chain]) => [id, chainConfig(id, chain)]))
  return { chains: configs, signers, ...server }
}

function chainConfig(id: ChainId, chain: ChainEnv): ChainConfig {
  return {
    chainId: id,
    rpcUrls: chain.rpcUrls,
    pollIntervalMs: chain.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    stuckAfterMs: chain.stuckAfterMs ?? DEFAULTS.stuckAfterMs,
    maxInFlightPerSender: DEFAULTS.maxInFlightPerSender,
    gas: { ...DEFAULTS.gas, maxFeePerGasWei: chain.maxFeePerGasWei ?? DEFAULTS.gas.maxFeePerGasWei },
  }
}
