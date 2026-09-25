import { randomUUID } from 'node:crypto'
import type { Address, Hash, Hex } from 'viem'
import type { FailureCode, Fees, Receipt, TxKind, TxStatus } from '../types'
import type { Db } from './db'

export type TxRecord = {
  id: string
  kind: TxKind
  idempotencyKey: string | null
  requestHash: string | null
  chainId: number
  sender: Address
  to: Address
  value: bigint
  data: Hex
  status: TxStatus
  nonce: number | null
  gasLimit: bigint | null
  hash: Hash | null
  receipt: Receipt | null
  error: { code: FailureCode; message: string } | null
  createdAt: string
  updatedAt: string
}

/** pending: saved, not sent yet. unknown: a send went unanswered. See ADR 0008. */
export type AttemptOutcome = 'pending' | 'accepted' | 'unknown' | 'rejected'

export type Attempt = {
  id: number
  txId: string
  hash: Hash
  raw: Hex
  fees: Fees
  outcome: AttemptOutcome
  createdAt: string
}

export type NewRequest = {
  idempotencyKey: string
  requestHash: string
  chainId: number
  sender: Address
  to: Address
  value: bigint
  data: Hex
}

export type NewAttempt = { nonce: number; gasLimit: bigint; hash: Hash; raw: Hex; fees: Fees }

