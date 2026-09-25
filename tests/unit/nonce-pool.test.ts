import { describe, expect, test } from 'vitest'
import { NoncePool } from '../../src/executor/nonce-pool'
import { nonce } from '../../src/types'

function takeN(pool: NoncePool, n: number): number[] {
  return Array.from({ length: n }, () => pool.take())
}

test('hands out consecutive nonces starting from the top', () => {
  const pool = new NoncePool(nonce(5))
  expect(takeN(pool, 3)).toEqual([5, 6, 7])
  expect(pool.top).toBe(8)
})

test('hands a rolled-back nonce out again before any new one', () => {
  const pool = new NoncePool(nonce(5))
  takeN(pool, 3) // 5, 6, 7
  pool.rollback(nonce(6))
  expect(pool.gaps).toEqual([6])
  expect(takeN(pool, 2)).toEqual([6, 8])
})

test('merges rolled-back nonces that reach the top', () => {
  const pool = new NoncePool(nonce(5))
  takeN(pool, 3) // 5, 6, 7 held; top 8
  pool.rollback(nonce(6)) // a gap: 7 is still held
  pool.rollback(nonce(7)) // 6, 7, 8 are all available, so the top drops to 6
  expect(pool.gaps).toEqual([])
  expect(pool.top).toBe(6)
  expect(pool.take()).toBe(6)
})

test('ignores a rollback of a nonce that is already available', () => {
  const pool = new NoncePool(nonce(5))
  takeN(pool, 2) // 5, 6
  pool.rollback(nonce(5))
  pool.rollback(nonce(5))
  expect(takeN(pool, 2)).toEqual([5, 7])
})

describe('reset', () => {
  test('drops available nonces the chain has already used', () => {
    const pool = new NoncePool(nonce(5))
    takeN(pool, 3) // 5, 6, 7
    pool.rollback(nonce(5))
    pool.reset(nonce(7))
    expect(pool.gaps).toEqual([])
    expect(pool.take()).toBe(8)
  })

  test('keeps available nonces the chain has not used', () => {
    const pool = new NoncePool(nonce(5))
    takeN(pool, 3) // 5, 6, 7
    pool.rollback(nonce(6))
    pool.reset(nonce(5))
    expect(pool.gaps).toEqual([6])
  })

  test('moves the top up when the chain is ahead', () => {
    const pool = new NoncePool(nonce(5))
    pool.reset(nonce(12))
    expect(pool.take()).toBe(12)
  })
})

describe('rebuild after a restart', () => {
  test.each([
    {
      case: 'all our pending txs are in the mempool',
      confirmed: 10,
      pending: 13,
      held: [10, 11, 12],
      top: 13,
      gaps: [],
    },
    { case: 'a nonce between held ones is available', confirmed: 10, pending: 13, held: [10, 12], top: 13, gaps: [11] },
    {
      case: 'held txs dropped from the mempool keep their nonces',
      confirmed: 10,
      pending: 10,
      held: [10, 11],
      top: 12,
      gaps: [],
    },
    {
      case: 'available nonces below a held one are gaps',
      confirmed: 10,
      pending: 10,
      held: [12],
      top: 13,
      gaps: [10, 11],
    },
    {
      case: 'held nonces the chain already used are ignored',
      confirmed: 10,
      pending: 10,
      held: [8],
      top: 10,
      gaps: [],
    },
  ])('$case', ({ confirmed, pending, held, top, gaps }) => {
    const pool = NoncePool.rebuild({ confirmed: nonce(confirmed), pending: nonce(pending), held: held.map(nonce) })
    expect(pool.top).toBe(top)
    expect(pool.gaps).toEqual(gaps)
  })
})
