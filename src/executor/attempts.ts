import { keccak256, type Hash, type Hex, type LocalAccount } from 'viem'
import type { Attempt, Store, TxRecord } from '../store/store'
import type { Fees } from '../types'
import { broadcast, type BroadcastResult } from './broadcast'
import type { RuntimeChain } from './rpc'

export type BroadcastOptions = { maxSends: number; delayMs: number }

export type AttemptDraft = { nonce: number; gasLimit: bigint; fees: Fees }

/**
 * Signs an attempt, saves it, then broadcasts it. Saving comes first, so a crash can never lose
 * track of a transaction a node may have (ADR 0003). Only signing or saving can throw.
 */
export async function sendAttempt(
  store: Store,
  chain: RuntimeChain,
  account: LocalAccount,
  tx: TxRecord,
  draft: AttemptDraft,
  options: BroadcastOptions,
): Promise<{ attempt: Attempt; result: BroadcastResult }> {
  const signed = await sign(account, tx, draft)
  const attempt = store.recordAttempt(tx.id, { ...draft, ...signed })
  const result = await broadcast(attempt.raw, chain.rpc.senders, options)
  return { attempt, result }
}

async function sign(account: LocalAccount, tx: TxRecord, draft: AttemptDraft): Promise<{ raw: Hex; hash: Hash }> {
  const common = {
    chainId: tx.chainId,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    nonce: draft.nonce,
    gas: draft.gasLimit,
  }
  const { fees } = draft
  const raw =
    fees.type === 'legacy'
      ? await account.signTransaction({ ...common, type: 'legacy', gasPrice: fees.gasPrice })
      : await account.signTransaction({
          ...common,
          type: 'eip1559',
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        })
  return { raw, hash: keccak256(raw) }
}
