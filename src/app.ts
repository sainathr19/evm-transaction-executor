import { createHash } from 'node:crypto'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { type Address, getAddress, type Hash, type Hex, isAddress } from 'viem'
import { z } from 'zod'
import type { Signers } from './config/signers'
import type { Logger } from './logger'
import type { Attempt, AttemptOutcome, Store } from './store/store'
import {
  chainId,
  type ChainId,
  describeFailure,
  type Fees,
  type FailureCode,
  type Nonce,
  type QueuedTx,
  type Receipt,
  type Transaction,
  type TxFailure,
  txId,
  type TxId,
  type TxStatus,
} from './types'

export type AppDeps = {
  store: Store
  chainIds: ReadonlySet<ChainId>
  signers: Signers
  /** Hands a newly stored request to the worker. */
  onAccepted: (tx: QueuedTx) => void
  logger: Logger
}

// Every JSON response has the same envelope. The HTTP status is set separately, with res.status().

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'IDEMPOTENCY_KEY_MISSING'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'UNSUPPORTED_CHAIN'
  | 'UNKNOWN_SENDER'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'

export type ApiError = { code: ApiErrorCode; message: string; details: Record<string, unknown> | null }

export type ApiResponse<T> =
  { status: 'ok'; result: T; error: null } | { status: 'error'; result: null; error: ApiError }

export const ApiResponse = {
  ok: <T>(result: T): ApiResponse<T> => ({ status: 'ok', result, error: null }),
  error: (code: ApiErrorCode, message: string, details: Record<string, unknown> | null = null): ApiResponse<never> => ({
    status: 'error',
    result: null,
    error: { code, message, details },
  }),
}

/**
 * A transaction as the API shows it. Amounts are decimal strings, since JSON numbers lose precision
 * above 2^53. Signed transactions are left out: one whose nonce is still free could be broadcast by
 * anyone who has it (ADR 0003).
 */
export type ApiTransaction = {
  id: TxId
  status: TxStatus
  chainId: ChainId
  sender: Address
  to: Address
  value: string
  data: Hex
  nonce: Nonce | null
  gasLimit: string | null
  hash: Hash | null
  attempts: { hash: Hash; outcome: AttemptOutcome; fees: ApiFees; createdAt: string }[]
  receipt: ApiReceipt | null
  failure: ApiFailure | null
  createdAt: string
  updatedAt: string
}

type ApiFees =
  { type: 'eip1559'; maxFeePerGas: string; maxPriorityFeePerGas: string } | { type: 'legacy'; gasPrice: string }

/** The full receipt, with its amounts as decimal strings. */
type ReceiptAmount = 'blockNumber' | 'gasUsed' | 'cumulativeGasUsed' | 'effectiveGasPrice'
type ApiReceipt = Omit<Receipt, ReceiptAmount> & Record<ReceiptAmount, string>

/** The failure's own details, plus a one-line explanation. */
type ApiFailure = { code: FailureCode; message: string; [detail: string]: unknown }

const BODY_LIMIT = '256kb'
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,255}$/ // printable ASCII (ADR 0010)
const DECIMAL = /^(0|[1-9]\d*)$/
const UINT256_LIMIT = 2n ** 256n

const address = z.string().refine((value) => isAddress(value, { strict: false }), 'must be a 20-byte hex address')

const TransactionRequest = z.strictObject({
  chainId: z.number().int().positive(),
  sender: address,
  to: address,
  value: z
    .string()
    .regex(DECIMAL, 'must be an amount of wei as a decimal string')
    .refine((value) => !DECIMAL.test(value) || BigInt(value) < UINT256_LIMIT, 'must fit in 256 bits'),
  data: z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})*$/, 'must be 0x-prefixed hex bytes')
    .default('0x'),
})

