import type { Signers } from '../config/signers'
import type { Logger } from '../logger'
import type { Store } from '../store/store'
import { type ChainId, nonce } from '../types'
import { NoncePool } from './nonce-pool'
import type { RuntimeChain } from './rpc'
import type { SenderRegistry } from './senders'
import type { Worker } from './worker'

export type RecoveryDeps = {
  store: Store
  chains: Map<ChainId, RuntimeChain>
  signers: Signers
  senders: SenderRegistry
  worker: Worker
  logger: Logger
}

/**
 * Picks up where the last run stopped (ADRs 0003, 0009 and 0012). Runs once at startup, before the
 * monitors start and before the API accepts requests.
 */
export async function recover({ store, chains, signers, senders, worker, logger }: RecoveryDeps): Promise<void> {
  // 1. Each sender's pool, from the chain and the nonces our unfinished requests hold.
  for (const [id, chain] of chains) {
    for (const sender of signers.keys()) {
      const [confirmed, pending] = await Promise.all([
        chain.rpc.read.getTransactionCount({ address: sender, blockTag: 'latest' }),
        chain.rpc.read.getTransactionCount({ address: sender, blockTag: 'pending' }),
      ])
      const held = store.heldNonces(id, sender)
      senders.add(id, sender, NoncePool.rebuild({ confirmed: nonce(confirmed), pending: nonce(pending), held }))
    }
  }

  let requeued = 0
  for (const tx of store.listByStatus(['queued'])) {
    if (!chains.has(tx.chainId)) {
      logger.warn({ txId: tx.id, chainId: tx.chainId }, 'queued request is for a chain that is no longer enabled')
      continue
    }
    const live = store.attempts(tx.id).filter((attempt) => attempt.outcome !== 'rejected')
    if (live.length > 0) {
      // 2. Saved before the restart, so it may have been sent: the monitor resends it if it isn't mined.
      store.markSubmitted(tx.id, live[live.length - 1].hash)
    }
  }

  // 3. Requests already broadcast keep their slots until they're final.
  let inFlight = 0
  for (const tx of store.listByStatus(['submitted'])) {
    if (!chains.has(tx.chainId)) continue
    senders.get(tx.chainId, tx.sender).active.add(tx.id)
    inFlight++
  }

  // 4. Everything else still queued goes back to the worker, oldest first.
  for (const tx of store.listByStatus(['queued'])) {
    if (!chains.has(tx.chainId)) continue
    worker.enqueue(tx.id)
    requeued++
  }

  logger.info({ inFlight, requeued }, 'recovered')
}
