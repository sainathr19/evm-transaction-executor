import { setTimeout as sleep } from 'node:timers/promises'
import { BaseError, HttpRequestError, RpcRequestError, TimeoutError, type Hex } from 'viem'
import type { Sender } from './rpc'

export type Rejection = 'nonce_too_low' | 'nonce_too_high' | 'insufficient_funds' | 'other'

/**
 * accepted: a node has the transaction. unknown: some send went unanswered, so a node may have it.
 * rejected: every send was answered with a rejection, so no node has it (ADRs 0008 and 0009).
 */
export type BroadcastResult =
  | { outcome: 'accepted' }
  | { outcome: 'unknown' }
  | { outcome: 'rejected'; reason: Rejection; message: string }

export type SendError = { answered: false } | { answered: true; message: string }

/**
 * Only a JSON-RPC error response counts as the node's answer. Timeouts, refused connections and
 * HTTP errors (429, 5xx) don't: the node may have received the transaction (ADR 0008).
 */
export function describeSendError(error: unknown): SendError {
  if (!(error instanceof BaseError)) return { answered: false }
  const response = error.walk((cause) => cause instanceof RpcRequestError)
  return response instanceof RpcRequestError ? { answered: true, message: response.details } : { answered: false }
}

/** A viem transport failure: a timeout, a refused connection or an HTTP error. The node gave no answer. */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  return error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError) !== null
}

// Node software words these differently, so matching is best effort. We don't use viem's typed
// errors: its NonceTooLowError also matches "already known" (ADR 0008).
const NODE_MESSAGES: Array<[RegExp, Rejection | 'already_known']> = [
  [/already ?known|already imported|known transaction/i, 'already_known'],
  [/nonce (is )?too low/i, 'nonce_too_low'],
  [/nonce (is )?too high/i, 'nonce_too_high'],
  [/insufficient funds|exceeds transaction sender account balance/i, 'insufficient_funds'],
]

export function classifyNodeMessage(message: string): Rejection | 'already_known' {
  return NODE_MESSAGES.find(([pattern]) => pattern.test(message))?.[1] ?? 'other'
}

/**
 * Sends the same signed transaction up to `maxSends` times, moving to the next URL after each
 * unanswered send. Stops at the first answer: an acceptance, or a rejection.
 */
export async function broadcast(
  raw: Hex,
  senders: Sender[],
  { maxSends = 3, delayMs = 250 }: { maxSends?: number; delayMs?: number } = {},
): Promise<BroadcastResult> {
  let unanswered = false
  for (let send = 0; send < maxSends; send++) {
    if (send > 0 && delayMs > 0) await sleep(delayMs)
    try {
      await senders[send % senders.length](raw)
      return { outcome: 'accepted' }
    } catch (error) {
      const described = describeSendError(error)
      if (!described.answered) {
        unanswered = true
        continue
      }
      const reason = classifyNodeMessage(described.message)
      if (reason === 'already_known') return { outcome: 'accepted' }
      // After an unanswered send, even `nonce too low` may mean our own transaction was mined.
      if (unanswered) return { outcome: 'unknown' }
      return { outcome: 'rejected', reason, message: described.message }
    }
  }
  return { outcome: 'unknown' }
}
