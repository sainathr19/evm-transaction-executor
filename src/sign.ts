import { keccak256, type Address, type Hash, type Hex, type LocalAccount } from 'viem'
import type { Fees } from './types'

export type UnsignedAttempt = {
  chainId: number
  to: Address
  value: bigint
  data: Hex
  nonce: number
  gasLimit: bigint
  fees: Fees
}

/** Signs one attempt. Its hash is known before anything is sent, so it can be saved first (ADR 0003). */
export async function signAttempt(account: LocalAccount, tx: UnsignedAttempt): Promise<{ raw: Hex; hash: Hash }> {
  const common = { chainId: tx.chainId, to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce, gas: tx.gasLimit }
  const raw =
    tx.fees.type === 'legacy'
      ? await account.signTransaction({ ...common, type: 'legacy', gasPrice: tx.fees.gasPrice })
      : await account.signTransaction({
          ...common,
          type: 'eip1559',
          maxFeePerGas: tx.fees.maxFeePerGas,
          maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
        })
  return { raw, hash: keccak256(raw) }
}
