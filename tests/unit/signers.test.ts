import { inspect } from 'node:util'
import type { Hex } from 'viem'
import { expect, test } from 'vitest'
import { buildSigners } from '../../src/signers'
import { expectConfigError } from '../helpers/errors'
import { ADDRESS_0, ADDRESS_1, KEY_0, KEY_1 } from '../helpers/keys'

test('maps each checksummed sender address to the account that signs for it', () => {
  const signers = buildSigners([KEY_0, KEY_1])
  expect([...signers.keys()]).toEqual([ADDRESS_0, ADDRESS_1])
  expect(signers.get(ADDRESS_1)?.address).toBe(ADDRESS_1)
})

test('rejects the same key given twice, even in a different letter case', () => {
  const error = expectConfigError(() => buildSigners([KEY_0, `0x${KEY_0.slice(2).toUpperCase()}`]))
  expect(error.message).toContain('entry 2')
  expect(error.message).toContain(ADDRESS_0)
})

test.each([
  ['zero', `0x${'0'.repeat(64)}`],
  ['at or above the curve order', `0x${'f'.repeat(64)}`],
])('rejects a key that is %s, without echoing it', (_case, key) => {
  const error = expectConfigError(() => buildSigners([KEY_0, key as Hex]))
  expect(error.message).toContain('entry 2')
  expect(error.message).not.toContain(key.slice(2, 20))
})

test('does not expose private keys through the accounts', () => {
  const signers = buildSigners([KEY_0])
  expect(inspect(signers, { depth: 10, showHidden: true })).not.toContain(KEY_0.slice(2))
})
