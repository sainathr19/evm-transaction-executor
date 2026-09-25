import type { Address, Hex, LocalAccount } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ConfigError } from './config/error'

/**
 * Sender address (checksummed) → the account that signs for it. The rest of the code only
 * sees this map, so a KMS-backed account from viem's toAccount can replace it (ADR 0006).
 */
export type Signers = Map<Address, LocalAccount>

export function buildSigners(privateKeys: Hex[]): Signers {
  const signers: Signers = new Map()
  privateKeys.forEach((key, i) => {
    let account: LocalAccount
    try {
      account = privateKeyToAccount(key.toLowerCase() as Hex)
    } catch {
      // The underlying error may quote the key, so it isn't passed on.
      throw new ConfigError(`SIGNER_PRIVATE_KEYS entry ${i + 1} is not a valid secp256k1 private key`)
    }
    if (signers.has(account.address)) {
      throw new ConfigError(`SIGNER_PRIVATE_KEYS entry ${i + 1} repeats the key for ${account.address}`)
    }
    signers.set(account.address, account)
  })
  return signers
}
