import type { ChainConfig, ChainFile, GasConfig } from './types'

// Where each value comes from is documented in ADRs 0007, 0008 and 0012.
export const DEFAULTS = {
  pollIntervalMs: 2_000,
  stuckAfterMs: 60_000,
  maxInFlightPerSender: 16,
  gas: {
    type: 'eip1559',
    gasLimitBufferPercent: 20,
    baseFeeMultiplier: 2,
    minPriorityFeeWei: 0n,
    bumpPercent: 12.5,
    maxBumps: 5,
  },
} as const satisfies Omit<ChainConfig, 'chain' | 'gas'> & { gas: Omit<GasConfig, 'maxFeePerGasWei'> }

export function withDefaults(file: ChainFile): ChainConfig {
  return {
    chain: file.chain,
    pollIntervalMs: file.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    stuckAfterMs: file.stuckAfterMs ?? DEFAULTS.stuckAfterMs,
    maxInFlightPerSender: file.maxInFlightPerSender ?? DEFAULTS.maxInFlightPerSender,
    gas: { ...DEFAULTS.gas, ...file.gas },
  }
}
