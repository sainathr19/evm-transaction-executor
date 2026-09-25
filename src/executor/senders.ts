import type { Address } from 'viem'
import type { ChainId, TxId } from '../types'
import type { NoncePool } from './nonce-pool'

/** Everything the service tracks for one (chain, sender). */
export class SenderState {
  /** Requests waiting for a slot (ADR 0012), oldest first. */
  readonly queue: TxId[] = []
  /** Requests holding a slot: from the moment the worker starts on them until they are final. */
  readonly active = new Set<TxId>()

  constructor(readonly pool: NoncePool) {}
}

export class SenderRegistry {
  readonly #states = new Map<string, SenderState>()

  add(chainId: ChainId, sender: Address, pool: NoncePool): SenderState {
    const state = new SenderState(pool)
    this.#states.set(key(chainId, sender), state)
    return state
  }

  get(chainId: ChainId, sender: Address): SenderState {
    const state = this.#states.get(key(chainId, sender))
    if (!state) throw new Error(`no nonce pool for ${sender} on chain ${chainId}`)
    return state
  }
}

function key(chainId: ChainId, sender: Address): string {
  return `${chainId}:${sender}`
}
