import { parseGwei } from 'viem'
import { anvil } from 'viem/chains'
import type { ChainFile } from '../types'

// Local development chain. Short timers so stuck transactions are handled quickly.
export default {
  chain: anvil,
  pollIntervalMs: 500,
  stuckAfterMs: 5_000,
  gas: { maxFeePerGasWei: parseGwei('100') },
} satisfies ChainFile
