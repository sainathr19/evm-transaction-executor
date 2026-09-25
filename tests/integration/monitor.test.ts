import { setTimeout as sleep } from 'node:timers/promises'
import { createWalletClient, http, parseGwei, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { startAnvil, type AnvilNode } from '../helpers/anvil'
import { ADDRESS_0, ADDRESS_1, KEY_0 } from '../helpers/keys'
import { createRuntime, type TestRuntime } from '../helpers/runtime'

const STUCK_MS = 100

let node: AnvilNode

beforeEach(async () => {
  node = await startAnvil()
})

afterEach(() => node.stop())

/** Submits a request and waits until the worker has broadcast it. */
async function submitted(rt: TestRuntime, overrides = {}) {
  const tx = rt.submit(overrides)
  await rt.worker.idle()
  expect(rt.store.get(tx.id)!.status).toBe('submitted')
  return tx
}

describe('receipts', () => {
  test('marks a mined request succeeded and frees its slot for the next one', async () => {
    const rt = await createRuntime(node.url, { chain: { maxInFlightPerSender: 1 } })
    const first = await submitted(rt)
    const second = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(second.id)!.status).toBe('queued')

    await rt.monitor.tick()
    const [attempt] = rt.store.attempts(first.id)
    expect(rt.store.get(first.id)).toMatchObject({
      status: 'succeeded',
      hash: attempt.hash,
      receipt: { transactionHash: attempt.hash, status: 'success', gasUsed: 21_000n },
    })

    await rt.worker.idle()
    expect(rt.store.get(second.id)!.status).toBe('submitted')
  })

  test('marks a request reverted when its receipt says so', async () => {
    const rt = await createRuntime(node.url)
    await rt.testClient.setAutomine(false)
    const target: Address = '0x000000000000000000000000000000000000bEEF'
    const tx = await submitted(rt, { to: target })

    // The call reverts once it is mined, although it estimated fine.
    await rt.testClient.setCode({ address: target, bytecode: '0x60006000fd' })
    await rt.testClient.mine({ blocks: 1 })
    await rt.monitor.tick()
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'reverted', receipt: { status: 'reverted' } })
  })

  test('leaves a request alone while it is pending and not yet stuck', async () => {
    const rt = await createRuntime(node.url)
    await rt.testClient.setAutomine(false)
    const tx = await submitted(rt)
    await rt.monitor.tick()
    expect(rt.store.get(tx.id)!.status).toBe('submitted')
    expect(rt.store.attempts(tx.id)).toHaveLength(1)
  })
})

describe('stuck transactions', () => {
  test('replaces a stuck tx with higher fees at the same nonce, and records the attempt that is mined', async () => {
    const rt = await createRuntime(node.url, { chain: { stuckAfterMs: STUCK_MS } })
    await rt.testClient.setAutomine(false)
    const tx = await submitted(rt)

    await sleep(STUCK_MS)
    await rt.monitor.tick()
    const [original, replacement] = rt.store.attempts(tx.id)
    expect(replacement.outcome).toBe('accepted')
    expect(replacement.fees).toMatchObject({ type: 'eip1559' })
    if (original.fees.type === 'eip1559' && replacement.fees.type === 'eip1559') {
      expect(replacement.fees.maxFeePerGas).toBeGreaterThanOrEqual((original.fees.maxFeePerGas * 1125n) / 1000n)
      expect(replacement.fees.maxPriorityFeePerGas).toBeGreaterThan(original.fees.maxPriorityFeePerGas)
    }
    expect(rt.store.get(tx.id)).toMatchObject({ nonce: 0, hash: replacement.hash })

    await rt.testClient.mine({ blocks: 1 })
    await rt.monitor.tick()
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'succeeded', hash: replacement.hash })
  })

  test('recognises the original attempt when it is mined instead of the replacement', async () => {
    const rt = await createRuntime(node.url, { chain: { stuckAfterMs: STUCK_MS } })
    await rt.testClient.setAutomine(false)
    const tx = await submitted(rt)
    await sleep(STUCK_MS)
    await rt.monitor.tick()
    const [original, replacement] = rt.store.attempts(tx.id)

    // Some other node still had the original, and it wins.
    await rt.testClient.dropTransaction({ hash: replacement.hash })
    await rt.read.request({ method: 'eth_sendRawTransaction', params: [original.raw] })
    await rt.testClient.mine({ blocks: 1 })

    await rt.monitor.tick()
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'succeeded', hash: original.hash })
  })

  test('once bumps run out, resends the same signed tx, which recovers one dropped from the mempool', async () => {
    const rt = await createRuntime(node.url, { chain: { stuckAfterMs: STUCK_MS, gas: { maxBumps: 0 } } })
    await rt.testClient.setAutomine(false)
    const tx = await submitted(rt)
    const [attempt] = rt.store.attempts(tx.id)
    await rt.testClient.dropTransaction({ hash: attempt.hash })

    await sleep(STUCK_MS)
    await rt.monitor.tick()
    expect(rt.store.attempts(tx.id)).toHaveLength(1)

    await rt.testClient.mine({ blocks: 1 })
    await rt.monitor.tick()
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'succeeded', hash: attempt.hash })
  })

  test('never raises fees above the cap', async () => {
    // Base fee 1 gwei and tip 1 gwei give maxFeePerGas 3 gwei: already at this cap.
    const rt = await createRuntime(node.url, {
      chain: { stuckAfterMs: STUCK_MS, gas: { maxFeePerGasWei: parseGwei('3') } },
    })
    await rt.testClient.setAutomine(false)
    const tx = await submitted(rt)

    await sleep(STUCK_MS)
    await rt.monitor.tick()
    expect(rt.store.attempts(tx.id)).toHaveLength(1)
    expect(rt.store.get(tx.id)!.status).toBe('submitted')
  })
})

