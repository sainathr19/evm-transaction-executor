import { randomUUID } from 'node:crypto'
import type { Address, Hash, Hex } from 'viem'
import {
  chainId,
  type ChainId,
  type Fees,
  nonce,
  type Nonce,
  type QueuedTx,
  type Receipt,
  type Transaction,
  type TxFailure,
  type TxFields,
  txId,
  type TxId,
  type TxStatus,
  type TxWithStatus,
} from '../types'
import type { Db } from './db'

/** pending: saved, not sent yet. unknown: a send went unanswered. See ADR 0008. */
export type AttemptOutcome = 'pending' | 'accepted' | 'unknown' | 'rejected'

export type Attempt = {
  id: number
  txId: TxId
  hash: Hash
  raw: Hex
  fees: Fees
  outcome: AttemptOutcome
  createdAt: string
}

export type NewRequest = {
  idempotencyKey: string
  requestHash: string
  chainId: ChainId
  sender: Address
  to: Address
  value: bigint
  data: Hex
}

export type NewAttempt = { nonce: Nonce; gasLimit: bigint; hash: Hash; raw: Hex; fees: Fees }

/** Either this call stored the request, or its idempotency key already existed and the stored one is returned. */
export type InsertResult = { created: true; tx: QueuedTx } | { created: false; tx: Transaction }

type TxRow = {
  id: string
  idempotency_key: string
  request_hash: string
  chain_id: number
  sender: string
  to_address: string
  value: string
  data: string
  status: TxStatus
  nonce: number | null
  gas_limit: string | null
  hash: string | null
  receipt: string | null
  failure: string | null
  created_at: string
  updated_at: string
}

type AttemptRow = {
  id: number
  tx_id: string
  hash: string
  raw: string
  fees: string
  outcome: AttemptOutcome
  created_at: string
}

// Status changes only apply to unfinished requests, so a final status is never overwritten.
const UNFINISHED = `status IN ('queued', 'submitted')`
// Being broadcast or mined requires a saved attempt, which sets the nonce.
const HAS_ATTEMPT = 'nonce IS NOT NULL'

