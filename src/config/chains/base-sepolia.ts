import { parseGwei } from 'viem'
import { baseSepolia } from 'viem/chains'
import type { ChainFile } from '../types'

// 2 s blocks: stuck after about 5 blocks.
export default {
  chain: baseSepolia,
  pollIntervalMs: 2_000,
  stuckAfterMs: 10_000,
  gas: { maxFeePerGasWei: parseGwei('5') }, // example value; set for your use
} satisfies ChainFile
