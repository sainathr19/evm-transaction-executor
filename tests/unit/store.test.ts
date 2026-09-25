import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Hash, type Hex, parseGwei } from 'viem'
import { beforeEach, describe, expect, test } from 'vitest'
import { openDb } from '../../src/store/db'
import { type NewRequest, Store } from '../../src/store/store'
import { chainId, type Fees, nonce, type Receipt, type TxFailure, type TxId, txId } from '../../src/types'
import { ADDRESS_0, ADDRESS_1 } from '../helpers/keys'

const ANVIL = chainId(31337)
const MAINNET = chainId(1)
const HASH_A: Hash = `0x${'a'.repeat(64)}`
const HASH_B: Hash = `0x${'b'.repeat(64)}`
const RAW: Hex = '0x02f86b'
const EIP1559: Fees = { type: 'eip1559', maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
const RECEIPT: Receipt = {
  transactionHash: HASH_B,
  blockNumber: 12n,
  blockHash: HASH_A,
  gasUsed: 21_000n,
  effectiveGasPrice: 3_000_000_000n,
  status: 'success',
}

function request(overrides: Partial<NewRequest> = {}): NewRequest {
  return {
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    chainId: ANVIL,
    sender: ADDRESS_0,
    to: ADDRESS_1,
    value: 2n ** 70n, // too big for a 64-bit integer column
    data: '0xabcdef',
    ...overrides,
  }
}

let store: Store

beforeEach(() => {
  store = new Store(openDb(':memory:'))
})

function add(key: string, overrides: Partial<NewRequest> = {}) {
  return store.insertRequest(request({ idempotencyKey: key, ...overrides })).tx
}

function attempt(id: TxId, value: number, hash = HASH_A) {
  return store.recordAttempt(id, { nonce: nonce(value), gasLimit: 21_000n, hash, raw: RAW, fees: EIP1559 })
}

/** A request that has been broadcast: an attempt recorded at `value`, then marked submitted. */
function submittedAt(key: string, value: number, overrides: Partial<NewRequest> = {}) {
  const tx = add(key, overrides)
  attempt(tx.id, value)
  store.markSubmitted(tx.id, HASH_A)
  return tx
}

test('stores a new request as queued', () => {
  const inserted = store.insertRequest(request())
  expect(inserted.created).toBe(true)
  expect(store.get(inserted.tx.id)).toEqual({
    id: inserted.tx.id,
    kind: 'request',
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    chainId: ANVIL,
    sender: ADDRESS_0,
    to: ADDRESS_1,
    value: 2n ** 70n,
    data: '0xabcdef',
    status: 'queued',
    nonce: null,
    gasLimit: null,
    createdAt: inserted.tx.createdAt,
    updatedAt: inserted.tx.updatedAt,
  })
})

test('returns undefined for an unknown id', () => {
  expect(store.get(txId('missing'))).toBeUndefined()
})

test('returns the existing request when an idempotency key is reused', () => {
  const first = store.insertRequest(request())
  const second = store.insertRequest(request({ requestHash: 'different-body' }))
  expect(second.created).toBe(false)
  expect(second.tx.id).toBe(first.tx.id)
  expect(second.tx.requestHash).toBe('hash-1')
  expect(store.listByStatus(['queued'])).toHaveLength(1)
})

test('stores gap fills as queued 0-value transfers to the sender, with no idempotency key', () => {
  const first = store.insertGapFill(ANVIL, ADDRESS_0)
  const second = store.insertGapFill(ANVIL, ADDRESS_0)
  expect(first).toMatchObject({
    kind: 'gap_fill',
    status: 'queued',
    idempotencyKey: null,
    to: ADDRESS_0,
    value: 0n,
    data: '0x',
  })
  expect(second.id).not.toBe(first.id)
})

test('records an attempt together with the nonce and gas limit', () => {
  const tx = add('a')
  const saved = store.recordAttempt(tx.id, {
    nonce: nonce(7),
    gasLimit: 25_200n,
    hash: HASH_A,
    raw: RAW,
    fees: EIP1559,
  })
  expect(store.get(tx.id)).toMatchObject({ status: 'queued', nonce: 7, gasLimit: 25_200n })
  expect(store.attempts(tx.id)).toEqual([
    {
      id: saved.id,
      txId: tx.id,
      hash: HASH_A,
      raw: RAW,
      fees: EIP1559,
      outcome: 'pending',
      createdAt: saved.createdAt,
    },
  ])
})

test('keeps attempts in order, with their outcomes and fee types', () => {
  const tx = add('a')
  const first = attempt(tx.id, 7, HASH_A)
  store.recordAttempt(tx.id, {
    nonce: nonce(7),
    gasLimit: 21_000n,
    hash: HASH_B,
    raw: RAW,
    fees: { type: 'legacy', gasPrice: 5n },
  })
  store.setAttemptOutcome(first.id, 'accepted')

  const [a, b] = store.attempts(tx.id)
  expect([a.hash, a.outcome, b.hash, b.outcome]).toEqual([HASH_A, 'accepted', HASH_B, 'pending'])
  expect(b.fees).toEqual({ type: 'legacy', gasPrice: 5n })
})

describe('status changes', () => {
  test('submitted records the current hash', () => {
    const tx = add('a')
    attempt(tx.id, 7)
    expect(store.markSubmitted(tx.id, HASH_A)).toBe(true)
    expect(store.get(tx.id)).toMatchObject({ status: 'submitted', nonce: 7, gasLimit: 21_000n, hash: HASH_A })
  })

  test('a request without a recorded attempt cannot become submitted or mined', () => {
    const tx = add('a')
    expect(store.markSubmitted(tx.id, HASH_A)).toBe(false)
    expect(store.markMined(tx.id, RECEIPT)).toBe(false)
    expect(store.get(tx.id)?.status).toBe('queued')
  })

  test.each([
    ['success', 'succeeded'],
    ['reverted', 'reverted'],
  ] as const)('a %s receipt makes the request %s, with the mined hash', (receiptStatus, status) => {
    const tx = submittedAt('a', 7)
    const receipt = { ...RECEIPT, status: receiptStatus }
    expect(store.markMined(tx.id, receipt)).toBe(true)
    expect(store.get(tx.id)).toMatchObject({ status, nonce: 7, hash: HASH_B, receipt })
  })

  test.each<TxFailure>([
    { code: 'ESTIMATION_REVERTED', nodeMessage: 'execution reverted' },
    { code: 'FEE_ABOVE_CAP', capWei: parseGwei('100') },
    { code: 'RPC_UNAVAILABLE' },
    { code: 'INSUFFICIENT_FUNDS', nodeMessage: 'insufficient funds' },
    { code: 'BROADCAST_REJECTED', nodeMessage: 'intrinsic gas too low' },
    { code: 'NONCE_TAKEN', nonce: nonce(3) },
    { code: 'INTERNAL_ERROR', message: 'disk full' },
  ])('failed keeps its failure details: $code', (failure) => {
    const tx = add('a')
    expect(store.markFailed(tx.id, failure)).toBe(true)
    expect(store.get(tx.id)).toMatchObject({ status: 'failed', failure })
  })

  test('a final request never changes again', () => {
    const tx = submittedAt('a', 7)
    const failure: TxFailure = { code: 'NONCE_TAKEN', nonce: nonce(7) }
    store.markFailed(tx.id, failure)
    expect(store.markSubmitted(tx.id, HASH_B)).toBe(false)
    expect(store.markMined(tx.id, RECEIPT)).toBe(false)
    expect(store.markFailed(tx.id, { code: 'INTERNAL_ERROR', message: 'other' })).toBe(false)
    expect(store.get(tx.id)).toMatchObject({ status: 'failed', hash: HASH_A, failure })
  })
})

test('lists requests by status and chain, oldest first', () => {
  const a = add('a')
  const b = add('b', { chainId: MAINNET })
  const c = submittedAt('c', 0)
  expect(store.listByStatus(['queued']).map((tx) => tx.id)).toEqual([a.id, b.id])
  expect(store.listByStatus(['queued', 'submitted'], ANVIL).map((tx) => tx.id)).toEqual([a.id, c.id])
})

test('held nonces are those of unfinished requests with an attempt a node may have', () => {
  submittedAt('submitted', 3)

  const crashedBeforeBroadcast = add('saved-not-sent')
  attempt(crashedBeforeBroadcast.id, 4)

  const rejected = add('rejected')
  store.setAttemptOutcome(attempt(rejected.id, 5).id, 'rejected')

  const mined = submittedAt('mined', 1)
  store.markMined(mined.id, RECEIPT)

  add('no-attempt-yet')
  attempt(add('other-sender', { sender: ADDRESS_1 }).id, 9)
  attempt(add('other-chain', { chainId: MAINNET }).id, 8)

  expect(store.heldNonces(ANVIL, ADDRESS_0)).toEqual([3, 4])
})

test('keeps data across restarts, creating the database directory if needed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-'))
  try {
    const path = join(dir, 'nested', 'executor.db')
    const first = openDb(path)
    const { tx } = new Store(first).insertRequest(request())
    first.close()

    const reopened = openDb(path)
    expect(new Store(reopened).get(tx.id)).toMatchObject({ status: 'queued', value: 2n ** 70n })
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
