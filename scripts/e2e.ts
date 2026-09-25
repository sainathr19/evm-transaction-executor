// End-to-end run: a real anvil node and the real service, driven over HTTP only. Each scenario
// uses anvil's test methods to create a condition from the README's edge-case table.
// Usage: npm run e2e
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createPublicClient, createTestClient, createWalletClient, type Hex, http, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import type { ApiTransaction } from '../src/app'
import type { TxStatus } from '../src/types'
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
  waitUntil,
} from './localnet'

const [KEY_0, KEY_1] = ANVIL_KEYS
const S0 = privateKeyToAccount(KEY_0).address
const S1 = privateKeyToAccount(KEY_1).address
const TO = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const STUCK_WAIT_MS = 6_500 // the anvil chain config: stuckAfterMs 5000, pollIntervalMs 500

const node = await startAnvil()
const chain = createPublicClient({ chain: anvil, transport: http(node.url) })
const testClient = createTestClient({ chain: anvil, mode: 'anvil', transport: http(node.url) })
const outsider = (key: Hex) =>
  createWalletClient({ account: privateKeyToAccount(key), chain: anvil, transport: http(node.url) })
const service = await createService(node.url, [KEY_0, KEY_1])
await service.start()
const { check, summary } = createChecker()

const transfer = (overrides: Record<string, unknown> = {}) => ({
  network: 31337,
  sender: S0,
  to: TO,
  value: '1000000000000000',
  ...overrides,
})
const post = (body: unknown, key?: string | null) => postTransaction(service.url, body, key)
const get = (id: string) => getTransaction(service.url, id)
const submit = async (body: unknown) => acceptedId(await post(body))

async function until(id: string, statuses: TxStatus[], timeoutMs = 20_000): Promise<ApiTransaction> {
  let tx = await get(id)
  await waitUntil(
    async () => statuses.includes((tx = await get(id)).status),
    timeoutMs,
    `${id} to be ${statuses.join('/')}`,
  )
  return tx
}

async function scenario(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    check(name, false, errorMessage(error))
  } finally {
    await testClient.setAutomine(true).catch(() => undefined)
  }
}

console.log(`anvil ${node.url}, service ${service.url}\n`)

await scenario('health', async () => {
  const res = await fetch(`${service.url}/health`)
  check('GET /health answers Online', res.status === 200 && (await res.text()) === 'Online')
})

await scenario('happy path', async () => {
  const reply = await post(transfer())
  const tx = await until(acceptedId(reply), ['succeeded', 'failed', 'reverted'])
  check(
    'submit → 202 queued → succeeded with a receipt',
    reply.body.status === 'ok' && reply.body.result.status === 'queued' && tx.status === 'succeeded',
    `nonce ${tx.nonce}, gasLimit ${tx.gasLimit}, gasUsed ${tx.receipt?.gasUsed}`,
  )
})

await scenario('idempotency', async () => {
  const key = randomUUID()
  const first = await post(transfer({ value: '1' }), key)
  const replay = await post(transfer({ value: '1', sender: S0.toLowerCase() }), key)
  const reused = await post(transfer({ value: '2' }), key)
  check(
    'same key + same body → 200 replay of the same transaction',
    replay.status === 200 && replay.replayed === 'true' && replay.body.result?.id === acceptedId(first),
  )
  check(
    'same key + different body → 422 IDEMPOTENCY_KEY_REUSED',
    reused.status === 422 && reused.body.error?.code === 'IDEMPOTENCY_KEY_REUSED',
  )
  await until(acceptedId(first), ['succeeded'])
})

await scenario('validation', async () => {
  const cases = [
    ['missing Idempotency-Key', await post(transfer(), null), 'IDEMPOTENCY_KEY_MISSING'],
    ['bad address', await post(transfer({ to: '0x1234' })), 'VALIDATION_ERROR'],
    ['value above uint256', await post(transfer({ value: (2n ** 256n).toString() })), 'VALIDATION_ERROR'],
    ['unsupported network', await post(transfer({ network: 1 })), 'UNSUPPORTED_NETWORK'],
    ['sender with no key', await post(transfer({ sender: TO })), 'UNKNOWN_SENDER'],
  ] as const
  for (const [name, reply, code] of cases) {
    check(`rejects ${name} → 400 ${code}`, reply.status === 400 && reply.body.error?.code === code)
  }
})

