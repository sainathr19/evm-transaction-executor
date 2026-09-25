import type { Hash } from 'viem'

export type TxStatus = 'queued' | 'submitted' | 'succeeded' | 'reverted' | 'failed'
export type TxKind = 'request' | 'gap_fill'

/** Why a request ended as `failed`. See "Failure codes" in the README. */
export type FailureCode =
  | 'ESTIMATION_REVERTED'
  | 'FEE_ABOVE_CAP'
  | 'RPC_UNAVAILABLE'
  | 'INSUFFICIENT_FUNDS'
  | 'BROADCAST_REJECTED'
  | 'NONCE_TAKEN'
  | 'INTERNAL_ERROR'

export type Fees =
  { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { type: 'legacy'; gasPrice: bigint }

export type Receipt = {
  transactionHash: Hash
  blockNumber: bigint
  blockHash: Hash
  gasUsed: bigint
  effectiveGasPrice: bigint
  status: 'success' | 'reverted'
}
