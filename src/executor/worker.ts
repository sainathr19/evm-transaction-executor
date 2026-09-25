import type { Address, LocalAccount } from 'viem'
import { sendAttempt, type BroadcastOptions } from './attempts'
import { classifyNodeMessage, describeSendError, isTransportError } from './broadcast'
import { estimateGasLimit, priceFees, readMarketFees } from './gas'
import type { Logger } from '../logger'
import type { RuntimeChain } from './rpc'
import type { SenderRegistry, SenderState } from './senders'
import type { Signers } from '../signers'
import type { Store, TxRecord } from '../store/store'
import type { FailureCode, Fees } from '../types'

export type WorkerOptions = {
  broadcastSends: number
  broadcastDelayMs: number
}

export type WorkerDeps = {
  store: Store
  chains: Map<number, RuntimeChain>
  signers: Signers
  senders: SenderRegistry
  logger: Logger
}

const DEFAULTS: WorkerOptions = { broadcastSends: 3, broadcastDelayMs: 250 }

type Prepared = { gasLimit: bigint; fees: Fees }
type Failure = { code: FailureCode; message: string }

/** How a job ended: final (failed), or submitted and now watched by the monitor. */
type JobResult = 'final' | 'submitted'

/**
 * Takes each request through: estimate gas → price fees → take nonce → sign → save → broadcast.
 * Works on at most maxInFlightPerSender requests per sender at a time (ADR 0012).
 */
export class Worker {
  readonly #deps: WorkerDeps
  readonly #broadcast: BroadcastOptions
  readonly #running = new Set<Promise<void>>()

  constructor(deps: WorkerDeps, options: Partial<WorkerOptions> = {}) {
    this.#deps = deps
    const { broadcastSends, broadcastDelayMs } = { ...DEFAULTS, ...options }
    this.#broadcast = { maxSends: broadcastSends, delayMs: broadcastDelayMs }
  }

  /** Queues a stored request. It starts as soon as its sender has a free slot. */
  enqueue(txId: string): void {
    const tx = this.#deps.store.get(txId)
    if (!tx) throw new Error(`unknown request ${txId}`)
    this.#deps.senders.get(tx.chainId, tx.sender).queue.push(txId)
    this.#pump(tx.chainId, tx.sender)
  }

  /** Frees the slot of a submitted request that has become final. Called by the monitor. */
  release(tx: TxRecord): void {
    this.#deps.senders.get(tx.chainId, tx.sender).active.delete(tx.id)
    this.#pump(tx.chainId, tx.sender)
  }

  /**
   * Sends 0 ETH from the sender to itself at its lowest nonce gap, once the gap has been open for
   * `minAgeMs` (ADR 0009). Same path as a request, except the nonce comes from takeGap and no slot
   * is used: the requests stuck behind the gap may be holding every slot.
   */
  fillGap(chainId: number, sender: Address, minAgeMs: number): void {
    const state = this.#deps.senders.get(chainId, sender)
    const nonce = state.pool.takeGap(minAgeMs)
    if (nonce === undefined) return
    const tx = this.#deps.store.insertGapFill(chainId, sender)
    this.#track(this.#process(tx.id, state, nonce))
  }