export class Store {
  readonly #db: Db
  readonly #now: () => Date

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db
    this.#now = now
  }

  insertRequest(input: NewRequest): InsertResult {
    const now = this.#timestamp()
    const { changes } = this.#db
      .prepare(
        `INSERT INTO transactions
           (id, idempotency_key, request_hash, chain_id, sender, to_address, value, data, status, created_at, updated_at)
         VALUES
           (@id, @idempotencyKey, @requestHash, @chainId, @sender, @to, @value, @data, 'queued', @now, @now)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .run({ ...input, id: randomUUID(), value: input.value.toString(), now })
    const row = this.#db
      .prepare(`SELECT * FROM transactions WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as TxRow
    const tx = toTransaction(row)
    return changes === 1 && tx.status === 'queued' ? { created: true, tx } : { created: false, tx }
  }

  get(id: TxId): Transaction | undefined {
    const row = this.#db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as TxRow | undefined
    return row && toTransaction(row)
  }

  /** Oldest first. */
  listByStatus<S extends TxStatus>(statuses: readonly S[], chain?: ChainId): TxWithStatus<S>[] {
    const placeholders = statuses.map(() => '?').join(', ')
    const chainFilter = chain === undefined ? '' : 'AND chain_id = ?'
    const params = chain === undefined ? statuses : [...statuses, chain]
    const rows = this.#db
      .prepare(`SELECT * FROM transactions WHERE status IN (${placeholders}) ${chainFilter} ORDER BY rowid`)
      .all(...params) as TxRow[]
    const wanted: readonly TxStatus[] = statuses
    return rows.map(toTransaction).filter((tx): tx is TxWithStatus<S> => wanted.includes(tx.status))
  }

  /** Saves a signed transaction and the nonce it uses, together, before it's broadcast. */
  recordAttempt(id: TxId, attempt: NewAttempt): Attempt {
    const now = this.#timestamp()
    return this.#db.transaction((): Attempt => {
      this.#db
        .prepare(`UPDATE transactions SET nonce = ?, gas_limit = ?, updated_at = ? WHERE id = ?`)
        .run(attempt.nonce, attempt.gasLimit.toString(), now, id)
      const { lastInsertRowid } = this.#db
        .prepare(`INSERT INTO attempts (tx_id, hash, raw, fees, outcome, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(id, attempt.hash, attempt.raw, JSON.stringify(attempt.fees, bigintToString), now)
      return {
        id: Number(lastInsertRowid),
        txId: id,
        hash: attempt.hash,
        raw: attempt.raw,
        fees: attempt.fees,
        outcome: 'pending',
        createdAt: now,
      }
    })()
  }

  setAttemptOutcome(attemptId: number, outcome: AttemptOutcome): void {
    this.#db.prepare(`UPDATE attempts SET outcome = ? WHERE id = ?`).run(outcome, attemptId)
  }

  /** In the order they were signed. */
  attempts(id: TxId): Attempt[] {
    const rows = this.#db.prepare(`SELECT * FROM attempts WHERE tx_id = ? ORDER BY id`).all(id) as AttemptRow[]
    return rows.map(toAttempt)
  }

  markSubmitted(id: TxId, hash: Hash): boolean {
    return this.#update(`status = 'submitted', hash = @hash`, { id, hash }, HAS_ATTEMPT)
  }

  markMined(id: TxId, receipt: Receipt): boolean {
    const assignments = `status = @status, hash = @hash, receipt = @receipt`
    const params = {
      id,
      status: receipt.status === 'success' ? 'succeeded' : 'reverted',
      hash: receipt.transactionHash,
      receipt: JSON.stringify(receipt, bigintToString),
    }
    return this.#update(assignments, params, HAS_ATTEMPT)
  }

  markFailed(id: TxId, failure: TxFailure): boolean {
    return this.#update(`status = 'failed', failure = @failure`, {
      id,
      failure: JSON.stringify(failure, bigintToString),
    })
  }

  /**
   * Nonces that belong to unfinished requests with at least one attempt a node may have
   * (not rejected). Used to rebuild the nonce pool after a restart (ADR 0009).
   */
  heldNonces(chain: ChainId, sender: Address): Nonce[] {
    const values = this.#db
      .prepare(
        `SELECT DISTINCT nonce FROM transactions t
         WHERE chain_id = ? AND sender = ? AND ${UNFINISHED} AND nonce IS NOT NULL
           AND EXISTS (SELECT 1 FROM attempts a WHERE a.tx_id = t.id AND a.outcome != 'rejected')
         ORDER BY nonce`,
      )
      .pluck()
      .all(chain, sender) as number[]
    return values.map(nonce)
  }

  #update(assignments: string, params: Record<string, unknown> & { id: TxId }, condition = 'TRUE'): boolean {
    const { changes } = this.#db
      .prepare(
        `UPDATE transactions SET ${assignments}, updated_at = @now WHERE id = @id AND ${UNFINISHED} AND ${condition}`,
      )
      .run({ ...params, now: this.#timestamp() })
    return changes === 1
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }
}

/** Parses a row into the state it's in, checking the fields that state requires are present. */
function toTransaction(row: TxRow): Transaction {
  const fields: TxFields = {
    id: txId(row.id),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    chainId: chainId(row.chain_id),
    sender: row.sender as Address,
    to: row.to_address as Address,
    value: BigInt(row.value),
    data: row.data as Hex,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  const txNonce = row.nonce === null ? null : nonce(row.nonce)
  const gasLimit = row.gas_limit === null ? null : BigInt(row.gas_limit)
  const hash = row.hash as Hash | null
  const required = <T>(value: T | null, field: string): T => {
    if (value === null) throw new Error(`transaction ${row.id} is ${row.status} but has no ${field}`)
    return value
  }

  switch (row.status) {
    case 'queued':
      return { ...fields, status: 'queued', nonce: txNonce, gasLimit }
    case 'submitted':
      return {
        ...fields,
        status: 'submitted',
        nonce: required(txNonce, 'nonce'),
        gasLimit: required(gasLimit, 'gas limit'),
        hash: required(hash, 'hash'),
      }
    case 'succeeded':
    case 'reverted':
      return {
        ...fields,
        status: row.status,
        nonce: required(txNonce, 'nonce'),
        gasLimit: required(gasLimit, 'gas limit'),
        hash: required(hash, 'hash'),
        receipt: parseReceipt(required(row.receipt, 'receipt')),
      }
    case 'failed':
      return {
        ...fields,
        status: 'failed',
        nonce: txNonce,
        gasLimit,
        hash,
        failure: parseFailure(required(row.failure, 'failure')),
      }
  }
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    txId: txId(row.tx_id),
    hash: row.hash as Hash,
    raw: row.raw as Hex,
    fees: parseFees(row.fees),
    outcome: row.outcome,
    createdAt: row.created_at,
  }
}

// How values look once stored as JSON: bigints become decimal strings.
type StoredFees =
  { type: 'legacy'; gasPrice: string } | { type: 'eip1559'; maxFeePerGas: string; maxPriorityFeePerGas: string }

type StoredReceipt = {
  transactionHash: Hash
  blockNumber: string
  blockHash: Hash
  gasUsed: string
  effectiveGasPrice: string
  status: Receipt['status']
}

type StoredFailure =
  | Exclude<TxFailure, { code: 'FEE_ABOVE_CAP' | 'NONCE_TAKEN' }>
  | { code: 'FEE_ABOVE_CAP'; capWei: string }
  | { code: 'NONCE_TAKEN'; nonce: number }

function parseFees(json: string): Fees {
  const fees = JSON.parse(json) as StoredFees
  return fees.type === 'legacy'
    ? { type: 'legacy', gasPrice: BigInt(fees.gasPrice) }
    : {
        type: 'eip1559',
        maxFeePerGas: BigInt(fees.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
      }
}

function parseReceipt(json: string): Receipt {
  const receipt = JSON.parse(json) as StoredReceipt
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: BigInt(receipt.blockNumber),
    blockHash: receipt.blockHash,
    gasUsed: BigInt(receipt.gasUsed),
    effectiveGasPrice: BigInt(receipt.effectiveGasPrice),
    status: receipt.status,
  }
}

function parseFailure(json: string): TxFailure {
  const failure = JSON.parse(json) as StoredFailure
  switch (failure.code) {
    case 'FEE_ABOVE_CAP':
      return { code: 'FEE_ABOVE_CAP', capWei: BigInt(failure.capWei) }
    case 'NONCE_TAKEN':
      return { code: 'NONCE_TAKEN', nonce: nonce(failure.nonce) }
    case 'ESTIMATION_REVERTED':
    case 'RPC_UNAVAILABLE':
    case 'INSUFFICIENT_FUNDS':
    case 'BROADCAST_REJECTED':
    case 'INTERNAL_ERROR':
      return failure
  }
}

function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
