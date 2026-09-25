import { createPublicClient, http } from 'viem'
import { anvil } from 'viem/chains'
import { expect, test } from 'vitest'
import { startAnvil } from '../helpers/anvil'

test('startAnvil serves chain 31337 and stops cleanly', async () => {
  const node = await startAnvil()
  try {
    const client = createPublicClient({ chain: anvil, transport: http(node.url) })
    expect(await client.getChainId()).toBe(31337)
  } finally {
    await node.stop()
  }
})
