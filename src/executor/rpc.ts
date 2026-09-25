import { createPublicClient, fallback, http, type Hash, type Hex, type PublicClient } from 'viem'
import { sendRawTransaction } from 'viem/actions'
import { ConfigError } from '../config/error'
import type { ChainConfig } from '../config/types'
import type { ChainId } from '../types'

/** Sends a signed transaction to one RPC URL, exactly once. */
export type Sender = (raw: Hex) => Promise<Hash>

export type ChainRpc = {
  chainId: ChainId
  /** For reads: viem's retries with backoff, then the next URL (ADR 0008, layer 1). */
  read: PublicClient
  /**
   * For broadcasts: one per URL, in fallback order. Not viem's fallback transport: it moves to the
   * next URL without saying an earlier send went unanswered, so broadcast() does its own
   * (ADR 0008, layer 3). viem's sendRawTransaction already skips retries; turning them off on the
   * transport keeps that true for any other send path.
   */
  senders: Sender[]
}

/** An enabled chain with its RPC clients. */
export type RuntimeChain = { config: ChainConfig; rpc: ChainRpc }

// The clients get no viem chain definition: any chain id works, and only standard JSON-RPC is used.
// Signing takes the chain id from the request (ADR 0005).
export function createChainRpc(chain: ChainConfig): ChainRpc {
  const transports = chain.rpcUrls.map((url) => http(url))
  const read = createPublicClient({ transport: transports.length === 1 ? transports[0] : fallback(transports) })
  const senders = chain.rpcUrls.map((url): Sender => {
    const client = createPublicClient({ transport: http(url, { retryCount: 0 }) })
    return (raw) => sendRawTransaction(client, { serializedTransaction: raw })
  })
  return { chainId: chain.chainId, read, senders }
}

/**
 * Startup check (ADR 0005): every RPC URL of a chain must serve that chain. Each URL is checked,
 * so a wrong fallback URL can't hide behind a correct first one. Messages never include the URL.
 */
export async function verifyChainId(chain: ChainConfig): Promise<void> {
  const expected = chain.chainId
  await Promise.all(
    chain.rpcUrls.map(async (url, i) => {
      const where = `RPC_URL_${expected} entry ${i + 1}`
      let actual: number
      try {
        actual = await createPublicClient({ transport: http(url, { retryCount: 1 }) }).getChainId()
      } catch {
        throw new ConfigError(`${where} could not be reached to check its chain id`)
      }
      if (actual !== expected) throw new ConfigError(`${where} serves chain ${actual}, not ${expected}`)
    }),
  )
}