  /** Resolves once no request is being processed. Requests waiting for a slot don't count. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running])
  }

  #pump(chainId: number, sender: Address): void {
    const state = this.#deps.senders.get(chainId, sender)
    const slots = this.#chain(chainId).config.maxInFlightPerSender
    while (state.active.size < slots && state.queue.length > 0) {
      const txId = state.queue.shift()!
      state.active.add(txId)
      this.#track(
        this.#process(txId, state).then((result) => {
          if (result === 'final') this.release(this.#deps.store.get(txId)!)
        }),
      )
    }
  }

  #track(job: Promise<unknown>): void {
    const tracked: Promise<void> = job.then(
      () => undefined,
      () => undefined,
    )
    this.#running.add(tracked)
    void tracked.finally(() => this.#running.delete(tracked))
  }

  /** `gapNonce` is set for a gap fill, which takes its nonce up front. */
  async #process(txId: string, state: SenderState, gapNonce?: number): Promise<JobResult> {
    const { store } = this.#deps
    const tx = store.get(txId)!
    const log = this.#deps.logger.child({ txId, chainId: tx.chainId, sender: tx.sender, kind: tx.kind })
    try {
      const chain = this.#chain(tx.chainId)
      const account = this.#deps.signers.get(tx.sender)
      if (!account) throw new Error(`no signer for ${tx.sender}`)

      const prepared = await prepare(tx, chain)
      if ('code' in prepared) {
        if (gapNonce !== undefined) state.pool.rollback(gapNonce)
        return this.#fail(tx, prepared, log)
      }
      return await this.#submit(tx, prepared, chain, account, state, log, gapNonce)
    } catch (error) {
      // A bug or an unexpected error. If a node may have one of the attempts, the monitor takes
      // over, just as after a restart (ADR 0003).
      log.error({ err: error }, 'unexpected error')
      const live = store.attempts(tx.id).filter((attempt) => attempt.outcome !== 'rejected')
      if (live.length > 0) {
        store.markSubmitted(tx.id, live[live.length - 1].hash)
        return 'submitted'
      }
      if (gapNonce !== undefined) state.pool.rollback(gapNonce)
      const message = error instanceof Error ? error.message : String(error)
      return this.#fail(tx, { code: 'INTERNAL_ERROR', message }, log)
    }
  }

  /** Takes a nonce as late as possible, then signs, saves and broadcasts (ADR 0009). */
  async #submit(
    tx: TxRecord,
    prepared: Prepared,
    chain: RuntimeChain,
    account: LocalAccount,
    state: SenderState,
    log: Logger,
    gapNonce?: number,
  ): Promise<JobResult> {
    const { store } = this.#deps
    const nonce = gapNonce ?? state.pool.take()
    let sent: Awaited<ReturnType<typeof sendAttempt>>
    try {
      sent = await sendAttempt(store, chain, account, tx, { nonce, ...prepared }, this.#broadcast)
    } catch (error) {
      state.pool.rollback(nonce) // signing or saving failed: nothing was sent
      throw error
    }
    const { attempt, result } = sent

    if (result.outcome !== 'rejected') {
      store.setAttemptOutcome(attempt.id, result.outcome)
      store.markSubmitted(tx.id, attempt.hash)
      log.info({ nonce, hash: attempt.hash, outcome: result.outcome }, 'submitted')
      return 'submitted'
    }

    // Every send was answered with a rejection, so no node has the transaction: give the nonce
    // back, then drop any nonce the chain has already used (ADR 0009).
    store.setAttemptOutcome(attempt.id, 'rejected')
    state.pool.rollback(nonce)
    await this.#resync(state, chain, tx.sender, log)
    const code = result.reason === 'insufficient_funds' ? 'INSUFFICIENT_FUNDS' : 'BROADCAST_REJECTED'
    return this.#fail(tx, { code, message: result.message }, log)
  }

  /** Drops available nonces the chain has already used, so an out-of-sync pool heals itself. */
  async #resync(state: SenderState, chain: RuntimeChain, sender: Address, log: Logger): Promise<void> {
    try {
      state.pool.reset(await chain.rpc.read.getTransactionCount({ address: sender, blockTag: 'latest' }))
    } catch (error) {
      log.warn({ err: error }, 'could not read the nonce to resync the pool')
    }
  }

  #fail(tx: TxRecord, failure: Failure, log: Logger): JobResult {
    this.#deps.store.markFailed(tx.id, failure.code, failure.message)
    log.warn(failure, 'failed')
    return 'final'
  }

  #chain(chainId: number): RuntimeChain {
    const chain = this.#deps.chains.get(chainId)
    if (!chain) throw new Error(`chain ${chainId} is not enabled`)
    return chain
  }
}

/** Gas limit and fees. viem already retries each read (ADR 0008), so a failure here ends the request. */
async function prepare(tx: TxRecord, chain: RuntimeChain): Promise<Prepared | Failure> {
  const { gas } = chain.config
  try {
    const gasLimit = await estimateGasLimit(chain.rpc.read, tx, gas.gasLimitBufferPercent)
    const fees = priceFees(await readMarketFees(chain.rpc.read, gas.type), gas)
    if (fees === 'above_cap') {
      return { code: 'FEE_ABOVE_CAP', message: `base fee plus tip is above the cap of ${gas.maxFeePerGasWei} wei` }
    }
    return { gasLimit, fees }
  } catch (error) {
    const answer = describeSendError(error)
    if (answer.answered) {
      const funds = classifyNodeMessage(answer.message) === 'insufficient_funds'
      return { code: funds ? 'INSUFFICIENT_FUNDS' : 'ESTIMATION_REVERTED', message: answer.message }
    }
    if (isTransportError(error)) return { code: 'RPC_UNAVAILABLE', message: 'the RPC could not be reached' }
    throw error
  }
}
