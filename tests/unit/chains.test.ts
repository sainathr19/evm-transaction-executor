import { anvil } from 'viem/chains'
import { expect, test } from 'vitest'
import { CHAIN_FILES } from '../../src/config/chains'
import { DEFAULTS, withDefaults } from '../../src/config/defaults'

test('chain files have unique chain ids and a positive fee cap', () => {
  const ids = CHAIN_FILES.map((file) => file.chain.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const file of CHAIN_FILES) expect(file.gas.maxFeePerGasWei).toBeGreaterThan(0n)
})

test('withDefaults fills in unset values and keeps overrides', () => {
  const config = withDefaults({
    chain: anvil,
    stuckAfterMs: 1_000,
    gas: { maxFeePerGasWei: 5n, bumpPercent: 20 },
  })

  expect(config.stuckAfterMs).toBe(1_000)
  expect(config.pollIntervalMs).toBe(DEFAULTS.pollIntervalMs)
  expect(config.maxInFlightPerSender).toBe(DEFAULTS.maxInFlightPerSender)
  expect(config.gas).toEqual({ ...DEFAULTS.gas, maxFeePerGasWei: 5n, bumpPercent: 20 })
})
