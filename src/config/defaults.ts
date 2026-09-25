import { parseGwei } from 'viem'
import type { ChainConfig } from './types'

// Every chain starts from these. POLL_INTERVAL_MS_<chainId>, STUCK_AFTER_MS_<chainId> and
// MAX_FEE_GWEI_<chainId> override them per chain (ADR 0005). Where each value comes from is
// documented in ADRs 0007, 0008 and 0012.
export const DEFAULTS = {
  pollIntervalMs: 2_000,
  stuckAfterMs: 60_000,
  maxInFlightPerSender: 16,
  gas: {
    gasLimitBufferPercent: 20,
    baseFeeMultiplier: 2,
    minPriorityFeeWei: 0n,
    maxFeePerGasWei: parseGwei('500'),
    bumpPercent: 12.5,
    maxBumps: 5,
  },
} satisfies Omit<ChainConfig, 'chainId' | 'rpcUrls'>
