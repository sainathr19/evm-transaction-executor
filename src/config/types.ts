import type { Chain } from 'viem'

export type GasConfig = {
  /** Set per chain, not detected (ADR 0007). */
  type: 'eip1559' | 'legacy'
  /** Added on top of estimateGas. Our practical choice, not a standard (ADR 0007). */
  gasLimitBufferPercent: number
  /** maxFeePerGas = baseFee × baseFeeMultiplier + tip (ADR 0007). */
  baseFeeMultiplier: number
  /** Minimum tip, for chains where the node suggests zero. */
  minPriorityFeeWei: bigint
  /** Hard cap on maxFeePerGas, or gasPrice on legacy chains. No default: every chain sets it. */
  maxFeePerGasWei: bigint
  /** How much each replacement raises both fee fields (ADR 0008). */
  bumpPercent: number
  /** Replacements before we stop raising fees and only resend (ADR 0008). */
  maxBumps: number
}

export type ChainConfig = {
  chain: Chain
  pollIntervalMs: number
  stuckAfterMs: number
  maxInFlightPerSender: number
  gas: GasConfig
}

/** What a file in src/config/chains/ provides. Anything left out comes from DEFAULTS. */
export type ChainFile = {
  chain: Chain
  pollIntervalMs?: number
  stuckAfterMs?: number
  maxInFlightPerSender?: number
  gas: Partial<GasConfig> & Pick<GasConfig, 'maxFeePerGasWei'>
}
