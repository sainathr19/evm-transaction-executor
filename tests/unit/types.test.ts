import { parseGwei } from 'viem'
import { describe, expect, test } from 'vitest'
import { chainId, describeFailure, nonce, type TxFailure, txId } from '../../src/types'

describe('branded values are checked where they enter the service', () => {
  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('chainId rejects %s', (value) => {
    expect(() => chainId(value)).toThrow(TypeError)
  })

  test.each([-1, 1.5, Number.NaN])('nonce rejects %s', (value) => {
    expect(() => nonce(value)).toThrow(TypeError)
  })

  test('txId rejects an empty string', () => {
    expect(() => txId('')).toThrow(TypeError)
  })

  test('valid values pass through unchanged', () => {
    expect([chainId(31337), nonce(0), txId('abc')]).toEqual([31337, 0, 'abc'])
  })
})

describe('describeFailure', () => {
  test.each<[TxFailure, string]>([
    [{ code: 'ESTIMATION_REVERTED', nodeMessage: 'execution reverted: paused' }, 'execution reverted: paused'],
    [{ code: 'FEE_ABOVE_CAP', capWei: parseGwei('5') }, '5000000000'],
    [{ code: 'RPC_UNAVAILABLE' }, 'RPC'],
    [{ code: 'INSUFFICIENT_FUNDS', nodeMessage: 'insufficient funds for gas' }, 'insufficient funds for gas'],
    [{ code: 'BROADCAST_REJECTED', nodeMessage: 'intrinsic gas too low' }, 'intrinsic gas too low'],
    [{ code: 'NONCE_TAKEN', nonce: nonce(7) }, 'nonce 7'],
    [{ code: 'INTERNAL_ERROR', message: 'disk full' }, 'disk full'],
  ])('%o mentions its details', (failure, detail) => {
    expect(describeFailure(failure)).toContain(detail)
  })
})
