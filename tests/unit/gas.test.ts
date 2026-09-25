import { parseGwei } from 'viem'
import { describe, expect, test } from 'vitest'
import type { GasConfig } from '../../src/config/types'
import { applyGasBuffer, bumpFees, priceFees } from '../../src/executor/gas'

const GAS: GasConfig = {
  type: 'eip1559',
  gasLimitBufferPercent: 20,
  baseFeeMultiplier: 2,
  minPriorityFeeWei: 0n,
  maxFeePerGasWei: parseGwei('100'),
  bumpPercent: 12.5,
  maxBumps: 5,
}

describe('applyGasBuffer', () => {
  test.each([
    { estimate: 21_000n, percent: 20, limit: 25_200n },
    { estimate: 100_001n, percent: 20, limit: 120_002n }, // 120,001.2 rounds up
    { estimate: 1_000n, percent: 12.5, limit: 1_125n },
    { estimate: 50_000n, percent: 0, limit: 50_000n },
  ])('$estimate + $percent% = $limit', ({ estimate, percent, limit }) => {
    expect(applyGasBuffer(estimate, percent)).toBe(limit)
  })
})

describe('priceFees, EIP-1559', () => {
  const market = { type: 'eip1559', baseFee: parseGwei('10'), tip: parseGwei('1') } as const

  test('sets maxFeePerGas to baseFee × multiplier + tip', () => {
    expect(priceFees(market, GAS)).toEqual({
      ok: true,
      value: { type: 'eip1559', maxFeePerGas: parseGwei('21'), maxPriorityFeePerGas: parseGwei('1') },
    })
  })

  test('supports a fractional multiplier', () => {
    expect(priceFees(market, { ...GAS, baseFeeMultiplier: 1.5 })).toMatchObject({
      ok: true,
      value: { maxFeePerGas: parseGwei('16') },
    })
  })

  test('raises the tip to the configured minimum', () => {
    expect(priceFees({ ...market, tip: 0n }, { ...GAS, minPriorityFeeWei: parseGwei('2') })).toEqual({
      ok: true,
      value: { type: 'eip1559', maxFeePerGas: parseGwei('22'), maxPriorityFeePerGas: parseGwei('2') },
    })
  })

  test('clamps maxFeePerGas to the cap', () => {
    expect(priceFees(market, { ...GAS, maxFeePerGasWei: parseGwei('15') })).toMatchObject({
      ok: true,
      value: { maxFeePerGas: parseGwei('15') },
    })
  })

  test('accepts base fee + tip exactly at the cap', () => {
    expect(priceFees(market, { ...GAS, maxFeePerGasWei: parseGwei('11') })).toMatchObject({
      ok: true,
      value: { maxFeePerGas: parseGwei('11') },
    })
  })

  test('refuses when base fee + tip is already above the cap, and says what the cap was', () => {
    expect(priceFees(market, { ...GAS, maxFeePerGasWei: parseGwei('10') })).toEqual({
      ok: false,
      error: { reason: 'above_cap', capWei: parseGwei('10') },
    })
  })
})

describe('priceFees, legacy', () => {
  const legacy: GasConfig = { ...GAS, type: 'legacy', maxFeePerGasWei: parseGwei('10') }

  test('uses the node gas price', () => {
    expect(priceFees({ type: 'legacy', gasPrice: parseGwei('5') }, legacy)).toEqual({
      ok: true,
      value: { type: 'legacy', gasPrice: parseGwei('5') },
    })
  })

  test('refuses a gas price above the cap', () => {
    expect(priceFees({ type: 'legacy', gasPrice: parseGwei('11') }, legacy)).toMatchObject({
      ok: false,
      error: { reason: 'above_cap' },
    })
  })
})

describe('bumpFees', () => {
  const previous = { type: 'eip1559', maxFeePerGas: parseGwei('20'), maxPriorityFeePerGas: parseGwei('1') } as const

  test('raises both fee fields by bumpPercent', () => {
    expect(bumpFees(previous, null, GAS)).toEqual({
      ok: true,
      value: { type: 'eip1559', maxFeePerGas: parseGwei('22.5'), maxPriorityFeePerGas: parseGwei('1.125') },
    })
  })

  test('rounds up, so the raise is never below bumpPercent', () => {
    const tiny = { type: 'eip1559', maxFeePerGas: 9n, maxPriorityFeePerGas: 3n } as const
    // 9 × 1.125 = 10.125 and 3 × 1.125 = 3.375
    expect(bumpFees(tiny, null, GAS)).toEqual({
      ok: true,
      value: { type: 'eip1559', maxFeePerGas: 11n, maxPriorityFeePerGas: 4n },
    })
  })

  test('uses the market fee for each field where it is higher', () => {
    const market = { type: 'eip1559', maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: parseGwei('1') } as const
    expect(bumpFees(previous, market, GAS)).toEqual({
      ok: true,
      value: { type: 'eip1559', maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: parseGwei('1.125') },
    })
  })

  test('refuses a bump that would go above the cap', () => {
    const nearCap = { ...previous, maxFeePerGas: parseGwei('95') }
    expect(bumpFees(nearCap, null, GAS)).toEqual({
      ok: false,
      error: { reason: 'above_cap', capWei: parseGwei('100') },
    })
  })

  test('bumps a legacy gas price the same way', () => {
    const legacy: GasConfig = { ...GAS, type: 'legacy', maxFeePerGasWei: parseGwei('10') }
    const old = { type: 'legacy', gasPrice: parseGwei('8') } as const
    expect(bumpFees(old, null, legacy)).toEqual({ ok: true, value: { type: 'legacy', gasPrice: parseGwei('9') } })
    expect(bumpFees(old, { type: 'legacy', gasPrice: parseGwei('9.5') }, legacy)).toEqual({
      ok: true,
      value: { type: 'legacy', gasPrice: parseGwei('9.5') },
    })
    expect(bumpFees(old, null, { ...legacy, maxFeePerGasWei: parseGwei('8.5') })).toMatchObject({ ok: false })
  })
})
