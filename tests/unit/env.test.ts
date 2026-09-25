import { parseGwei } from 'viem'
import { describe, expect, test } from 'vitest'
import { parseEnv } from '../../src/config/env'
import { chainId } from '../../src/types'
import { expectConfigError } from '../helpers/errors'
import { KEY_0, KEY_1 } from '../helpers/keys'

const BASE = { RPC_URL_31337: 'http://127.0.0.1:8545', SIGNER_PRIVATE_KEYS: KEY_0 }

test('reads RPC URLs per chain id, in fallback order, ignoring blanks', () => {
  const env = parseEnv({ ...BASE, RPC_URL_84532: ' https://a.example , https://b.example ,' })
  expect(env.chains).toEqual(
    new Map([
      [31337, { rpcUrls: ['http://127.0.0.1:8545'] }],
      [84532, { rpcUrls: ['https://a.example', 'https://b.example'] }],
    ]),
  )
})

test('reads optional per-chain settings', () => {
  const env = parseEnv({
    ...BASE,
    RPC_URL_84532: 'https://a.example',
    POLL_INTERVAL_MS_31337: '500',
    STUCK_AFTER_MS_31337: '5000',
    MAX_FEE_GWEI_84532: '0.05',
  })
  expect(env.chains.get(chainId(31337))).toEqual({
    rpcUrls: ['http://127.0.0.1:8545'],
    pollIntervalMs: 500,
    stuckAfterMs: 5_000,
  })
  expect(env.chains.get(chainId(84532))).toEqual({
    rpcUrls: ['https://a.example'],
    maxFeePerGasWei: parseGwei('0.05'),
  })
})

test('reads a comma-separated list of keys', () => {
  expect(parseEnv({ ...BASE, SIGNER_PRIVATE_KEYS: `${KEY_0}, ${KEY_1},` }).privateKeys).toEqual([KEY_0, KEY_1])
})

test('reads server settings', () => {
  const env = parseEnv({ ...BASE, HOST: '0.0.0.0', PORT: '8080', DB_PATH: '/tmp/x.db', LOG_LEVEL: 'debug' })
  expect(env).toMatchObject({ host: '0.0.0.0', port: 8080, dbPath: '/tmp/x.db', logLevel: 'debug' })
})

test('defaults server settings to localhost and port 3000', () => {
  expect(parseEnv(BASE)).toMatchObject({
    host: '127.0.0.1',
    port: 3000,
    dbPath: './data/executor.db',
    logLevel: 'info',
  })
})

describe('refuses to start', () => {
  test('without any RPC_URL_<chainId>', () => {
    expect(expectConfigError(() => parseEnv({ SIGNER_PRIVATE_KEYS: KEY_0 })).message).toContain('RPC_URL_<chainId>')
  })

  test.each(['RPC_URL_BASE', 'RPC_URL_0', 'RPC_URL_007', 'MAX_FEE_GWEI_BASE'])('when %s is not a chain id', (name) => {
    expect(expectConfigError(() => parseEnv({ ...BASE, [name]: 'https://a.example' })).message).toContain(name)
  })

  test.each([
    ['not a URL', 'rpc.example/secret-api-key'],
    ['not http(s)', 'wss://rpc.example/secret-api-key'],
  ])('when an RPC URL is %s, without echoing it', (_case, url) => {
    const error = expectConfigError(() => parseEnv({ ...BASE, RPC_URL_1: `https://ok.example,${url}` }))
    expect(error.message).toContain('RPC_URL_1 entry 2')
    expect(error.message).not.toContain('secret-api-key')
  })

  test.each(['POLL_INTERVAL_MS_1', 'STUCK_AFTER_MS_1', 'MAX_FEE_GWEI_1'])(
    'when %s is set for a chain with no RPC URL',
    (name) => {
      const error = expectConfigError(() => parseEnv({ ...BASE, [name]: '10' }))
      expect(error.message).toContain(name)
      expect(error.message).toContain('RPC_URL_1')
    },
  )

  test.each([
    ['POLL_INTERVAL_MS_31337', '0'],
    ['POLL_INTERVAL_MS_31337', '1.5'],
    ['STUCK_AFTER_MS_31337', 'abc'],
    ['STUCK_AFTER_MS_31337', ''],
    ['MAX_FEE_GWEI_31337', '0'],
    ['MAX_FEE_GWEI_31337', '-1'],
    ['MAX_FEE_GWEI_31337', '1e3'],
    ['MAX_FEE_GWEI_31337', '0.0000000001'], // below 1 wei
  ])('when %s=%s', (name, value) => {
    expect(expectConfigError(() => parseEnv({ ...BASE, [name]: value })).message).toContain(name)
  })

  test('without SIGNER_PRIVATE_KEYS', () => {
    const error = expectConfigError(() => parseEnv({ RPC_URL_31337: 'http://127.0.0.1:8545' }))
    expect(error.message).toContain('SIGNER_PRIVATE_KEYS')
  })

  test('on a malformed key, without echoing it', () => {
    const error = expectConfigError(() => parseEnv({ ...BASE, SIGNER_PRIVATE_KEYS: `${KEY_0},0xdeadbeef` }))
    expect(error.message).toContain('SIGNER_PRIVATE_KEYS entry 2')
    expect(error.message).not.toContain('deadbeef')
  })

  test.each(['abc', '0', '70000', '80.5'])('on PORT=%s', (port) => {
    expect(expectConfigError(() => parseEnv({ ...BASE, PORT: port })).message).toContain('PORT')
  })

  test('on an unknown LOG_LEVEL', () => {
    expect(expectConfigError(() => parseEnv({ ...BASE, LOG_LEVEL: 'verbose' })).message).toContain('LOG_LEVEL')
  })
})
