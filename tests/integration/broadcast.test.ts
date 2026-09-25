import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPublicClient, createTestClient, http, parseGwei, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil, sepolia } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { broadcast } from '../../src/executor/broadcast'
import { withDefaults } from '../../src/config/defaults'
import type { EnabledChain } from '../../src/config/load'
import { createChainRpc, verifyChainId } from '../../src/executor/rpc'
import { startAnvil, unreachableUrl, type AnvilNode } from '../helpers/anvil'
import { expectConfigErrorAsync } from '../helpers/errors'
import { ADDRESS_1, KEY_0 } from '../helpers/keys'

let node: AnvilNode

beforeAll(async () => {
  node = await startAnvil()
})

afterAll(() => node.stop())

function enabled(rpcUrls: string[], chain: Chain = anvil): EnabledChain {
  return { ...withDefaults({ chain, gas: { maxFeePerGasWei: parseGwei('100') } }), rpcUrls }
}

async function signTransfer(key: Hex): Promise<Hex> {
  const account = privateKeyToAccount(key)
  const client = createPublicClient({ chain: anvil, transport: http(node.url) })
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' })
  return account.signTransaction({
    chainId: anvil.id,
    type: 'eip1559',
    to: ADDRESS_1,
    value: 1n,
    gas: 21_000n,
    maxFeePerGas: parseGwei('10'),
    maxPriorityFeePerGas: parseGwei('1'),
    nonce,
  })
}

describe('broadcast against anvil', () => {
  test('accepts, then treats a resend as already known, then as nonce too low once mined', async () => {
    const testClient = createTestClient({ chain: anvil, mode: 'anvil', transport: http(node.url) })
    const { senders } = createChainRpc(enabled([node.url]))
    await testClient.setAutomine(false)
    try {
      const raw = await signTransfer(KEY_0)
      expect(await broadcast(raw, senders, { delayMs: 0 })).toEqual({ outcome: 'accepted' })
      expect(await broadcast(raw, senders, { delayMs: 0 })).toEqual({ outcome: 'accepted' })

      await testClient.mine({ blocks: 1 })
      expect(await broadcast(raw, senders, { delayMs: 0 })).toMatchObject({
        outcome: 'rejected',
        reason: 'nonce_too_low',
      })
    } finally {
      await testClient.setAutomine(true)
    }
  })

  test('rejects a sender without funds', async () => {
    const { senders } = createChainRpc(enabled([node.url]))
    const broke = `0x${'0'.repeat(63)}1` as Hex
    expect(await broadcast(await signTransfer(broke), senders, { delayMs: 0 })).toMatchObject({
      outcome: 'rejected',
      reason: 'insufficient_funds',
    })
  })

  test('is unknown when the RPC is unreachable', async () => {
    const { senders } = createChainRpc(enabled([await unreachableUrl()]))
    expect(await broadcast(await signTransfer(KEY_0), senders, { delayMs: 0 })).toEqual({ outcome: 'unknown' })
  })

  test('falls back to the next URL', async () => {
    const { senders } = createChainRpc(enabled([await unreachableUrl(), node.url]))
    expect(await broadcast(await signTransfer(KEY_0), senders, { delayMs: 0 })).toEqual({ outcome: 'accepted' })
  })
})

// A local JSON-RPC endpoint that fails with HTTP 502 until `failures` requests have been made.
async function flakyRpc(failures: number) {
  let requests = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests++
      if (requests <= failures) {
        res.writeHead(502).end()
        return
      }
      const { id } = JSON.parse(body) as { id: number }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: `0x${anvil.id.toString(16)}` }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('retries', () => {
  test('a sender makes one request to its own URL, so broadcast() sees every unanswered send', async () => {
    const first = await flakyRpc(1)
    const second = await flakyRpc(0)
    try {
      const { senders } = createChainRpc(enabled([first.url, second.url]))
      await expect(senders[0]('0x02')).rejects.toThrow()
      expect([first.requests(), second.requests()]).toEqual([1, 0])
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('reads retry through server errors', async () => {
    const rpc = await flakyRpc(2)
    try {
      const { read } = createChainRpc(enabled([rpc.url]))
      expect(await read.getChainId()).toBe(anvil.id)
      expect(rpc.requests()).toBe(3)
    } finally {
      await rpc.close()
    }
  })

  test('reads fall back to the next URL', async () => {
    const { read } = createChainRpc(enabled([await unreachableUrl(), node.url]))
    expect(await read.getChainId()).toBe(anvil.id)
  })
})

describe('verifyChainId', () => {
  test('passes when every URL serves the configured chain', async () => {
    await expect(verifyChainId(enabled([node.url, node.url]))).resolves.toBeUndefined()
  })

  test('refuses a URL that serves a different chain, without echoing it', async () => {
    const error = await expectConfigErrorAsync(verifyChainId(enabled([node.url], sepolia)))
    expect(error.message).toContain(`RPC_URL_${sepolia.id} entry 1`)
    expect(error.message).toContain(String(anvil.id))
    expect(error.message).not.toContain(node.url)
  })

  test('refuses a URL it cannot reach', async () => {
    const url = await unreachableUrl()
    const error = await expectConfigErrorAsync(verifyChainId(enabled([node.url, url])))
    expect(error.message).toContain(`RPC_URL_${anvil.id} entry 2`)
    expect(error.message).not.toContain(url)
  })
})
