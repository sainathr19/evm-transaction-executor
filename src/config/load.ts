import type { LevelWithSilent } from 'pino'
import { CHAIN_FILES } from './chains'
import { withDefaults } from './defaults'
import { parseEnv, type Env } from './env'
import { ConfigError } from './error'
import { buildSigners, type Signers } from './signers'
import type { ChainConfig, ChainFile } from './types'

export type EnabledChain = ChainConfig & { rpcUrls: string[] }

export type AppConfig = {
  chains: Map<number, EnabledChain>
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
export function loadConfig(env: Env, files: ChainFile[] = CHAIN_FILES): AppConfig {
  const { rpcUrls, privateKeys, ...server } = parseEnv(env)
  const signers = buildSigners(privateKeys)
  delete env.SIGNER_PRIVATE_KEYS

  const chains = new Map<number, EnabledChain>()
  for (const [chainId, urls] of rpcUrls) {
    const file = files.find((candidate) => candidate.chain.id === chainId)
    if (!file) {
      throw new ConfigError(
        `RPC_URL_${chainId} is set, but src/config/chains/ has no config file for chain ${chainId}`,
      )
    }
    chains.set(chainId, { ...withDefaults(file), rpcUrls: urls })
  }

  return { chains, signers, ...server }
}
