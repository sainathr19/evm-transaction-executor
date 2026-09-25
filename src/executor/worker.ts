import type { Address, LocalAccount } from 'viem'
import type { Signers } from '../config/signers'
import type { Logger } from '../logger'
import type { Store } from '../store/store'
import {
  type ChainId,
  describeFailure,
  err,
  type Fees,
  nonce as toNonce,
  ok,
  type QueuedTx,
  type Result,
  type Transaction,
  type TxFailure,
  type TxId,
} from '../types'
import { type BroadcastOptions, sendAttempt } from './attempts'
import { classifyNodeMessage, describeSendError, isTransportError } from './broadcast'
import { estimateGasLimit, priceFees, readMarketFees } from './gas'
import type { RuntimeChain } from './rpc'
import type { SenderRegistry, SenderState } from './senders'

export type WorkerOptions = {
  broadcastSends: number
  broadcastDelayMs: number
}

export type WorkerDeps = {
  store: Store
  chains: Map<ChainId, RuntimeChain>
  signers: Signers
  senders: SenderRegistry
  logger: Logger
}

const DEFAULTS: WorkerOptions = { broadcastSends: 3, broadcastDelayMs: 250 }

type Prepared = { gasLimit: bigint; fees: Fees }

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
  enqueue(id: TxId): void {
    const tx = this.#deps.store.get(id)
    if (!tx) throw new Error(`unknown request ${id}`)
    this.#deps.senders.get(tx.chainId, tx.sender).queue.push(id)
    this.#pump(tx.chainId, tx.sender)
  }

  /** Frees the slot of a submitted request that has become final. Called by the monitor. */
  release(tx: Transaction): void {
    this.#deps.senders.get(tx.chainId, tx.sender).active.delete(tx.id)
    this.#pump(tx.chainId, tx.sender)
  }

  /** Resolves once no request is being processed. Requests waiting for a slot don't count. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running])
  }

  #pump(chain: ChainId, sender: Address): void {
    const state = this.#deps.senders.get(chain, sender)
    const slots = this.#chain(chain).config.maxInFlightPerSender
    while (state.active.size < slots && state.queue.length > 0) {
      const id = state.queue.shift()!
      state.active.add(id)
      this.#track(
        this.#process(id, state).then((result) => {
          if (result !== 'final') return
          state.active.delete(id)
          this.#pump(chain, sender)
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

  async #process(id: TxId, state: SenderState): Promise<JobResult> {
    const { store } = this.#deps
    const tx = store.get(id)
    if (tx?.status !== 'queued') {
      this.#deps.logger.warn({ txId: id, status: tx?.status }, 'not queued, skipped')
      return tx?.status === 'submitted' ? 'submitted' : 'final'
    }

    const log = this.#deps.logger.child({ txId: id, chainId: tx.chainId, sender: tx.sender })
    try {
      const chain = this.#chain(tx.chainId)
      const account = this.#deps.signers.get(tx.sender)
      if (!account) throw new Error(`no signer for ${tx.sender}`)

      const prepared = await prepare(tx, chain)
      if (!prepared.ok) return this.#fail(tx, prepared.error, log)
      return await this.#submit(tx, prepared.value, chain, account, state, log)
    } catch (error) {
      // A bug or an unexpected error. If a node may have one of the attempts, the monitor takes
      // over, just as after a restart (ADR 0003).
      log.error({ err: error }, 'unexpected error')
      const live = store.attempts(id).filter((attempt) => attempt.outcome !== 'rejected')
      if (live.length > 0) {
        store.markSubmitted(id, live[live.length - 1].hash)
        return 'submitted'
      }
      const message = error instanceof Error ? error.message : String(error)
      return this.#fail(tx, { code: 'INTERNAL_ERROR', message }, log)
    }
  }

  /** Takes a nonce as late as possible, then signs, saves and broadcasts (ADR 0009). */
  async #submit(
    tx: QueuedTx,
    prepared: Prepared,
    chain: RuntimeChain,
    account: LocalAccount,
    state: SenderState,
    log: Logger,
  ): Promise<JobResult> {
    const { store } = this.#deps
    const nonce = state.pool.take()
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
    const failure: TxFailure =
      result.reason === 'insufficient_funds'
        ? { code: 'INSUFFICIENT_FUNDS', nodeMessage: result.message }
        : { code: 'BROADCAST_REJECTED', nodeMessage: result.message }
    return this.#fail(tx, failure, log)
  }

  /** Drops available nonces the chain has already used, so an out-of-sync pool heals itself. */
  async #resync(state: SenderState, chain: RuntimeChain, sender: Address, log: Logger): Promise<void> {
    try {
      const confirmed = await chain.rpc.read.getTransactionCount({ address: sender, blockTag: 'latest' })
      state.pool.reset(toNonce(confirmed))
    } catch (error) {
      log.warn({ err: error }, 'could not read the nonce to resync the pool')
    }
  }

  #fail(tx: Transaction, failure: TxFailure, log: Logger): JobResult {
    this.#deps.store.markFailed(tx.id, failure)
    log.warn({ code: failure.code, reason: describeFailure(failure) }, 'failed')
    return 'final'
  }

  #chain(chain: ChainId): RuntimeChain {
    const runtime = this.#deps.chains.get(chain)
    if (!runtime) throw new Error(`chain ${chain} is not enabled`)
    return runtime
  }
}

/** Gas limit and fees. viem already retries each read (ADR 0008), so a failure here ends the request. */
async function prepare(tx: QueuedTx, chain: RuntimeChain): Promise<Result<Prepared, TxFailure>> {
  const { gas } = chain.config
  try {
    const gasLimit = await estimateGasLimit(chain.rpc.read, tx, gas.gasLimitBufferPercent)
    const priced = priceFees(await readMarketFees(chain.rpc.read), gas)
    if (!priced.ok) return err({ code: 'FEE_ABOVE_CAP', capWei: priced.error.capWei })
    return ok({ gasLimit, fees: priced.value })
  } catch (error) {
    const answer = describeSendError(error)
    if (answer.answered) {
      return err(
        classifyNodeMessage(answer.message) === 'insufficient_funds'
          ? { code: 'INSUFFICIENT_FUNDS', nodeMessage: answer.message }
          : { code: 'ESTIMATION_REVERTED', nodeMessage: answer.message },
      )
    }
    if (isTransportError(error)) return err({ code: 'RPC_UNAVAILABLE' })
    throw error
  }
}
