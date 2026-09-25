import { setTimeout as sleep } from 'node:timers/promises'
import { type Address, getAddress, type Hash, type PublicClient, TransactionReceiptNotFoundError } from 'viem'
import type { Signers } from '../config/signers'
import type { Logger } from '../logger'
import type { Store } from '../store/store'
import {
  type ChainId,
  type Fees,
  type Nonce,
  nonce as toNonce,
  type Receipt,
  type SubmittedTx,
  type Transaction,
  type TxId,
} from '../types'
import { type BroadcastOptions, sendAttempt } from './attempts'
import { broadcast } from './broadcast'
import { bumpFees, priceFees, readMarketFees } from './gas'
import type { RuntimeChain } from './rpc'
import type { SenderRegistry } from './senders'
import type { Worker } from './worker'

export type MonitorOptions = {
  broadcastSends: number
  broadcastDelayMs: number
  /** Polls in a row that must see the nonce used by another tx before NONCE_TAKEN (ADR 0009). */
  nonceTakenPolls: number
}

export type MonitorDeps = {
  store: Store
  chain: RuntimeChain
  signers: Signers
  senders: SenderRegistry
  worker: Worker
  logger: Logger
}

const DEFAULTS: MonitorOptions = { broadcastSends: 3, broadcastDelayMs: 250, nonceTakenPolls: 2 }

/** One per chain. Every pollIntervalMs it checks each submitted request (ADR 0008, layer 4). */
export class Monitor {
  readonly #deps: MonitorDeps
  readonly #options: MonitorOptions
  readonly #broadcast: BroadcastOptions
  readonly #chainId: ChainId
  readonly #log: Logger
  /** When each request last had an attempt sent or resent. "Stuck" is measured from here. */
  readonly #lastSentAt = new Map<TxId, number>()
  /** How many polls in a row have seen each request's nonce used by another transaction. */
  readonly #nonceTakenPolls = new Map<TxId, number>()
  readonly #stop = new AbortController()
  #loop: Promise<void> | undefined

  constructor(deps: MonitorDeps, options: Partial<MonitorOptions> = {}) {
    this.#deps = deps
    this.#options = { ...DEFAULTS, ...options }
    this.#broadcast = { maxSends: this.#options.broadcastSends, delayMs: this.#options.broadcastDelayMs }
    this.#chainId = deps.chain.rpc.chainId
    this.#log = deps.logger.child({ chainId: this.#chainId })
  }

  start(): void {
    this.#loop ??= this.#run()
  }

  async stop(): Promise<void> {
    this.#stop.abort()
    await this.#loop
  }

  async tick(): Promise<void> {
    const { store, chain } = this.#deps

    // One nonce read per sender per tick, shared by all of its requests.
    const confirmed = new Map<Address, Promise<Nonce>>()
    const confirmedNonce = (sender: Address) => {
      if (!confirmed.has(sender)) {
        confirmed.set(sender, chain.rpc.read.getTransactionCount({ address: sender, blockTag: 'latest' }).then(toNonce))
      }
      return confirmed.get(sender)!
    }

    for (const tx of store.listByStatus(['submitted'], this.#chainId)) {
      try {
        await this.#check(tx, confirmedNonce)
      } catch (error) {
        this.#log.warn({ err: error, txId: tx.id }, 'could not check request')
      }
    }
  }

  async #run(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      await this.tick()
      await sleep(this.#deps.chain.config.pollIntervalMs, undefined, { signal: this.#stop.signal }).catch(() => {})
    }
  }

  async #check(tx: SubmittedTx, confirmedNonce: (sender: Address) => Promise<Nonce>): Promise<void> {
    const { store, chain } = this.#deps
    const attempts = store.attempts(tx.id)
    const live = attempts.filter((attempt) => attempt.outcome !== 'rejected')

    // 1. Mined. Any attempt can be the one: the original can be mined after a replacement was sent.
    for (const attempt of live) {
      const receipt = await findReceipt(chain.rpc.read, attempt.hash)
      if (receipt) {
        if (store.markMined(tx.id, receipt))
          this.#finished(tx, { status: receipt.status, hash: receipt.transactionHash })
        return
      }
    }