describe('nonce taken by another transaction', () => {
  test('fails with NONCE_TAKEN on the second poll that sees it, and resyncs the pool', async () => {
    const rt = await createRuntime(node.url)
    await rt.testClient.setAutomine(false)
    const tx = await submitted(rt)

    // Outside txs replace ours in the mempool at nonce 0, use nonce 1 too, and are mined.
    const outsider = createWalletClient({
      account: privateKeyToAccount(KEY_0),
      chain: anvil,
      transport: http(node.url),
    })
    for (const nonce of [0, 1]) {
      await outsider.sendTransaction({
        to: ADDRESS_1,
        value: 2n,
        nonce,
        maxFeePerGas: parseGwei('50'),
        maxPriorityFeePerGas: parseGwei('10'),
      })
    }
    await rt.testClient.mine({ blocks: 1 })

    await rt.monitor.tick()
    expect(rt.store.get(tx.id)!.status).toBe('submitted') // could be receipt lag: wait one more poll

    await rt.monitor.tick()
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'failed', error: { code: 'NONCE_TAKEN' } })
    expect(rt.senders.get(anvil.id, ADDRESS_0).pool.top).toBe(2) // resynced past both outside nonces
  })
})

describe('gap filler', () => {
  test('fills a gap that has been open for stuckAfterMs, without needing a slot', async () => {
    const rt = await createRuntime(node.url, { chain: { stuckAfterMs: STUCK_MS, maxInFlightPerSender: 1 } })
    const pool = rt.senders.get(anvil.id, ADDRESS_0).pool
    // Nonce 0 goes to a request that will be rejected; the next request gets nonce 1 and waits behind it.
    const rejectedNonce = pool.take()
    const waiting = await submitted(rt)
    expect(rt.store.get(waiting.id)!.nonce).toBe(1)
    pool.rollback(rejectedNonce)

    await rt.monitor.tick() // gap too new
    expect(rt.store.listByStatus(['queued', 'submitted', 'succeeded']).filter((tx) => tx.kind === 'gap_fill')).toEqual(
      [],
    )

    await sleep(STUCK_MS)
    await rt.monitor.tick()
    await rt.worker.idle()
    await rt.monitor.tick()

    const [fill] = rt.store.listByStatus(['succeeded']).filter((tx) => tx.kind === 'gap_fill')
    expect(fill).toMatchObject({ nonce: 0, to: ADDRESS_0, value: 0n })
    expect(rt.store.get(waiting.id)!.status).toBe('succeeded')
    expect(pool.gaps).toEqual([])
  })
})
