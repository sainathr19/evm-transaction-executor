import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Hash, parseGwei } from 'viem'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type ApiError, type ApiResponse, type ApiTransaction, type AppDeps, buildApp } from '../../src/app'
import { buildSigners } from '../../src/config/signers'
import { createLogger } from '../../src/logger'
import { openDb } from '../../src/store/db'
import { Store } from '../../src/store/store'
import { chainId, nonce, type QueuedTx } from '../../src/types'
import { ADDRESS_0, ADDRESS_1, KEY_0 } from '../helpers/keys'

const ANVIL = chainId(31337)
const HASH_A: Hash = `0x${'a'.repeat(64)}`
const HASH_B: Hash = `0x${'b'.repeat(64)}`
const BODY = { network: 31337, sender: ADDRESS_0, to: ADDRESS_1, value: '1000', data: '0xabcd' } as const
/** The same request as stored, for tests that set up the store directly. */
const STORED = {
  idempotencyKey: 'k',
  requestHash: 'h',
  chainId: ANVIL,
  sender: ADDRESS_0,
  to: ADDRESS_1,
  value: 1000n,
  data: '0xabcd',
} as const

let server: Server
let baseUrl: string
let store: Store
let accepted: QueuedTx[]

beforeEach(async () => {
  store = new Store(openDb(':memory:'))
  accepted = []
  const deps: AppDeps = {
    store,
    chainIds: new Set([ANVIL]),
    signers: buildSigners([KEY_0]),
    onAccepted: (tx) => accepted.push(tx),
    logger: createLogger('silent'),
  }
  server = await new Promise<Server>((resolve) => {
    const listening = buildApp(deps).listen(0, '127.0.0.1', () => resolve(listening))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

function post(payload: unknown, key: string | null = 'key-1') {
  return fetch(`${baseUrl}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'idempotency-key': key }) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

/** The result of a success envelope, after checking the envelope's shape. */
async function resultOf(res: Response): Promise<ApiTransaction> {
  const body = (await res.json()) as ApiResponse<ApiTransaction>
  if (body.status !== 'ok') throw new Error(`expected a success envelope, got ${JSON.stringify(body)}`)
  expect(body.error).toBeNull()
  return body.result
}

/** The error of an error envelope, after checking the envelope's shape. */
async function errorOf(res: Response): Promise<ApiError> {
  const body = (await res.json()) as ApiResponse<ApiTransaction>
  if (body.status !== 'error') throw new Error(`expected an error envelope, got ${JSON.stringify(body)}`)
  expect(body.result).toBeNull()
  return body.error
}

describe('POST /transactions', () => {
  test('accepts a request: 202 with the queued transaction, stored and handed to the worker', async () => {
    const res = await post(BODY)
    expect(res.status).toBe(202)
    const { id, status } = await resultOf(res)
    expect(status).toBe('queued')
    expect(store.get(id)).toMatchObject({
      status: 'queued',
      chainId: 31337,
      sender: ADDRESS_0,
      to: ADDRESS_1,
      value: 1000n,
      data: '0xabcd',
    })
    expect(accepted.map((tx) => tx.id)).toEqual([id])
  })

  test('normalises addresses and data, and defaults data to 0x', async () => {
    const res = await post({ ...BODY, sender: ADDRESS_0.toLowerCase(), to: ADDRESS_1.toLowerCase(), data: undefined })
    const { id } = await resultOf(res)
    expect(store.get(id)).toMatchObject({ sender: ADDRESS_0, to: ADDRESS_1, data: '0x' })

    const upper = await post({ ...BODY, data: '0xABCD' }, 'key-2')
    expect(store.get((await resultOf(upper)).id)).toMatchObject({ data: '0xabcd' })
  })

  test('requires an Idempotency-Key', async () => {
    const res = await post(BODY, null)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({ code: 'IDEMPOTENCY_KEY_MISSING' })
    expect(accepted).toEqual([])
  })

  test('rejects an Idempotency-Key longer than 255 characters', async () => {
    const res = await post(BODY, 'k'.repeat(256))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  test.each([
    ['network as a string', { ...BODY, network: '31337' }, 'network'],
    ['network 0', { ...BODY, network: 0 }, 'network'],
    ['chainId instead of network', { ...BODY, network: undefined, chainId: 31337 }, 'network'],
    ['a short sender', { ...BODY, sender: '0x1234' }, 'sender'],
    ['a to that is not an address', { ...BODY, to: 'vitalik.eth' }, 'to'],
    ['a missing value', { ...BODY, value: undefined }, 'value'],
    ['a negative value', { ...BODY, value: '-1' }, 'value'],
    ['a fractional value', { ...BODY, value: '1.5' }, 'value'],
    ['a hex value', { ...BODY, value: '0x10' }, 'value'],
    ['a value with a leading zero', { ...BODY, value: '01' }, 'value'],
    ['a value above uint256', { ...BODY, value: (2n ** 256n).toString() }, 'value'],
    ['data with an odd number of digits', { ...BODY, data: '0xabc' }, 'data'],
    ['data without 0x', { ...BODY, data: 'abcd' }, 'data'],
    ['an unknown field', { ...BODY, gasLimit: '21000' }, ''],
  ])('rejects %s', async (_case, payload, path) => {
    const res = await post(payload)
    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.details?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]))
    expect(accepted).toEqual([])
  })

  test('rejects a body that is not JSON', async () => {
    const res = await post('{not json')
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  test('rejects a body over 256 kB', async () => {
    const res = await post({ ...BODY, data: `0x${'ab'.repeat(150_000)}` })
    expect(res.status).toBe(413)
    expect(await errorOf(res)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  })

  test('rejects a network that is not configured, listing the supported ones', async () => {
    const res = await post({ ...BODY, network: 1 })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({ code: 'UNSUPPORTED_NETWORK', details: { supported: [31337] } })
  })

  test('rejects a sender that has no key', async () => {
    const res = await post({ ...BODY, sender: ADDRESS_1 })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({ code: 'UNKNOWN_SENDER' })
  })

  test('answers a repeated request from the first one: 200, marked as a replay, not queued again', async () => {
    const first = await resultOf(await post(BODY))
    const replay = await post({ ...BODY, sender: ADDRESS_0.toLowerCase() }) // same request once normalised
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotent-replayed')).toBe('true')
    expect(await resultOf(replay)).toEqual(first)
    expect(accepted).toHaveLength(1)
  })

  test('rejects a reused key with a different body', async () => {
    await post(BODY)
    const res = await post({ ...BODY, value: '2000' })
    expect(res.status).toBe(422)
    expect(await errorOf(res)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(accepted).toHaveLength(1)
  })
})

describe('GET /transactions/:id', () => {
  async function get(id: string) {
    return fetch(`${baseUrl}/transactions/${id}`)
  }

  test('returns a queued request, with null for what it does not have yet', async () => {
    const { id } = await resultOf(await post(BODY))
    const res = await get(id)
    expect(res.status).toBe(200)
    expect(await resultOf(res)).toMatchObject({
      id,
      status: 'queued',
      network: 31337,
      sender: ADDRESS_0,
      to: ADDRESS_1,
      value: '1000',
      data: '0xabcd',
      nonce: null,
      gasLimit: null,
      hash: null,
      attempts: [],
      receipt: null,
      failure: null,
    })
  })

  test('returns a mined request with its attempts and receipt, amounts as decimal strings', async () => {
    const { tx } = store.insertRequest(STORED)
    const fees = { type: 'eip1559', maxFeePerGas: parseGwei('3'), maxPriorityFeePerGas: parseGwei('1') } as const
    store.recordAttempt(tx.id, { nonce: nonce(5), gasLimit: 25_200n, hash: HASH_A, raw: '0x02f8', fees })
    store.markSubmitted(tx.id, HASH_A)
    store.markMined(tx.id, {
      transactionHash: HASH_A,
      transactionIndex: 3,
      blockNumber: 12n,
      blockHash: HASH_B,
      from: ADDRESS_0,
      to: ADDRESS_1,
      contractAddress: null,
      gasUsed: 21_000n,
      cumulativeGasUsed: 84_000n,
      effectiveGasPrice: parseGwei('2'),
      status: 'success',
      type: 'eip1559',
      logsBloom: `0x${'0'.repeat(512)}`,
      logs: [{ address: ADDRESS_1, topics: [HASH_B], data: '0x2a', logIndex: 7 }],
    })

    const json = await resultOf(await get(tx.id))
    expect(json).toMatchObject({
      status: 'succeeded',
      nonce: 5,
      gasLimit: '25200',
      hash: HASH_A,
      attempts: [
        {
          hash: HASH_A,
          outcome: 'pending',
          fees: { type: 'eip1559', maxFeePerGas: '3000000000', maxPriorityFeePerGas: '1000000000' },
        },
      ],
      receipt: {
        transactionHash: HASH_A,
        transactionIndex: 3,
        blockNumber: '12',
        blockHash: HASH_B,
        from: ADDRESS_0,
        to: ADDRESS_1,
        contractAddress: null,
        gasUsed: '21000',
        cumulativeGasUsed: '84000',
        effectiveGasPrice: '2000000000',
        status: 'success',
        type: 'eip1559',
        logsBloom: `0x${'0'.repeat(512)}`,
        logs: [{ address: ADDRESS_1, topics: [HASH_B], data: '0x2a', logIndex: 7 }],
      },
      failure: null,
    })
    expect(json.attempts[0]).not.toHaveProperty('raw') // a signed tx is sensitive until its nonce is used (ADR 0003)
  })

  test('returns a failed request with its failure explained', async () => {
    const { tx } = store.insertRequest(STORED)
    store.markFailed(tx.id, { code: 'FEE_ABOVE_CAP', capWei: parseGwei('100') })
    const json = await resultOf(await get(tx.id))
    expect(json).toMatchObject({ status: 'failed', failure: { code: 'FEE_ABOVE_CAP', capWei: '100000000000' } })
    expect(json.failure?.message).toContain('100000000000')
  })

  test('answers 404 for an unknown id', async () => {
    const res = await get('no-such-id')
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND' })
  })
})

test('GET /health answers Online', async () => {
  const res = await fetch(`${baseUrl}/health`)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('Online')
})

test('answers 404 as JSON for an unknown route', async () => {
  const res = await fetch(`${baseUrl}/nope`)
  expect(res.status).toBe(404)
  expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND' })
})

describe('every JSON response has the same envelope, whatever the HTTP status', () => {
  test('success: status, result and a null error', async () => {
    const body = (await (await post(BODY)).json()) as object
    expect(Object.keys(body)).toEqual(['status', 'result', 'error'])
    expect(body).toMatchObject({ status: 'ok', error: null })
  })

  test('error: status, a null result, and an error with code, message and details', async () => {
    const body = (await (await fetch(`${baseUrl}/nope`)).json()) as object
    expect(body).toEqual({
      status: 'error',
      result: null,
      error: { code: 'NOT_FOUND', message: 'no such route', details: null },
    })
  })
})
