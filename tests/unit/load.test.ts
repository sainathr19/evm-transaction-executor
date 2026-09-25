import { inspect } from 'node:util'
import { anvil, sepolia } from 'viem/chains'
import { expect, test } from 'vitest'
import { loadConfig } from '../../src/config/load'
import type { ChainFile } from '../../src/config/types'
import { chainId } from '../../src/types'
import { expectConfigError } from '../helpers/errors'
import { ADDRESS_0, KEY_0 } from '../helpers/keys'

const FILES: ChainFile[] = [
  { chain: anvil, pollIntervalMs: 123, gas: { maxFeePerGasWei: 7n } },
  { chain: sepolia, gas: { maxFeePerGasWei: 9n } },
]

test('enables only the chains that have an RPC URL, with their settings and URLs', () => {
  const config = loadConfig({ RPC_URL_31337: 'http://a.example,http://b.example', SIGNER_PRIVATE_KEYS: KEY_0 }, FILES)
  expect([...config.chains.keys()]).toEqual([31337])
  expect(config.chains.get(chainId(31337))).toMatchObject({
    pollIntervalMs: 123,
    gas: { maxFeePerGasWei: 7n },
    rpcUrls: ['http://a.example', 'http://b.example'],
  })
  expect([...config.signers.keys()]).toEqual([ADDRESS_0])
})

test('uses the chain files in src/config/chains by default', () => {
  const config = loadConfig({ RPC_URL_84532: 'https://a.example', SIGNER_PRIVATE_KEYS: KEY_0 })
  expect([...config.chains.keys()]).toEqual([84532])
})

test('refuses an RPC_URL for a chain that has no config file', () => {
  const error = expectConfigError(() =>
    loadConfig({ RPC_URL_999999: 'http://127.0.0.1:8545', SIGNER_PRIVATE_KEYS: KEY_0 }, FILES),
  )
  expect(error.message).toContain('999999')
})

test('removes the keys from env and keeps them out of the returned config', () => {
  const env: Record<string, string | undefined> = {
    RPC_URL_31337: 'http://127.0.0.1:8545',
    SIGNER_PRIVATE_KEYS: KEY_0,
  }
  const config = loadConfig(env, FILES)
  expect(env).not.toHaveProperty('SIGNER_PRIVATE_KEYS')
  expect(inspect(config, { depth: 10, showHidden: true })).not.toContain(KEY_0.slice(2))
})
