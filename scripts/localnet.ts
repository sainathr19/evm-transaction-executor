// Shared by the localnet scripts: run the real service against anvil and talk to it over HTTP.
// Test tooling only, not part of the service.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Hex } from 'viem'
import type { ApiResponse, ApiTransaction } from '../src/app'
import { unreachableUrl } from '../tests/helpers/anvil'

export { startAnvil } from '../tests/helpers/anvil'

/** anvil's first five dev keys. They're public: never use them on a real network. */
export const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
]

const REPO = fileURLToPath(new URL('..', import.meta.url))

export async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition().catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export type Service = {
  url: string
  logPath: string
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * The real service (src/main.ts) on a free port, with its database and log in a fresh temp
 * directory. It can be stopped and started again on the same database, as after a restart.
 */
export async function createService(rpcUrl: string, keys: Hex[]): Promise<Service> {
  const dir = mkdtempSync(join(tmpdir(), 'executor-localnet-'))
  const port = new URL(await unreachableUrl()).port
  const url = `http://127.0.0.1:${port}`
  const logPath = join(dir, 'service.log')
  let proc: ChildProcess | undefined

  return {
    url,
    logPath,
    async start() {
      const log = openSync(logPath, 'a')
      proc = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
        cwd: REPO,
        env: {
          PATH: process.env.PATH,
          RPC_URL_31337: rpcUrl,
          SIGNER_PRIVATE_KEYS: keys.join(','),
          PORT: port,
          DB_PATH: join(dir, 'executor.db'),
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', log, log],
      })
      await waitUntil(async () => (await fetch(`${url}/health`)).ok, 15_000, 'the service to start')
    },
    async stop() {
      const running = proc
      if (!running) return
      const exited = new Promise((resolve) => running.once('exit', resolve))
      running.kill('SIGTERM')
      await exited
      proc = undefined
    },
  }
}

export type Reply = { status: number; replayed: string | null; body: ApiResponse<ApiTransaction> }

/** POST /transactions. A new Idempotency-Key unless one is given; `null` sends none. */
export async function postTransaction(url: string, body: unknown, key: string | null = randomUUID()): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== null) headers['idempotency-key'] = key
  const res = await fetch(`${url}/transactions`, { method: 'POST', headers, body: JSON.stringify(body) })
  return {
    status: res.status,
    replayed: res.headers.get('idempotent-replayed'),
    body: (await res.json()) as ApiResponse<ApiTransaction>,
  }
}

/** The id of a request the service accepted, or an error explaining why it didn't. */
export function acceptedId(reply: Reply): string {
  if (reply.status !== 202 || reply.body.status !== 'ok') {
    throw new Error(`POST answered ${reply.status}: ${JSON.stringify(reply.body.error)}`)
  }
  return reply.body.result.id
}

export async function getTransaction(url: string, id: string): Promise<ApiTransaction> {
  const body = (await (await fetch(`${url}/transactions/${id}`)).json()) as ApiResponse<ApiTransaction>
  if (body.status !== 'ok') throw new Error(`GET ${id} failed: ${body.error.message}`)
  return body.result
}

type LogEntry = { level: number; msg: string; err?: { message?: string } }

/** The service's JSON log lines, and the ones at error level or above. */
export function readLog(logPath: string): { entries: LogEntry[]; errors: LogEntry[] } {
  const entries = readFileSync(logPath, 'utf8')
    .split('\n')
    .flatMap((line): LogEntry[] => {
      try {
        return [JSON.parse(line) as LogEntry]
      } catch {
        return []
      }
    })
  return { entries, errors: entries.filter((entry) => entry.level >= 50) }
}

/** Collects PASS/FAIL lines and says whether everything passed. */
export function createChecker() {
  const results: boolean[] = []
  return {
    check: (name: string, ok: boolean, detail = ''): void => {
      results.push(ok)
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
    },
    summary: (): boolean => {
      const passed = results.filter(Boolean).length
      console.log(`\n${passed}/${results.length} checks passed`)
      return passed === results.length
    },
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