await scenario('concurrency', async () => {
  const start = await chain.getTransactionCount({ address: S0 })
  const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(transfer({ value: String(i + 1) }))))
  const txs = await Promise.all(ids.map((id) => until(id, ['succeeded', 'failed'], 30_000)))
  const nonces = txs.map((tx) => tx.nonce ?? -1).sort((a, b) => a - b)
  check(
    '20 concurrent requests from one sender (cap 16) → 20 distinct nonces, all mined',
    txs.every((tx) => tx.status === 'succeeded') && nonces.every((nonce, i) => nonce === start + i),
    `nonces ${nonces[0]}..${nonces.at(-1)}`,
  )
})

await scenario('two senders', async () => {
  const ids = await Promise.all(
    [S0, S1, S0, S1, S0, S1].map((sender, i) => submit(transfer({ sender, value: String(100 + i) }))),
  )
  const txs = await Promise.all(ids.map((id) => until(id, ['succeeded', 'failed'])))
  const noncesOf = (sender: string) => txs.filter((tx) => tx.sender === sender).map((tx) => tx.nonce)
  const distinct = (list: unknown[]) => new Set(list).size === list.length
  check(
    'two senders in parallel → each gets its own nonce sequence',
    txs.every((tx) => tx.status === 'succeeded') && distinct(noncesOf(S0)) && distinct(noncesOf(S1)),
    `S0 ${noncesOf(S0).join(',')}, S1 ${noncesOf(S1).join(',')}`,
  )
})

await scenario('revert at estimation', async () => {
  const reverter = '0x000000000000000000000000000000000000dEaD'
  await testClient.setCode({ address: reverter, bytecode: '0x60006000fd' }) // REVERT(0, 0)
  const before = await chain.getTransactionCount({ address: S0 })
  const tx = await until(await submit(transfer({ to: reverter })), ['failed', 'succeeded'])
  const next = await until(await submit(transfer()), ['succeeded'])
  check(
    'a call that would revert → failed ESTIMATION_REVERTED, no nonce used',
    tx.failure?.code === 'ESTIMATION_REVERTED' && tx.nonce === null && next.nonce === before,
    tx.failure?.message ?? '',
  )
})

await scenario('revert on chain', async () => {
  const target = '0x000000000000000000000000000000000000bEEF'
  await testClient.setAutomine(false)
  const id = await submit(transfer({ to: target }))
  await until(id, ['submitted'])
  await testClient.setCode({ address: target, bytecode: '0x60006000fd' }) // reverts only once mined
  await testClient.mine({ blocks: 1 })
  const tx = await until(id, ['reverted', 'succeeded', 'failed'])
  check(
    'mined but reverted → reverted, with the receipt',
    tx.status === 'reverted' && tx.receipt?.status === 'reverted',
  )
})

await scenario('fee spike', async () => {
  await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('200') })
  await testClient.mine({ blocks: 1 })
  const tx = await until(await submit(transfer()), ['failed', 'succeeded'])
  await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('1') })
  await testClient.mine({ blocks: 1 })
  check(
    'base fee above the 100 gwei cap → failed FEE_ABOVE_CAP',
    tx.failure?.code === 'FEE_ABOVE_CAP' && tx.failure.capWei === parseGwei('100').toString(),
    tx.failure?.message ?? '',
  )
})

await scenario('insufficient funds', async () => {
  const balance = await chain.getBalance({ address: S1 })
  await testClient.setBalance({ address: S1, value: 0n })
  const tx = await until(await submit(transfer({ sender: S1 })), ['failed', 'succeeded'])
  await testClient.setBalance({ address: S1, value: balance })
  check(
    'empty sender → failed INSUFFICIENT_FUNDS',
    tx.failure?.code === 'INSUFFICIENT_FUNDS',
    tx.failure?.message ?? '',
  )
})

