import { createWalletClient, http, parseEther, parseGwei, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { startAnvil, unreachableUrl, type AnvilNode } from '../helpers/anvil'
import { ADDRESS_0, ADDRESS_1, KEY_0 } from '../helpers/keys'
import { nodeError, timeoutError } from '../helpers/rpc-errors'
import { nonce, type TxId } from '../../src/types'
import { ANVIL, createRuntime, type TestRuntime } from '../helpers/runtime'

let node: AnvilNode

beforeEach(async () => {
  node = await startAnvil()
})

afterEach(() => node.stop())

function outcomes(rt: TestRuntime, id: TxId) {
  return rt.store.attempts(id).map((attempt) => attempt.outcome)
}

describe('a request that reaches the chain', () => {
  test('is estimated, signed, saved, broadcast and marked submitted', async () => {
    const rt = await createRuntime(node.url)
    const tx = rt.submit()
    await rt.worker.idle()

    const [attempt] = rt.store.attempts(tx.id)
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'submitted', nonce: 0, gasLimit: 25_200n, hash: attempt.hash })
    expect(attempt.outcome).toBe('accepted')
    // anvil mines on arrival, so the chain has it under the saved hash
    expect(await rt.read.getTransactionReceipt({ hash: attempt.hash })).toMatchObject({ status: 'success' })
  })

  test('gives concurrent requests from one sender distinct nonces', async () => {
    const rt = await createRuntime(node.url)
    const txs = Array.from({ length: 5 }, () => rt.submit())
    await rt.worker.idle()

    expect(txs.map((tx) => rt.store.get(tx.id)!.nonce).sort((a, b) => a! - b!)).toEqual([0, 1, 2, 3, 4])
    // Pending, not latest: a transaction that reached anvil before the one below its nonce is mined a moment later.
    expect(await rt.read.getTransactionCount({ address: ADDRESS_0, blockTag: 'pending' })).toBe(5)
  })

  test('works on at most maxInFlightPerSender requests per sender, and starts the next when one finishes', async () => {
    const rt = await createRuntime(node.url, { chain: { maxInFlightPerSender: 2 } })
    await rt.testClient.setAutomine(false) // keep them submitted
    const txs = Array.from({ length: 3 }, () => rt.submit())
    await rt.worker.idle()
    expect(txs.map((tx) => rt.store.get(tx.id)!.status)).toEqual(['submitted', 'submitted', 'queued'])

    // Stand-in for the monitor finishing the first request.
    rt.store.markFailed(txs[0].id, { code: 'NONCE_TAKEN', nonce: nonce(0) })
    rt.worker.release(rt.store.get(txs[0].id)!)
    await rt.worker.idle()
    expect(rt.store.get(txs[2].id)!.status).toBe('submitted')
  })

  test('on a chain without a base fee, is priced and signed as a legacy transaction', async () => {
    const berlin = await startAnvil(['--hardfork', 'berlin'])
    try {
      const rt = await createRuntime(berlin.url)
      const tx = rt.submit()
      await rt.worker.idle()

      const [attempt] = rt.store.attempts(tx.id)
      expect(attempt.fees.type).toBe('legacy')
      expect(await rt.read.getTransactionReceipt({ hash: attempt.hash })).toMatchObject({
        status: 'success',
        type: 'legacy',
      })
    } finally {
      await berlin.stop()
    }
  })
})

