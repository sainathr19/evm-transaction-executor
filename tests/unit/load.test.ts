import { inspect } from 'node:util'
import { parseGwei } from 'viem'
import { expect, test } from 'vitest'
import { DEFAULTS } from '../../src/config/defaults'
import { loadConfig } from '../../src/config/load'
import { chainId } from '../../src/types'
import { ADDRESS_0, KEY_0 } from '../helpers/keys'

test('enables any chain that has an RPC URL, with the default settings', () => {
  const config = loadConfig({ RPC_URL_999999: 'http://a.example,http://b.example', SIGNER_PRIVATE_KEYS: KEY_0 })
  expect([...config.chains.keys()]).toEqual([999999])
  expect(config.chains.get(chainId(999999))).toEqual({
    chainId: 999999,
    rpcUrls: ['http://a.example', 'http://b.example'],
    ...DEFAULTS,
  })
  expect([...config.signers.keys()]).toEqual([ADDRESS_0])
})

test('applies per-chain settings from env over the defaults', () => {
  const config = loadConfig({
    RPC_URL_31337: 'http://127.0.0.1:8545',
    POLL_INTERVAL_MS_31337: '500',
    STUCK_AFTER_MS_31337: '5000',
    MAX_FEE_GWEI_31337: '100',
    SIGNER_PRIVATE_KEYS: KEY_0,
  })
  expect(config.chains.get(chainId(31337))).toEqual({
    chainId: 31337,
    rpcUrls: ['http://127.0.0.1:8545'],
    ...DEFAULTS,
    pollIntervalMs: 500,
    stuckAfterMs: 5_000,
    gas: { ...DEFAULTS.gas, maxFeePerGasWei: parseGwei('100') },
  })
})

test('defaults the fee cap to 500 gwei', () => {
  expect(DEFAULTS.gas.maxFeePerGasWei).toBe(parseGwei('500'))
})

test('removes the keys from env and keeps them out of the returned config', () => {
  const env: Record<string, string | undefined> = {
    RPC_URL_31337: 'http://127.0.0.1:8545',
    SIGNER_PRIVATE_KEYS: KEY_0,
  }
  const config = loadConfig(env)
  expect(env).not.toHaveProperty('SIGNER_PRIVATE_KEYS')
  expect(inspect(config, { depth: 10, showHidden: true })).not.toContain(KEY_0.slice(2))
})
