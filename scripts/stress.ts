// Stress test: many transfers through the real service, first clean, then with RPC faults injected by
// a proxy between the service and anvil. Checks the invariants a nonce bug would break.
// Usage: npm run stress            (1000 transfers from 5 senders; anvil mines each tx on arrival)
//        TRANSFERS=100 npm run stress
// Options, all env vars:
//   TRANSFERS     transfers per phase (default 1000)
//   SENDERS       senders (default 5); any beyond anvil's first five get new keys, funded by anvil
//   BLOCK_TIME    whole seconds between anvil blocks (default: a block for each tx, as it arrives)
//   RPC_DELAY_MS  delay the proxy adds to every RPC call (default 0)
//   CLEAN_ONLY=1  skip the phase with injected faults
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Address, createPublicClient, createTestClient, type Hex, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import type { ApiTransaction } from '../src/app'
import {
  acceptedId,
  ANVIL_KEYS,
  createChecker,
  createService,
  errorMessage,
  getTransaction,
  postTransaction,
  readLog,
  startAnvil,
} from './localnet'

const TRANSFERS = envInteger('TRANSFERS', 1000, 1)
const SENDER_COUNT = envInteger('SENDERS', ANVIL_KEYS.length, 1)
const BLOCK_TIME = process.env.BLOCK_TIME ? envInteger('BLOCK_TIME', 0, 1) : null
const RPC_DELAY_MS = envInteger('RPC_DELAY_MS', 0, 0)
const CLEAN_ONLY = process.env.CLEAN_ONLY === '1'

const KEYS: Hex[] = Array.from({ length: SENDER_COUNT }, (_, i) => ANVIL_KEYS[i] ?? generatePrivateKey())
const SENDERS = KEYS.map((key) => privateKeyToAccount(key).address)
const FINAL = new Set(['succeeded', 'reverted', 'failed'])

/** An env var holding a whole number of at least `min`. */
function envInteger(name: string, fallback: number, min: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return value
}

// --- Fault-injecting JSON-RPC proxy between the service and anvil -----------------------------------

type FaultRates = { reject: number; lostReply: number; blackhole: number }
const rates: FaultRates = { reject: 0, lostReply: 0, blackhole: 0 }
const faults = { sends: 0, rejected: 0, lostReply: 0, blackholed: 0 }
/** Whether each signed transaction is blackholed, decided the first time it's seen. */
const blackholed = new Map<Hex, boolean>()

const node = await startAnvil(BLOCK_TIME === null ? [] : ['--block-time', String(BLOCK_TIME)])
const chain = createPublicClient({ chain: anvil, transport: http(node.url) })
const testClient = createTestClient({ chain: anvil, mode: 'anvil', transport: http(node.url) })
for (const address of SENDERS.slice(ANVIL_KEYS.length)) {
  await testClient.setBalance({ address, value: parseEther('1000') })
}

