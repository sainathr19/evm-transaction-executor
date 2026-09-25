import type { Address, LocalAccount } from 'viem'
import { broadcast, classifyNodeMessage, describeSendError, isTransportError } from './broadcast'
import { estimateGasLimit, priceFees, readMarketFees } from './gas'
import type { Logger } from './logger'
import type { RuntimeChain } from './rpc'
import type { SenderRegistry, SenderState } from './senders'
import { signAttempt } from './sign'
import type { Signers } from './signers'
import type { Attempt, Store, TxRecord } from './store/store'
import type { FailureCode, Fees } from './types'

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
  readonly #options: WorkerOptions
  readonly #running = new Set<Promise<void>>()

  constructor(deps: WorkerDeps, options: Partial<WorkerOptions> = {}) {
    this.#deps = deps
    this.#options = { ...DEFAULTS, ...options }
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
      const job: Promise<void> = this.#process(txId, state)
        .then((result) => {
          if (result === 'final') this.release(this.#deps.store.get(txId)!)
        })
        .finally(() => this.#running.delete(job))
      this.#running.add(job)
    }
  }

  async #process(txId: string, state: SenderState): Promise<JobResult> {
    const { store } = this.#deps
    const tx = store.get(txId)!
    const log = this.#deps.logger.child({ txId, chainId: tx.chainId, sender: tx.sender })
    try {
      const chain = this.#chain(tx.chainId)
      const account = this.#deps.signers.get(tx.sender)
      if (!account) throw new Error(`no signer for ${tx.sender}`)

      const prepared = await prepare(tx, chain)
      if ('code' in prepared) return this.#fail(tx, prepared, log)
      return await this.#submit(tx, prepared, chain, account, state, log)
    } catch (error) {
      // A bug or an unexpected error. If a node may have one of the attempts, the monitor takes
      // over, just as after a restart (ADR 0003).
      log.error({ err: error }, 'unexpected error')
      const live = store.attempts(tx.id).filter((attempt) => attempt.outcome !== 'rejected')
      if (live.length > 0) {
        store.markSubmitted(tx.id, live[live.length - 1].hash)
        return 'submitted'
      }
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
  ): Promise<JobResult> {
    const { store } = this.#deps
    const nonce = state.pool.take()
    let attempt: Attempt
    try {
      const signed = await signAttempt(account, { ...tx, nonce, ...prepared })
      attempt = store.recordAttempt(tx.id, { nonce, ...prepared, ...signed })
    } catch (error) {
      state.pool.rollback(nonce) // nothing was sent
      throw error
    }

    const result = await broadcast(attempt.raw, chain.rpc.senders, {
      maxSends: this.#options.broadcastSends,
      delayMs: this.#options.broadcastDelayMs,
    })

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
