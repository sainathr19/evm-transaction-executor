import type { ChainFile } from '../types'
import anvil from './anvil'
import baseSepolia from './base-sepolia'
import sepolia from './sepolia'

/** Every chain the service knows about. A chain is enabled when RPC_URL_<chainId> is set (ADR 0005). */
export const CHAIN_FILES: ChainFile[] = [anvil, sepolia, baseSepolia]