type TxRow = {
  id: string
  kind: TxKind
  idempotency_key: string | null
  request_hash: string | null
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
  error_code: string | null
  error_message: string | null
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

export class Store {
  readonly #db: Db
  readonly #now: () => Date

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db
    this.#now = now
  }

  /** Inserts the request unless its idempotency key exists; either way returns the stored one. */
  insertRequest(input: NewRequest): { tx: TxRecord; created: boolean } {
    const now = this.#timestamp()
    const { changes } = this.#db
      .prepare(
        `INSERT INTO transactions
           (id, kind, idempotency_key, request_hash, chain_id, sender, to_address, value, data, status, created_at, updated_at)
         VALUES
           (@id, 'request', @idempotencyKey, @requestHash, @chainId, @sender, @to, @value, @data, 'queued', @now, @now)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .run({ ...input, id: randomUUID(), value: input.value.toString(), now })
    const row = this.#db
      .prepare(`SELECT * FROM transactions WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as TxRow
    return { tx: toTx(row), created: changes === 1 }
  }

  /** A 0-value transfer from the sender to itself, used to fill a nonce gap (ADR 0009). */
  insertGapFill(chainId: number, sender: Address): TxRecord {
    const id = randomUUID()
    const now = this.#timestamp()
    this.#db
      .prepare(
        `INSERT INTO transactions (id, kind, chain_id, sender, to_address, value, data, status, created_at, updated_at)
         VALUES (?, 'gap_fill', ?, ?, ?, '0', '0x', 'queued', ?, ?)`,
      )
      .run(id, chainId, sender, sender, now, now)
    return this.get(id)!
  }

  get(id: string): TxRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as TxRow | undefined
    return row && toTx(row)
  }

  /** Oldest first. */
  listByStatus(statuses: TxStatus[], chainId?: number): TxRecord[] {
    const placeholders = statuses.map(() => '?').join(', ')
    const chainFilter = chainId === undefined ? '' : 'AND chain_id = ?'
    const params = chainId === undefined ? statuses : [...statuses, chainId]
    const rows = this.#db
      .prepare(`SELECT * FROM transactions WHERE status IN (${placeholders}) ${chainFilter} ORDER BY rowid`)
      .all(...params) as TxRow[]
    return rows.map(toTx)
  }

  /** Saves a signed transaction and the nonce it uses, together, before it's broadcast. */
  recordAttempt(txId: string, attempt: NewAttempt): Attempt {
    const now = this.#timestamp()
    return this.#db.transaction((): Attempt => {
      this.#db
        .prepare(`UPDATE transactions SET nonce = ?, gas_limit = ?, updated_at = ? WHERE id = ?`)
        .run(attempt.nonce, attempt.gasLimit.toString(), now, txId)
      const { lastInsertRowid } = this.#db
        .prepare(`INSERT INTO attempts (tx_id, hash, raw, fees, outcome, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
        .run(txId, attempt.hash, attempt.raw, JSON.stringify(attempt.fees, bigintToString), now)
      return {
        id: Number(lastInsertRowid),
        txId,
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
  attempts(txId: string): Attempt[] {
    const rows = this.#db.prepare(`SELECT * FROM attempts WHERE tx_id = ? ORDER BY id`).all(txId) as AttemptRow[]
    return rows.map(toAttempt)
  }

  markSubmitted(id: string, hash: Hash): boolean {
    return this.#update(`status = 'submitted', hash = @hash`, { id, hash })
  }

  markMined(id: string, receipt: Receipt): boolean {
    return this.#update(`status = @status, hash = @hash, receipt = @receipt`, {
      id,
      status: receipt.status === 'success' ? 'succeeded' : 'reverted',
      hash: receipt.transactionHash,
      receipt: JSON.stringify(receipt, bigintToString),
    })
  }

  markFailed(id: string, code: FailureCode, message: string): boolean {
    return this.#update(`status = 'failed', error_code = @code, error_message = @message`, { id, code, message })
  }

  /**
   * Nonces that belong to unfinished requests with at least one attempt a node may have
   * (not rejected). Used to rebuild the nonce pool after a restart (ADR 0009).
   */
  heldNonces(chainId: number, sender: Address): number[] {
    return this.#db
      .prepare(
        `SELECT DISTINCT nonce FROM transactions t
         WHERE chain_id = ? AND sender = ? AND ${UNFINISHED} AND nonce IS NOT NULL
           AND EXISTS (SELECT 1 FROM attempts a WHERE a.tx_id = t.id AND a.outcome != 'rejected')
         ORDER BY nonce`,
      )
      .pluck()
      .all(chainId, sender) as number[]
  }

  #update(assignments: string, params: Record<string, unknown> & { id: string }): boolean {
    const { changes } = this.#db
      .prepare(`UPDATE transactions SET ${assignments}, updated_at = @now WHERE id = @id AND ${UNFINISHED}`)
      .run({ ...params, now: this.#timestamp() })
    return changes === 1
  }

  #timestamp(): string {
    return this.#now().toISOString()
  }
}

function toTx(row: TxRow): TxRecord {
  return {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    chainId: row.chain_id,
    sender: row.sender as Address,
    to: row.to_address as Address,
    value: BigInt(row.value),
    data: row.data as Hex,
    status: row.status,
    nonce: row.nonce,
    gasLimit: row.gas_limit === null ? null : BigInt(row.gas_limit),
    hash: row.hash as Hash | null,
    receipt: row.receipt === null ? null : parseReceipt(row.receipt),
    error: row.error_code === null ? null : { code: row.error_code as FailureCode, message: row.error_message ?? '' },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    txId: row.tx_id,
    hash: row.hash as Hash,
    raw: row.raw as Hex,
    fees: parseFees(row.fees),
    outcome: row.outcome,
    createdAt: row.created_at,
  }
}

function parseFees(json: string): Fees {
  const fees = JSON.parse(json)
  return fees.type === 'legacy'
    ? { type: 'legacy', gasPrice: BigInt(fees.gasPrice) }
    : { type: 'eip1559', maxFeePerGas: BigInt(fees.maxFeePerGas), maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas) }
}

function parseReceipt(json: string): Receipt {
  const receipt = JSON.parse(json)
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: BigInt(receipt.blockNumber),
    blockHash: receipt.blockHash,
    gasUsed: BigInt(receipt.gasUsed),
    effectiveGasPrice: BigInt(receipt.effectiveGasPrice),
    status: receipt.status,
  }
}

function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
