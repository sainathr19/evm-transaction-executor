import type { Address, Hash, Hex } from 'viem'

declare const brand: unique symbol

/** A nominal type: a `T` the compiler won't mix up with other `T`s, e.g. a nonce passed as a chain id. */
type Brand<T, Name extends string> = T & { readonly [brand]: Name }

export type ChainId = Brand<number, 'ChainId'>
export type Nonce = Brand<number, 'Nonce'>
export type TxId = Brand<string, 'TxId'>

// Values are branded once, where they enter the service: config, API input, database rows, RPC results.

export function chainId(value: number): ChainId {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`not a chain id: ${value}`)
  return value as ChainId
}

export function nonce(value: number): Nonce {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`not a nonce: ${value}`)
  return value as Nonce
}

export function txId(value: string): TxId {
  if (value === '') throw new TypeError('empty transaction id')
  return value as TxId
}

/** The outcome of an operation that can fail in an expected way. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export type Fees =
  { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { type: 'legacy'; gasPrice: bigint }

/** An event the transaction emitted. */
export type ReceiptLog = { address: Address; topics: Hex[]; data: Hex; logIndex: number }

/** The node's receipt for a mined transaction. */
export type Receipt = {
  transactionHash: Hash
  transactionIndex: number
  blockNumber: bigint
  blockHash: Hash
  from: Address
  to: Address | null
  /** Only set when a contract is deployed, which the API doesn't support. */
  contractAddress: Address | null
  gasUsed: bigint
  cumulativeGasUsed: bigint
  effectiveGasPrice: bigint
  status: 'success' | 'reverted'
  type: string
  logsBloom: Hex
  logs: ReceiptLog[]
}

/** Why a request ended as `failed`. Each code carries the details that explain it. */
export type TxFailure =
  | { code: 'ESTIMATION_REVERTED'; nodeMessage: string }
  | { code: 'FEE_ABOVE_CAP'; capWei: bigint }
  | { code: 'RPC_UNAVAILABLE' }
  | { code: 'INSUFFICIENT_FUNDS'; nodeMessage: string }
  | { code: 'BROADCAST_REJECTED'; nodeMessage: string }
  | { code: 'NONCE_TAKEN'; nonce: Nonce }
  | { code: 'INTERNAL_ERROR'; message: string }

export type FailureCode = TxFailure['code']

/** One line explaining a failure, for logs and API responses. */
export function describeFailure(failure: TxFailure): string {
  switch (failure.code) {
    case 'ESTIMATION_REVERTED':
      return `gas estimation failed: ${failure.nodeMessage}`
    case 'FEE_ABOVE_CAP':
      return `base fee plus tip is above the cap of ${failure.capWei} wei`
    case 'RPC_UNAVAILABLE':
      return 'the RPC could not be reached'
    case 'INSUFFICIENT_FUNDS':
      return `the sender can't pay for it: ${failure.nodeMessage}`
    case 'BROADCAST_REJECTED':
      return `the node rejected it: ${failure.nodeMessage}`
    case 'NONCE_TAKEN':
      return `nonce ${failure.nonce} was used by another transaction`
    case 'INTERNAL_ERROR':
      return failure.message
  }
}

/** What every transaction has, whatever its state. */
export type TxFields = {
  id: TxId
  idempotencyKey: string
  requestHash: string
  chainId: ChainId
  sender: Address
  to: Address
  value: bigint
  data: Hex
  createdAt: string
  updatedAt: string
}

/** Accepted, not broadcast yet. `nonce` and `gasLimit` are set once an attempt has been saved. */
export type QueuedTx = TxFields & { status: 'queued'; nonce: Nonce | null; gasLimit: bigint | null }

/** Broadcast, so a node has it or may have it. `hash` is the latest attempt a node may have. */
export type SubmittedTx = TxFields & { status: 'submitted'; nonce: Nonce; gasLimit: bigint; hash: Hash }

/** Mined. `hash` is the attempt that was mined; the receipt says whether execution succeeded. */
type MinedTx<Status extends 'succeeded' | 'reverted'> = TxFields & {
  status: Status
  nonce: Nonce
  gasLimit: bigint
  hash: Hash
  receipt: Receipt
}
export type SucceededTx = MinedTx<'succeeded'>
export type RevertedTx = MinedTx<'reverted'>

/** Never reached the chain, or its nonce was used by another transaction. */
export type FailedTx = TxFields & {
  status: 'failed'
  nonce: Nonce | null
  gasLimit: bigint | null
  hash: Hash | null
  failure: TxFailure
}

export type Transaction = QueuedTx | SubmittedTx | SucceededTx | RevertedTx | FailedTx
export type TxStatus = Transaction['status']
export type TxWithStatus<S extends TxStatus> = Extract<Transaction, { status: S }>