    // 2. The nonce was used by another transaction, so ours can never be mined. Needs two polls
    // in a row: a load-balanced RPC can report the new nonce before it can return the receipt.
    const confirmed = await confirmedNonce(tx.sender)
    if (tx.nonce < confirmed) {
      const polls = (this.#nonceTakenPolls.get(tx.id) ?? 0) + 1
      this.#nonceTakenPolls.set(tx.id, polls)
      if (polls < this.#options.nonceTakenPolls) return
      this.#deps.senders.get(tx.chainId, tx.sender).pool.reset(confirmed)
      if (store.markFailed(tx.id, { code: 'NONCE_TAKEN', nonce: tx.nonce })) {
        this.#finished(tx, { status: 'failed', code: 'NONCE_TAKEN' })
      }
      return
    }
    this.#nonceTakenPolls.delete(tx.id)

    // 3. Stuck: replace it with higher fees, or once that's not possible, resend it unchanged.
    // A broadcast transaction is never failed because time ran out (ADR 0008).
    const latest = attempts[attempts.length - 1]
    const lastSent = this.#lastSentAt.get(tx.id) ?? Date.parse(latest.createdAt)
    if (Date.now() - lastSent < chain.config.stuckAfterMs) return
    this.#lastSentAt.set(tx.id, Date.now())

    const bumpsLeft = attempts.length - 1 < chain.config.gas.maxBumps
    if (bumpsLeft && (await this.#replace(tx, latest.fees))) return
    const resend = live[live.length - 1]
    await broadcast(resend.raw, chain.rpc.senders, this.#broadcast)
    this.#log.info({ txId: tx.id, hash: resend.hash }, 'stuck: resent unchanged')
  }

  /** Sends a replacement at the same nonce with higher fees. Returns false when the fee cap prevents it. */
  async #replace(tx: SubmittedTx, previous: Fees): Promise<boolean> {
    const { store, chain, signers } = this.#deps
    const { gas } = chain.config
    const market = priceFees(await readMarketFees(chain.rpc.read, gas.type), gas)
    const bumped = bumpFees(previous, market.ok ? market.value : null, gas)
    if (!bumped.ok) return false

    const account = signers.get(tx.sender)
    if (!account) throw new Error(`no signer for ${tx.sender}`)
    const draft = { nonce: tx.nonce, gasLimit: tx.gasLimit, fees: bumped.value }
    const { attempt, result } = await sendAttempt(store, chain, account, tx, draft, this.#broadcast)
    if (result.outcome === 'rejected') {
      // The earlier attempt is still valid. The next bump starts from this higher fee (ADR 0008).
      store.setAttemptOutcome(attempt.id, 'rejected')
      this.#log.info({ txId: tx.id, hash: attempt.hash, nodeMessage: result.message }, 'stuck: replacement rejected')
      return true
    }
    store.setAttemptOutcome(attempt.id, result.outcome)
    store.markSubmitted(tx.id, attempt.hash)
    this.#log.info({ txId: tx.id, hash: attempt.hash, outcome: result.outcome }, 'stuck: replaced with higher fees')
    return true
  }

  #finished(tx: Transaction, fields: Record<string, unknown>): void {
    this.#lastSentAt.delete(tx.id)
    this.#nonceTakenPolls.delete(tx.id)
    this.#log.info({ txId: tx.id, ...fields }, 'final')
    this.#deps.worker.release(tx)
  }
}

async function findReceipt(read: PublicClient, hash: Hash): Promise<Receipt | null> {
  try {
    const receipt = await read.getTransactionReceipt({ hash })
    return {
      transactionHash: receipt.transactionHash,
      transactionIndex: receipt.transactionIndex,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      from: getAddress(receipt.from),
      to: receipt.to ? getAddress(receipt.to) : null,
      contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null,
      gasUsed: receipt.gasUsed,
      cumulativeGasUsed: receipt.cumulativeGasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      status: receipt.status,
      type: receipt.type,
      logsBloom: receipt.logsBloom,
      logs: receipt.logs.map((log) => ({
        address: getAddress(log.address),
        topics: [...log.topics],
        data: log.data,
        logIndex: log.logIndex,
      })),
    }
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null
    throw error
  }
}
