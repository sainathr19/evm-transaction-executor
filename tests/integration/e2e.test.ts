import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startAnvil, type AnvilNode, unreachableUrl } from '../helpers/anvil'
import { ADDRESS_0, ADDRESS_1, KEY_0 } from '../helpers/keys'

// Runs the real service (src/main.ts) against anvil, and talks to it over HTTP only.

let node: AnvilNode
let service: ChildProcess
let baseUrl: string
let dataDir: string

beforeAll(async () => {
  node = await startAnvil()
  dataDir = mkdtempSync(join(tmpdir(), 'executor-e2e-'))
  baseUrl = await unreachableUrl() // a free port for the service
  service = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
    env: {
      PATH: process.env.PATH,
      RPC_URL_31337: node.url,
      SIGNER_PRIVATE_KEYS: KEY_0,
      PORT: new URL(baseUrl).port,
      DB_PATH: join(dataDir, 'executor.db'),
      LOG_LEVEL: 'silent',
    },
    stdio: 'inherit',
  })
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${baseUrl}/health`).then(
      (res) => res.ok,
      () => false,
    )
    if (up) return
    await sleep(100)
  }
  throw new Error('the service did not start within 10 s')
})

afterAll(async () => {
  service.kill('SIGTERM')
  await new Promise((resolve) => service.once('exit', resolve))
  await node.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

test('submits a transaction and reports its receipt', async () => {
  const submitted = await fetch(`${baseUrl}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-1' },
    body: JSON.stringify({ network: 31337, sender: ADDRESS_0, to: ADDRESS_1, value: '1000000000000000' }),
  })
  expect(submitted.status).toBe(202)
  const { result } = (await submitted.json()) as { result: { id: string } }

  let tx: { status: string } = { status: 'queued' }
  for (let i = 0; i < 50 && tx.status !== 'succeeded'; i++) {
    await sleep(100)
    tx = ((await (await fetch(`${baseUrl}/transactions/${result.id}`)).json()) as { result: { status: string } }).result
  }
  expect(tx).toMatchObject({
    status: 'succeeded',
    nonce: 0,
    value: '1000000000000000',
    receipt: { status: 'success', gasUsed: '21000' },
  })
})

test('answers Online on /health', async () => {
  const res = await fetch(`${baseUrl}/health`)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('Online')
})
