import { parseGwei } from 'viem'
import { sepolia } from 'viem/chains'
import type { ChainFile } from '../types'

// 12 s blocks: stuck after about 5 blocks.
export default {
  chain: sepolia,
  pollIntervalMs: 4_000,
  stuckAfterMs: 60_000,
  gas: { maxFeePerGasWei: parseGwei('100') }, // example value; set for your use
} satisfies ChainFile
