import type { ChainId } from '../types'

export type GasConfig = {
  /** Added on top of estimateGas. Our practical choice, not a standard (ADR 0007). */
  gasLimitBufferPercent: number
  /** maxFeePerGas = baseFee × baseFeeMultiplier + tip (ADR 0007). */
  baseFeeMultiplier: number
  /** Minimum tip, for chains where the node suggests zero. */
  minPriorityFeeWei: bigint
  /** Hard cap on maxFeePerGas, or gasPrice on chains without a base fee (ADR 0007). */
  maxFeePerGasWei: bigint
  /** How much each replacement raises both fee fields (ADR 0008). */
  bumpPercent: number
  /** Replacements before we stop raising fees and only resend (ADR 0008). */
  maxBumps: number
}

/** An enabled chain: its RPC URLs from env, and its settings (ADR 0005). */
export type ChainConfig = {
  chainId: ChainId
  /** In fallback order. */
  rpcUrls: string[]
  pollIntervalMs: number
  stuckAfterMs: number
  maxInFlightPerSender: number
  gas: GasConfig
}
