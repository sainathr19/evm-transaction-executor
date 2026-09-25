import { createPublicClient, createTestClient, hexToBigInt, http, parseGwei, type PublicClient } from 'viem'
import { anvil } from 'viem/chains'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { estimateGasLimit, readMarketFees } from '../../src/executor/gas'
import { startAnvil, type AnvilNode } from '../helpers/anvil'
import { ADDRESS_0, ADDRESS_1 } from '../helpers/keys'

let node: AnvilNode
let client: PublicClient

beforeAll(async () => {
  node = await startAnvil()
  client = createPublicClient({ chain: anvil, transport: http(node.url) })
})

afterAll(() => node.stop())

test('reads the latest base fee and the node suggested tip', async () => {
  const testClient = createTestClient({ chain: anvil, mode: 'anvil', transport: http(node.url) })
  await testClient.setNextBlockBaseFeePerGas({ baseFeePerGas: parseGwei('7') })
  await testClient.mine({ blocks: 1 })

  // anvil suggests a 1 gwei tip
  expect(await readMarketFees(client, 'eip1559')).toEqual({
    type: 'eip1559',
    baseFee: parseGwei('7'),
    tip: parseGwei('1'),
  })
})

test('reads eth_gasPrice for legacy chains', async () => {
  const nodeGasPrice = hexToBigInt(await client.request({ method: 'eth_gasPrice' }))
  expect(await readMarketFees(client, 'legacy')).toEqual({ type: 'legacy', gasPrice: nodeGasPrice })
})

test('says to use legacy pricing when the chain has no base fee', async () => {
  const berlin = await startAnvil(['--hardfork', 'berlin'])
  try {
    const preLondon = createPublicClient({ chain: anvil, transport: http(berlin.url) })
    await expect(readMarketFees(preLondon, 'eip1559')).rejects.toThrow(/legacy/)
  } finally {
    await berlin.stop()
  }
})

test('estimates the gas limit with the buffer applied', async () => {
  const limit = await estimateGasLimit(client, { sender: ADDRESS_0, to: ADDRESS_1, value: 1n, data: '0x' }, 20)
  expect(limit).toBe(25_200n) // a plain transfer costs 21,000
})
