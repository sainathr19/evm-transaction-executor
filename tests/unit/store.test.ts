import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hash, Hex } from 'viem'
import { beforeEach, describe, expect, test } from 'vitest'
import { openDb } from '../../src/store/db'
import { Store, type NewRequest } from '../../src/store/store'
import type { Fees, Receipt } from '../../src/types'
import { ADDRESS_0, ADDRESS_1 } from '../helpers/keys'

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
    chainId: 31337,
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

function attempt(txId: string, nonce: number, hash = HASH_A) {
  return store.recordAttempt(txId, { nonce, gasLimit: 21_000n, hash, raw: RAW, fees: EIP1559 })
}

test('stores a new request as queued', () => {
  const { tx, created } = store.insertRequest(request())
  expect(created).toBe(true)
  expect(store.get(tx.id)).toMatchObject({
    kind: 'request',
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    status: 'queued',
    chainId: 31337,
    sender: ADDRESS_0,
    to: ADDRESS_1,
    value: 2n ** 70n,
    data: '0xabcdef',
    nonce: null,
    gasLimit: null,
    hash: null,
    receipt: null,
    error: null,
  })
})

test('returns undefined for an unknown id', () => {
  expect(store.get('missing')).toBeUndefined()
})

test('returns the existing request when an idempotency key is reused', () => {
  const first = store.insertRequest(request())
  const second = store.insertRequest(request({ requestHash: 'different-body' }))
  expect(second.created).toBe(false)
  expect(second.tx.id).toBe(first.tx.id)
  expect(second.tx.requestHash).toBe('hash-1')
  expect(store.listByStatus(['queued'])).toHaveLength(1)
})

test('stores gap fills as 0-value transfers to the sender, with no idempotency key', () => {
  const first = store.insertGapFill(31337, ADDRESS_0)
  const second = store.insertGapFill(31337, ADDRESS_0)
  expect(first).toMatchObject({ kind: 'gap_fill', idempotencyKey: null, to: ADDRESS_0, value: 0n, data: '0x' })
  expect(second.id).not.toBe(first.id)
})

test('records an attempt together with the nonce and gas limit', () => {
  const tx = add('a')
  const saved = store.recordAttempt(tx.id, { nonce: 7, gasLimit: 25_200n, hash: HASH_A, raw: RAW, fees: EIP1559 })
  expect(store.get(tx.id)).toMatchObject({ nonce: 7, gasLimit: 25_200n })
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
    nonce: 7,
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
    expect(store.markSubmitted(tx.id, HASH_A)).toBe(true)
    expect(store.get(tx.id)).toMatchObject({ status: 'submitted', hash: HASH_A })
  })

  test.each([
    ['success', 'succeeded'],
    ['reverted', 'reverted'],
  ] as const)('a %s receipt makes the request %s, with the mined hash', (receiptStatus, status) => {
    const tx = add('a')
    store.markSubmitted(tx.id, HASH_A)
    const receipt = { ...RECEIPT, status: receiptStatus }
    expect(store.markMined(tx.id, receipt)).toBe(true)
    expect(store.get(tx.id)).toMatchObject({ status, hash: HASH_B, receipt })
  })

  test('failed records the error code and message', () => {
    const tx = add('a')
    expect(store.markFailed(tx.id, 'INSUFFICIENT_FUNDS', 'insufficient funds')).toBe(true)
    expect(store.get(tx.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds' },
    })
  })

  test('a final request never changes again', () => {
    const tx = add('a')
    store.markFailed(tx.id, 'INSUFFICIENT_FUNDS', 'insufficient funds')
    expect(store.markSubmitted(tx.id, HASH_A)).toBe(false)
    expect(store.markMined(tx.id, RECEIPT)).toBe(false)
    expect(store.markFailed(tx.id, 'INTERNAL_ERROR', 'other')).toBe(false)
    expect(store.get(tx.id)).toMatchObject({
      status: 'failed',
      hash: null,
      receipt: null,
      error: { code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds' },
    })
  })
})

test('lists requests by status and chain, oldest first', () => {
  const a = add('a')
  const b = add('b', { chainId: 1 })
  const c = add('c')
  store.markSubmitted(c.id, HASH_A)
  expect(store.listByStatus(['queued']).map((tx) => tx.id)).toEqual([a.id, b.id])
  expect(store.listByStatus(['queued', 'submitted'], 31337).map((tx) => tx.id)).toEqual([a.id, c.id])
})

test('held nonces are those of unfinished requests with an attempt a node may have', () => {
  const submitted = add('submitted')
  attempt(submitted.id, 3)
  store.markSubmitted(submitted.id, HASH_A)

  const crashedBeforeBroadcast = add('saved-not-sent')
  attempt(crashedBeforeBroadcast.id, 4)

  const rejected = add('rejected')
  store.setAttemptOutcome(attempt(rejected.id, 5).id, 'rejected')

  const mined = add('mined')
  attempt(mined.id, 1)
  store.markMined(mined.id, RECEIPT)

  add('no-attempt-yet')
  attempt(add('other-sender', { sender: ADDRESS_1 }).id, 9)
  attempt(add('other-chain', { chainId: 1 }).id, 8)

  expect(store.heldNonces(31337, ADDRESS_0)).toEqual([3, 4])
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
