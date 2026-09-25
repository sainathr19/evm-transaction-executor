import { HttpRequestError, InvalidInputRpcError, RpcRequestError, TimeoutError, type Hash, type Hex } from 'viem'
import { describe, expect, test } from 'vitest'
import { broadcast, classifyNodeMessage, describeSendError } from '../../src/broadcast'
import type { Sender } from '../../src/rpc'

const RAW = '0x02f86b' as Hex
const HASH = `0x${'a'.repeat(64)}` as Hash

// The shapes viem produces for each case, as observed against anvil.
function nodeError(message: string) {
  return new InvalidInputRpcError(new RpcRequestError({ body: {}, error: { code: -32000, message }, url: 'http://node' }))
}
const timeout = () => new TimeoutError({ body: {}, url: 'http://node' })

describe('describeSendError', () => {
  test('a JSON-RPC error response is an answer, with the node message', () => {
    expect(describeSendError(nodeError('nonce too low'))).toEqual({ answered: true, message: 'nonce too low' })
  })

  test.each([
    ['a timeout', timeout()],
    ['an HTTP 429', new HttpRequestError({ url: 'http://node', status: 429, body: {} })],
    ['an HTTP 502', new HttpRequestError({ url: 'http://node', status: 502, body: {} })],
    ['a refused connection', new HttpRequestError({ url: 'http://node', body: {}, details: 'fetch failed' })],
    ['a non-viem error', new Error('socket hang up')],
  ])('%s is not an answer', (_case, error) => {
    expect(describeSendError(error)).toEqual({ answered: false })
  })
})

describe('classifyNodeMessage', () => {
  test.each([
    ['already known', 'already_known'], // geth
    ['transaction already imported', 'already_known'], // anvil
    ['AlreadyKnown', 'already_known'], // nethermind
    ['Known transaction', 'already_known'],
    ['nonce too low', 'nonce_too_low'],
    ['nonce too low: next nonce 5, tx nonce 3', 'nonce_too_low'],
    ['nonce too high', 'nonce_too_high'],
    ['insufficient funds for gas * price + value: balance 0, tx cost 21000', 'insufficient_funds'],
    ['Insufficient funds for gas * price + value', 'insufficient_funds'], // anvil
    ['replacement transaction underpriced', 'other'],
    ['intrinsic gas too low', 'other'],
  ])('"%s" → %s', (message, expected) => {
    expect(classifyNodeMessage(message)).toBe(expected)
  })
})

describe('broadcast', () => {
  // A fake RPC per URL: each call runs the next scripted response and is recorded.
  function nodes(...scripts: Array<Array<'accept' | 'timeout' | string>>) {
    const calls: Array<{ url: number; raw: Hex }> = []
    const senders: Sender[] = scripts.map((script, url) => async (raw) => {
      calls.push({ url, raw })
      const response = script.shift()
      if (response === 'accept') return HASH
      if (response === 'timeout') throw timeout()
      throw nodeError(response ?? 'no scripted response')
    })
    return { senders, calls }
  }

  test('an accepted first send is accepted', async () => {
    const { senders, calls } = nodes(['accept'], [])
    expect(await broadcast(RAW, senders, { delayMs: 0 })).toEqual({ outcome: 'accepted' })
    expect(calls).toEqual([{ url: 0, raw: RAW }])
  })

  test('"already known" counts as accepted', async () => {
    const { senders } = nodes(['transaction already imported'])
    expect(await broadcast(RAW, senders, { delayMs: 0 })).toEqual({ outcome: 'accepted' })
  })

  test('after an unanswered send, moves to the next URL', async () => {
    const { senders, calls } = nodes(['timeout'], ['accept'])
    expect(await broadcast(RAW, senders, { delayMs: 0 })).toEqual({ outcome: 'accepted' })
    expect(calls.map((call) => call.url)).toEqual([0, 1])
  })

  test('a clear rejection on the first send is a rejection, and nothing more is sent', async () => {
    const { senders, calls } = nodes(['insufficient funds for gas * price + value'], ['accept'])
    expect(await broadcast(RAW, senders, { delayMs: 0 })).toEqual({
      outcome: 'rejected',
      reason: 'insufficient_funds',
      message: 'insufficient funds for gas * price + value',
    })
    expect(calls.map((call) => call.url)).toEqual([0])
  })

  test('a rejection after an unanswered send is unknown: the first send may have landed', async () => {
    const { senders, calls } = nodes(['timeout'], ['nonce too low'])
    expect(await broadcast(RAW, senders, { delayMs: 0 })).toEqual({ outcome: 'unknown' })
    expect(calls.map((call) => call.url)).toEqual([0, 1])
  })

  test('is unknown when no send is answered, cycling through the URLs', async () => {
    const { senders, calls } = nodes(['timeout', 'timeout'], ['timeout'])
    expect(await broadcast(RAW, senders, { maxSends: 3, delayMs: 0 })).toEqual({ outcome: 'unknown' })
    expect(calls.map((call) => call.url)).toEqual([0, 1, 0])
  })
})
