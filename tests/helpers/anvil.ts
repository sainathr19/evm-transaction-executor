import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createPublicClient, http } from 'viem'
import { anvil } from 'viem/chains'

export type AnvilNode = { url: string; stop: () => Promise<void> }

/** Starts a fresh anvil node on a free port. Always call stop() in afterAll/finally. */
export async function startAnvil(args: string[] = []): Promise<AnvilNode> {
  const port = await freePort()
  const proc = spawn('anvil', ['--port', String(port), '--silent', ...args], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  await waitForRpc(url, proc)
  return { url, stop: () => stop(proc) }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function waitForRpc(url: string, proc: ChildProcess): Promise<void> {
  const client = createPublicClient({ chain: anvil, transport: http(url, { retryCount: 0 }) })
  for (let i = 0; i < 100; i++) {
    if (exited(proc)) throw new Error(`anvil exited early with code ${proc.exitCode}`)
    try {
      await client.getChainId()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  proc.kill()
  throw new Error(`anvil did not answer on ${url} within 5 s`)
}

function stop(proc: ChildProcess): Promise<void> {
  if (exited(proc)) return Promise.resolve()
  return new Promise((resolve) => {
    proc.once('exit', () => resolve())
    proc.kill('SIGTERM')
  })
}

function exited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}