export function buildApp(deps: AppDeps): Express {
  const { store } = deps
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: BODY_LIMIT }))

  app.post('/transactions', (req, res) => {
    const key = req.get('Idempotency-Key')
    if (!key) {
      res.status(400).json(ApiResponse.error('IDEMPOTENCY_KEY_MISSING', 'the Idempotency-Key header is required'))
      return
    }
    if (!IDEMPOTENCY_KEY.test(key)) {
      const message = 'Idempotency-Key must be 1 to 255 printable ASCII characters'
      res.status(400).json(ApiResponse.error('VALIDATION_ERROR', message))
      return
    }

    const parsed = TransactionRequest.safeParse(req.body)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      res.status(400).json(ApiResponse.error('VALIDATION_ERROR', 'the request body is invalid', { issues }))
      return
    }

    const chain = chainId(parsed.data.chainId)
    if (!deps.chainIds.has(chain)) {
      const details = { supported: [...deps.chainIds] }
      res.status(400).json(ApiResponse.error('UNSUPPORTED_CHAIN', `chain ${chain} is not configured`, details))
      return
    }
    const sender = getAddress(parsed.data.sender)
    if (!deps.signers.has(sender)) {
      res.status(400).json(ApiResponse.error('UNKNOWN_SENDER', `no key is configured for ${sender}`))
      return
    }

    const request = {
      chainId: chain,
      sender,
      to: getAddress(parsed.data.to),
      value: BigInt(parsed.data.value),
      data: parsed.data.data.toLowerCase() as Hex,
    }
    const requestHash = hashRequest(request)
    const inserted = store.insertRequest({ ...request, idempotencyKey: key, requestHash })

    if (inserted.created) {
      deps.onAccepted(inserted.tx)
      res.status(202).json(ApiResponse.ok(toApiTransaction(inserted.tx, [])))
      return
    }
    if (inserted.tx.requestHash !== requestHash) {
      const message = 'this Idempotency-Key was already used for a different request'
      res.status(422).json(ApiResponse.error('IDEMPOTENCY_KEY_REUSED', message))
      return
    }
    res
      .status(200)
      .set('Idempotent-Replayed', 'true')
      .json(ApiResponse.ok(toApiTransaction(inserted.tx, store.attempts(inserted.tx.id))))
  })

  app.get('/transactions/:id', (req, res) => {
    const tx = store.get(txId(req.params.id))
    if (!tx) {
      res.status(404).json(ApiResponse.error('NOT_FOUND', 'no transaction has this id'))
      return
    }
    res.status(200).json(ApiResponse.ok(toApiTransaction(tx, store.attempts(tx.id))))
  })

  // Liveness only, as plain text: not part of the JSON API.
  app.get('/health', (_req, res) => {
    res.type('text/plain').send('Online')
  })

  app.use((_req, res) => {
    res.status(404).json(ApiResponse.error('NOT_FOUND', 'no such route'))
  })

  // Express recognises an error handler by its four parameters.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (error as { type?: unknown } | null)?.type
    if (type === 'entity.parse.failed') {
      res.status(400).json(ApiResponse.error('VALIDATION_ERROR', 'the body is not valid JSON'))
      return
    }
    if (type === 'entity.too.large') {
      res.status(413).json(ApiResponse.error('PAYLOAD_TOO_LARGE', `the body is over ${BODY_LIMIT}`))
      return
    }
    deps.logger.error({ err: error }, 'unhandled error')
    res.status(500).json(ApiResponse.error('INTERNAL_ERROR', 'internal error'))
  })

  return app
}

/** A fingerprint of the normalised request, to tell a replay from a key reused for something else (ADR 0010). */
function hashRequest(request: { chainId: ChainId; sender: Address; to: Address; value: bigint; data: Hex }): string {
  const canonical = [
    request.chainId,
    request.sender.toLowerCase(),
    request.to.toLowerCase(),
    request.value.toString(),
    request.data.toLowerCase(),
  ]
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function toApiTransaction(tx: Transaction, attempts: Attempt[]): ApiTransaction {
  return {
    id: tx.id,
    status: tx.status,
    chainId: tx.chainId,
    sender: tx.sender,
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit === null ? null : tx.gasLimit.toString(),
    hash: tx.status === 'queued' ? null : tx.hash,
    attempts: attempts.map((attempt) => ({
      hash: attempt.hash,
      outcome: attempt.outcome,
      fees: feesJson(attempt.fees),
      createdAt: attempt.createdAt,
    })),
    receipt: tx.status === 'succeeded' || tx.status === 'reverted' ? receiptJson(tx.receipt) : null,
    failure: tx.status === 'failed' ? failureJson(tx.failure) : null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  }
}

function feesJson(fees: Fees): ApiFees {
  return fees.type === 'legacy'
    ? { type: fees.type, gasPrice: fees.gasPrice.toString() }
    : {
        type: fees.type,
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      }
}

function receiptJson(receipt: Receipt): ApiReceipt {
  return {
    ...receipt,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
  }
}

function failureJson(failure: TxFailure): ApiFailure {
  const details = Object.fromEntries(
    Object.entries(failure).map(([field, value]) => [field, typeof value === 'bigint' ? value.toString() : value]),
  )
  return { ...details, code: failure.code, message: describeFailure(failure) }
}