describe('failures before anything is signed', () => {
  test('a call that would revert fails with ESTIMATION_REVERTED and uses no nonce', async () => {
    const rt = await createRuntime(node.url)
    const reverter: Address = '0x000000000000000000000000000000000000dEaD'
    await rt.testClient.setCode({ address: reverter, bytecode: '0x60006000fd' }) // REVERT(0, 0)
    const failed = rt.submit({ to: reverter })
    await rt.worker.idle()
    expect(rt.store.get(failed.id)).toMatchObject({ status: 'failed', failure: { code: 'ESTIMATION_REVERTED' } })
    expect(rt.store.attempts(failed.id)).toEqual([])

    const next = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(next.id)).toMatchObject({ status: 'submitted', nonce: 0 })
  })

  test('a base fee above the cap fails with FEE_ABOVE_CAP', async () => {
    const rt = await createRuntime(node.url)
    await rt.testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('200') })
    await rt.testClient.mine({ blocks: 1 })
    const tx = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(tx.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'FEE_ABOVE_CAP', capWei: parseGwei('100') },
    })
    expect(rt.store.attempts(tx.id)).toEqual([])
  })

  test('a sender without funds fails with INSUFFICIENT_FUNDS and keeps its nonce free', async () => {
    const rt = await createRuntime(node.url)
    await rt.testClient.setBalance({ address: ADDRESS_1, value: 0n })
    const broke = rt.submit({ sender: ADDRESS_1, to: ADDRESS_0 })
    await rt.worker.idle()
    expect(rt.store.get(broke.id)).toMatchObject({ status: 'failed', failure: { code: 'INSUFFICIENT_FUNDS' } })

    await rt.testClient.setBalance({ address: ADDRESS_1, value: parseEther('1') })
    const funded = rt.submit({ sender: ADDRESS_1, to: ADDRESS_0 })
    await rt.worker.idle()
    expect(rt.store.get(funded.id)).toMatchObject({ status: 'submitted', nonce: 0 })
  })

  test('an unreachable RPC fails with RPC_UNAVAILABLE once viem stops retrying', async () => {
    const rt = await createRuntime(await unreachableUrl(), { initialNonce: 0 })
    const tx = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'failed', failure: { code: 'RPC_UNAVAILABLE' } })
    expect(rt.store.attempts(tx.id)).toEqual([])
  })
})

describe('broadcast outcomes', () => {
  test('an unanswered broadcast keeps the nonce and leaves the request to the monitor', async () => {
    const rt = await createRuntime(node.url, { wrapSenders: () => [() => Promise.reject(timeoutError())] })
    const tx = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(tx.id)).toMatchObject({ status: 'submitted', nonce: 0 })
    expect(outcomes(rt, tx.id)).toEqual(['unknown'])
    expect(rt.senders.get(ANVIL, ADDRESS_0).pool.top).toBe(1)
  })

  test('a clear rejection fails the request and gives its nonce to the next one', async () => {
    let sends = 0
    const rt = await createRuntime(node.url, {
      wrapSenders: ([real]) => [
        async (raw) => {
          if (sends++ === 0) throw nodeError('intrinsic gas too low')
          return real(raw)
        },
      ],
    })
    const rejected = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(rejected.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'BROADCAST_REJECTED', nodeMessage: 'intrinsic gas too low' },
    })

    const next = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(next.id)).toMatchObject({ status: 'submitted', nonce: 0 })
  })

  test('when another tx already used the nonce, fails and resyncs the pool so the next request succeeds', async () => {
    const rt = await createRuntime(node.url)
    // Uses nonce 0 behind the pool's back.
    const outsider = createWalletClient({
      account: privateKeyToAccount(KEY_0),
      chain: anvil,
      transport: http(node.url),
    })
    await outsider.sendTransaction({ to: ADDRESS_1, value: 1n })

    const collided = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(collided.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'BROADCAST_REJECTED', nodeMessage: 'nonce too low' },
    })

    const next = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(next.id)).toMatchObject({ status: 'submitted', nonce: 1 })
  })

  test('a gap left by a rejected nonce is filled by the next request, which unblocks the one behind it', async () => {
    const rt = await createRuntime(node.url)
    const pool = rt.senders.get(ANVIL, ADDRESS_0).pool
    // Nonce 0 went to a request that was rejected after the next request had taken nonce 1.
    const rejectedNonce = pool.take()
    const waiting = rt.submit()
    await rt.worker.idle()
    pool.rollback(rejectedNonce)
    expect(rt.store.get(waiting.id)).toMatchObject({ status: 'submitted', nonce: 1 })
    expect(await rt.read.getTransactionCount({ address: ADDRESS_0 })).toBe(0) // nonce 1 can't be mined yet

    const next = rt.submit()
    await rt.worker.idle()
    expect(rt.store.get(next.id)).toMatchObject({ status: 'submitted', nonce: 0 })
    expect(await rt.read.getTransactionCount({ address: ADDRESS_0 })).toBe(2)
  })
})
