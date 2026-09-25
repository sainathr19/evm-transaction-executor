import { describe, expect, test } from 'vitest'
import { NoncePool } from '../../src/executor/nonce-pool'

function fakeClock() {
  let now = 0
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

function takeN(pool: NoncePool, n: number): number[] {
  return Array.from({ length: n }, () => pool.take())
}

test('hands out consecutive nonces starting from the top', () => {
  const pool = new NoncePool(5)
  expect(takeN(pool, 3)).toEqual([5, 6, 7])
  expect(pool.top).toBe(8)
})

test('hands a rolled-back nonce out again before any new one', () => {
  const pool = new NoncePool(5)
  takeN(pool, 3) // 5, 6, 7
  pool.rollback(6)
  expect(pool.gaps).toEqual([6])
  expect(takeN(pool, 2)).toEqual([6, 8])
})

test('merges rolled-back nonces that reach the top', () => {
  const pool = new NoncePool(5)
  takeN(pool, 3) // 5, 6, 7 held; top 8
  pool.rollback(6) // a gap: 7 is still held
  pool.rollback(7) // 6, 7, 8 are all available, so the top drops to 6
  expect(pool.gaps).toEqual([])
  expect(pool.top).toBe(6)
  expect(pool.take()).toBe(6)
})

test('ignores a rollback of a nonce that is already available', () => {
  const pool = new NoncePool(5)
  takeN(pool, 2) // 5, 6
  pool.rollback(5)
  pool.rollback(5)
  expect(takeN(pool, 2)).toEqual([5, 7])
})

describe('reset', () => {
  test('drops available nonces the chain has already used', () => {
    const pool = new NoncePool(5)
    takeN(pool, 3) // 5, 6, 7
    pool.rollback(5)
    pool.reset(7)
    expect(pool.gaps).toEqual([])
    expect(pool.take()).toBe(8)
  })

  test('keeps available nonces the chain has not used', () => {
    const pool = new NoncePool(5)
    takeN(pool, 3) // 5, 6, 7
    pool.rollback(6)
    pool.reset(5)
    expect(pool.gaps).toEqual([6])
  })

  test('moves the top up when the chain is ahead', () => {
    const pool = new NoncePool(5)
    pool.reset(12)
    expect(pool.take()).toBe(12)
  })
})

describe('takeGap', () => {
  test('returns a gap only once it has been open for the given time', () => {
    const clock = fakeClock()
    const pool = new NoncePool(5, [], clock.now)
    takeN(pool, 2) // 5, 6
    pool.rollback(5)

    clock.advance(999)
    expect(pool.hasGap(1_000)).toBe(false)
    expect(pool.takeGap(1_000)).toBeUndefined()

    clock.advance(1)
    expect(pool.hasGap(1_000)).toBe(true)
    expect(pool.takeGap(1_000)).toBe(5)
    expect(pool.gaps).toEqual([])
    expect(pool.take()).toBe(7)
  })

  test('never returns the top', () => {
    const pool = new NoncePool(5)
    expect(pool.takeGap(0)).toBeUndefined()
    expect(pool.take()).toBe(5)
  })

  test('a gap that reopens waits the full time again', () => {
    const clock = fakeClock()
    const pool = new NoncePool(5, [], clock.now)
    takeN(pool, 2) // 5, 6
    pool.rollback(5)
    clock.advance(1_000)
    expect(pool.takeGap(1_000)).toBe(5)

    pool.rollback(5) // the gap filler was rejected
    expect(pool.takeGap(1_000)).toBeUndefined()
    clock.advance(1_000)
    expect(pool.takeGap(1_000)).toBe(5)
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
    const pool = NoncePool.rebuild({ confirmed, pending, held })
    expect(pool.top).toBe(top)
    expect(pool.gaps).toEqual(gaps)
  })

  test('gaps found at startup wait before the gap filler may take them', () => {
    const clock = fakeClock()
    const pool = NoncePool.rebuild({ confirmed: 10, pending: 10, held: [11] }, clock.now)
    expect(pool.takeGap(1_000)).toBeUndefined()
    clock.advance(1_000)
    expect(pool.takeGap(1_000)).toBe(10)
  })
})
