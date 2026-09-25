import { setTimeout as sleep } from 'node:timers/promises'
import { keccak256, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { nonce } from '../../src/types'
import { startAnvil, type AnvilNode } from '../helpers/anvil'
import { ADDRESS_0, ADDRESS_1, KEY_0 } from '../helpers/keys'
import { ANVIL, createRuntime } from '../helpers/runtime'

// Each test runs a first "process", then starts a second one on the same store, as after a restart.

let node: AnvilNode

beforeEach(async () => {
  node = await startAnvil()
})

afterEach(() => node.stop())

test('rebuilds a pool past a nonce held by a request that the mempool dropped', async () => {
  const before = await createRuntime(node.url)
  await before.testClient.setAutomine(false)
  const tx = before.submit()
  await before.worker.idle()
  const [attempt] = before.store.attempts(tx.id)
  await before.testClient.dropTransaction({ hash: attempt.hash }) // the chain no longer counts nonce 0 as pending

  const after = await createRuntime(node.url, { store: before.store })
  expect(after.senders.get(ANVIL, ADDRESS_0).pool.top).toBe(1)
  expect(after.senders.get(ANVIL, ADDRESS_1).pool.top).toBe(0)
})

test('treats an attempt saved just before a crash as possibly sent, and the monitor sends it', async () => {
  const before = await createRuntime(node.url)
  // Crash between saving the signed tx and broadcasting it: the attempt exists, nothing was sent.
  const { tx } = before.store.insertRequest({
    idempotencyKey: 'crashed',
    requestHash: 'h',
    chainId: ANVIL,
    sender: ADDRESS_0,
    to: ADDRESS_1,
    value: 1n,
    data: '0x',
  })
  const raw = await privateKeyToAccount(KEY_0).signTransaction({
    chainId: ANVIL,
    type: 'eip1559',
    to: ADDRESS_1,
    value: 1n,
    nonce: 0,
    gas: 25_200n,
    maxFeePerGas: parseGwei('3'),
    maxPriorityFeePerGas: parseGwei('1'),
  })
  const fees = { type: 'eip1559', maxFeePerGas: parseGwei('3'), maxPriorityFeePerGas: parseGwei('1') } as const
  before.store.recordAttempt(tx.id, { nonce: nonce(0), gasLimit: 25_200n, hash: keccak256(raw), raw, fees })

  const after = await createRuntime(node.url, { store: before.store, chain: { stuckAfterMs: 100 } })
  expect(after.store.get(tx.id)).toMatchObject({ status: 'submitted', nonce: 0, hash: keccak256(raw) })
  expect(after.senders.get(ANVIL, ADDRESS_0).pool.top).toBe(1)

  await sleep(100)
  await after.monitor.tick() // stuck: bumps are left, so it's replaced at nonce 0 and mined
  await after.monitor.tick()
  expect(after.store.get(tx.id)).toMatchObject({ status: 'succeeded', nonce: 0 })
})

test('hands queued requests that were never started back to the worker', async () => {
  const before = await createRuntime(node.url)
  const { tx } = before.store.insertRequest({
    idempotencyKey: 'waiting',
    requestHash: 'h',
    chainId: ANVIL,
    sender: ADDRESS_0,
    to: ADDRESS_1,
    value: 1n,
    data: '0x',
  })

  const after = await createRuntime(node.url, { store: before.store })
  await after.worker.idle()
  expect(after.store.get(tx.id)).toMatchObject({ status: 'submitted', nonce: 0 })
})

test('in-flight requests keep their slots, so queued ones still wait for them', async () => {
  const before = await createRuntime(node.url, { chain: { maxInFlightPerSender: 1 } })
  await before.testClient.setAutomine(false)
  const inFlight = before.submit()
  const waiting = before.submit()
  await before.worker.idle()

  const after = await createRuntime(node.url, { store: before.store, chain: { maxInFlightPerSender: 1 } })
  await after.worker.idle()
  expect(after.store.get(waiting.id)!.status).toBe('queued')

  await after.testClient.mine({ blocks: 1 })
  await after.monitor.tick() // the in-flight request is mined, which frees its slot
  await after.worker.idle()
  expect(after.store.get(inFlight.id)!.status).toBe('succeeded')
  expect(after.store.get(waiting.id)!.status).toBe('submitted')
})