const forward = async (body: string) =>
  (await fetch(node.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text()

async function relay(body: string, res: ServerResponse): Promise<void> {
  if (RPC_DELAY_MS > 0) await sleep(RPC_DELAY_MS) // as if the RPC were further away
  const payload = JSON.parse(body) as { id: number; method: string; params: unknown[] } | unknown[]
  if (!Array.isArray(payload) && payload.method === 'eth_sendRawTransaction') {
    faults.sends++
    const raw = payload.params[0] as Hex
    if (!blackholed.has(raw)) blackholed.set(raw, Math.random() < rates.blackhole)
    if (blackholed.get(raw)) {
      faults.blackholed++
      res.writeHead(502).end() // never reaches a node, however often it's sent
      return
    }
    const roll = Math.random()
    if (roll < rates.reject) {
      faults.rejected++
      const error = { code: -32003, message: 'intrinsic gas too low' }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error }))
      return
    }
    if (roll < rates.reject + rates.lostReply) {
      faults.lostReply++
      await forward(body) // the node takes it, but the reply is lost
      res.writeHead(502).end()
      return
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(await forward(body))
}

const proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', (chunk: Buffer) => (body += chunk.toString()))
  req.on('end', () => void relay(body, res))
})
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`

const service = await createService(proxyUrl, KEYS)
await service.start()
const { check, summary } = createChecker()

// --- HTTP client: at most 64 requests at once, and one poller for everything in flight ---------------

let active = 0
const waitingForSlot: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 64) await new Promise<void>((resolve) => waitingForSlot.push(resolve))
  active++
  try {
    return await fn()
  } finally {
    active--
    waitingForSlot.shift()?.()
  }
}

const waiters = new Map<string, (tx: ApiTransaction) => void>()
let polling = true
const waitFinal = (id: string) => new Promise<ApiTransaction>((resolve) => waiters.set(id, resolve))

async function poll(): Promise<void> {
  while (polling) {
    await Promise.all(
      [...waiters.keys()].map(async (id) => {
        const tx = await limited(() => getTransaction(service.url, id))
        if (FINAL.has(tx.status)) {
          waiters.get(id)?.(tx)
          waiters.delete(id)
        }
      }),
    )
    await sleep(250)
  }
}

// --- One phase -----------------------------------------------------------------------------------------

async function runPhase(name: string, recipient: Address, phaseRates: FaultRates): Promise<void> {
  Object.assign(rates, phaseRates)
  const faultsBefore = { ...faults }
  const startNonces = await Promise.all(SENDERS.map((address) => chain.getTransactionCount({ address })))
  const startBalance = await chain.getBalance({ address: recipient })
  const transfers = Array.from({ length: TRANSFERS }, (_, i) => ({
    sender: SENDERS[i % SENDERS.length],
    value: BigInt(i + 1), // unique, so a double execution shows up in the recipient's balance
  }))
  let resubmitted = 0
  const started = Date.now()

  // Like a real client: when the node rejected a request, resubmit it with a new key (ADR 0009).
  const deliver = async (transfer: (typeof transfers)[number]): Promise<ApiTransaction> => {
    for (let tries = 1; tries <= 10; tries++) {
      const body = { network: 31337, sender: transfer.sender, to: recipient, value: transfer.value.toString() }
      const tx = await waitFinal(acceptedId(await limited(() => postTransaction(service.url, body))))
      if (tx.status === 'succeeded') return tx
      if (tx.failure?.code !== 'BROADCAST_REJECTED') throw new Error(`unexpected ${tx.status}: ${tx.failure?.message}`)
      resubmitted++
    }
    throw new Error('rejected 10 times')
  }

  const settled = await Promise.allSettled(transfers.map(deliver))
  const seconds = (Date.now() - started) / 1000
  const mined = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const errors = settled.flatMap((result) => (result.status === 'rejected' ? [errorMessage(result.reason)] : []))

  const blocks = BLOCK_TIME === null ? 'a block per tx' : `${BLOCK_TIME} s blocks`
  console.log(
    `\n${name}: ${TRANSFERS} transfers from ${SENDERS.length} senders, ${blocks}, RPC delay ${RPC_DELAY_MS} ms`,
  )
  check(
    'every transfer ends as succeeded',
    errors.length === 0,
    errors.length ? `${errors.length} errors: ${errors[0]}` : '',
  )

  const expected = transfers.reduce((sum, transfer) => sum + transfer.value, 0n)
  const received = (await chain.getBalance({ address: recipient })) - startBalance
  check(
    'exactly once: the recipient received exactly the sum of all transfers',
    received === expected,
    `${received} of ${expected} wei`,
  )

  let contiguous = true
  let counted = true
  for (const [i, sender] of SENDERS.entries()) {
    const nonces = mined
      .filter((tx) => tx.sender === sender)
      .map((tx) => tx.nonce ?? -1)
      .sort((a, b) => a - b)
    contiguous &&= nonces.every((nonce, j) => nonce === startNonces[i] + j)
    counted &&= (await chain.getTransactionCount({ address: sender })) - startNonces[i] === nonces.length
  }
  check('each sender: nonces contiguous from where it started, none reused', contiguous)
  check('each sender: on-chain nonce count rose by exactly its mined requests', counted)
  check(
    'every mined request is recorded under the hash that was mined',
    mined.every((tx) => tx.receipt?.transactionHash === tx.hash && tx.receipt.status === 'success'),
  )

  const latencies = mined.map((tx) => Date.parse(tx.updatedAt) - Date.parse(tx.createdAt)).sort((a, b) => a - b)
  const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]
  const attempts: Record<number, number> = {}
  for (const tx of mined) attempts[tx.attempts.length] = (attempts[tx.attempts.length] ?? 0) + 1
  const injected = Object.fromEntries(
    Object.entries(faults).map(([fault, count]) => [fault, count - faultsBefore[fault as keyof typeof faults]]),
  )
  console.log(`  ${seconds.toFixed(1)} s, ${(TRANSFERS / seconds).toFixed(0)} transfers/s`)
  console.log(`  accepted → mined: p50 ${percentile(50)} ms, p95 ${percentile(95)} ms, max ${latencies.at(-1)} ms`)
  console.log(`  attempts per mined request: ${JSON.stringify(attempts)}; rejected and resubmitted: ${resubmitted}`)
  console.log(`  injected: ${JSON.stringify(injected)}`)
}

void poll()
await runPhase('Phase 1, clean', '0x000000000000000000000000000000000000c1ea', {
  reject: 0,
  lostReply: 0,
  blackhole: 0,
})
if (!CLEAN_ONLY) {
  await runPhase('Phase 2, faults injected', '0x000000000000000000000000000000000000c2ea', {
    reject: 0.05, // a clear rejection, never forwarded
    lostReply: 0.05, // forwarded, then HTTP 502
    blackhole: 0.02, // of signed transactions: never forwarded, on any send
  })
}

polling = false
await service.stop()
proxy.close()
await node.stop()

const { entries, errors } = readLog(service.logPath)
console.log(`\nservice log: ${entries.length} lines (${service.logPath})`)
check('no errors in the service log', errors.length === 0, errors[0]?.msg ?? '')
process.exit(summary() ? 0 : 1)