await scenario('stuck → fee bump', async () => {
  await testClient.setAutomine(false)
  const id = await submit(transfer())
  const submitted = await until(id, ['submitted'])
  await sleep(STUCK_WAIT_MS)
  const bumped = await get(id)
  await testClient.mine({ blocks: 1 })
  const tx = await until(id, ['succeeded', 'failed'])
  const [first, second] = bumped.attempts
  const maxFee = (attempt?: ApiTransaction['attempts'][number]) =>
    attempt?.fees.type === 'eip1559' ? BigInt(attempt.fees.maxFeePerGas) : 0n
  check(
    'stuck past stuckAfterMs → replaced at the same nonce with higher fees; the replacement is mined',
    bumped.attempts.length >= 2 &&
      maxFee(second) > maxFee(first) &&
      tx.status === 'succeeded' &&
      tx.nonce === submitted.nonce &&
      tx.hash === bumped.attempts.at(-1)?.hash,
    `maxFeePerGas ${maxFee(first)} → ${maxFee(second)}, attempts ${bumped.attempts.length}`,
  )
})

await scenario('dropped from the mempool', async () => {
  await testClient.setAutomine(false)
  const id = await submit(transfer())
  const submitted = await until(id, ['submitted'])
  if (submitted.hash) await testClient.dropTransaction({ hash: submitted.hash })
  await sleep(STUCK_WAIT_MS)
  await testClient.mine({ blocks: 1 })
  const tx = await until(id, ['succeeded', 'failed'])
  check(
    'dropped by the node → sent again by the monitor, then mined',
    tx.status === 'succeeded' && tx.nonce === submitted.nonce,
    `attempts ${tx.attempts.length}`,
  )
})

await scenario('nonce used outside the service', async () => {
  const outside = await outsider(KEY_1).sendTransaction({ to: TO, value: 1n }) // takes S1's next nonce
  await chain.waitForTransactionReceipt({ hash: outside })
  const collided = await until(await submit(transfer({ sender: S1 })), ['failed', 'succeeded'])
  const next = await until(await submit(transfer({ sender: S1 })), ['succeeded', 'failed'])
  const count = await chain.getTransactionCount({ address: S1 })
  check(
    'outside tx took the nonce → request fails with nonce too low, pool resyncs, next request succeeds',
    collided.failure?.code === 'BROADCAST_REJECTED' && next.status === 'succeeded' && next.nonce === count - 1,
    `${collided.failure?.message}; next nonce ${next.nonce}`,
  )
})

await scenario('NONCE_TAKEN', async () => {
  await testClient.setAutomine(false)
  const id = await submit(transfer())
  const submitted = await until(id, ['submitted'])
  // An outside tx replaces ours in the mempool at the same nonce, and is mined.
  await outsider(KEY_0).sendTransaction({
    to: TO,
    value: 2n,
    nonce: submitted.nonce ?? undefined,
    maxFeePerGas: parseGwei('50'),
    maxPriorityFeePerGas: parseGwei('10'),
  })
  await testClient.mine({ blocks: 1 })
  const tx = await until(id, ['failed', 'succeeded'])
  check(
    'outside tx replaced ours and was mined → failed NONCE_TAKEN',
    tx.failure?.code === 'NONCE_TAKEN',
    tx.failure?.message ?? '',
  )
})

await scenario('restart', async () => {
  await testClient.setAutomine(false)
  const id = await submit(transfer())
  const submitted = await until(id, ['submitted'])
  await service.stop()
  await testClient.mine({ blocks: 1 }) // mined while the service is down
  await service.start()
  const tx = await until(id, ['succeeded', 'failed'])
  await testClient.setAutomine(true)
  const after = await until(await submit(transfer()), ['succeeded', 'failed'])
  check(
    'restart with a tx in flight → recovered, receipt found, and the next nonce follows on',
    tx.status === 'succeeded' && after.status === 'succeeded' && after.nonce === (submitted.nonce ?? -2) + 1,
    `in-flight nonce ${submitted.nonce}, next nonce ${after.nonce}`,
  )
})

await service.stop()
await node.stop()

const { entries, errors } = readLog(service.logPath)
console.log(`\nservice log: ${entries.length} lines (${service.logPath})`)
check('no errors in the service log', errors.length === 0, errors[0]?.msg ?? '')
process.exit(summary() ? 0 : 1)
