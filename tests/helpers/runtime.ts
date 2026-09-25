import { randomUUID } from 'node:crypto'
import { createTestClient, http, parseGwei, type PublicClient, type TestClient } from 'viem'
import { anvil } from 'viem/chains'
import { withDefaults } from '../../src/config/defaults'
import type { EnabledChain } from '../../src/config/load'
import { buildSigners } from '../../src/config/signers'
import type { ChainConfig, GasConfig } from '../../src/config/types'
import { Monitor } from '../../src/executor/monitor'
import { NoncePool } from '../../src/executor/nonce-pool'
import { recover } from '../../src/executor/recovery'
import { createChainRpc, type RuntimeChain, type Sender } from '../../src/executor/rpc'
import { SenderRegistry } from '../../src/executor/senders'
import { Worker, type WorkerOptions } from '../../src/executor/worker'
import { createLogger } from '../../src/logger'
import { openDb } from '../../src/store/db'
import { type NewRequest, Store } from '../../src/store/store'
import { chainId, nonce, type Transaction } from '../../src/types'
import { ADDRESS_0, ADDRESS_1, KEY_0, KEY_1 } from './keys'

/** The chain id of every test runtime: a local anvil node. */
export const ANVIL = chainId(anvil.id)

export type RuntimeOptions = {
  chain?: Partial<Omit<ChainConfig, 'chain' | 'gas'>> & { gas?: Partial<GasConfig> }
  worker?: Partial<WorkerOptions>
  /** Replaces the broadcast senders, e.g. to simulate a node that times out. */
  wrapSenders?: (real: Sender[]) => Sender[]
  /** Starts every pool at this nonce instead of recovering from the chain (for an unreachable RPC). */
  initialNonce?: number
  /** An existing store, to start a second runtime on it as after a restart. */
  store?: Store
}

export type TestRuntime = {
  store: Store
  worker: Worker
  /** Not started: tests call tick() themselves. */
  monitor: Monitor
  senders: SenderRegistry
  chain: RuntimeChain
  read: PublicClient
  testClient: TestClient
  /** Stores a request from ADDRESS_0 to ADDRESS_1 (unless overridden) and hands it to the worker. */
  submit(overrides?: Partial<NewRequest>): Transaction
}

/** Everything the worker needs, against an anvil node at `url`, with short test timings. */
export async function createRuntime(url: string, options: RuntimeOptions = {}): Promise<TestRuntime> {
  const base = withDefaults({ chain: anvil, pollIntervalMs: 50, gas: { maxFeePerGasWei: parseGwei('100') } })
  const config: EnabledChain = {
    ...base,
    ...options.chain,
    gas: { ...base.gas, ...options.chain?.gas },
    rpcUrls: [url],
  }
  const rpc = createChainRpc(config)
  const chain: RuntimeChain = {
    config,
    rpc: options.wrapSenders ? { ...rpc, senders: options.wrapSenders(rpc.senders) } : rpc,
  }

  const store = options.store ?? new Store(openDb(':memory:'))
  const chains = new Map([[ANVIL, chain]])
  const signers = buildSigners([KEY_0, KEY_1])
  const senders = new SenderRegistry()
  const logger = createLogger('silent')
  const worker = new Worker({ store, chains, signers, senders, logger }, { broadcastDelayMs: 0, ...options.worker })
  const monitor = new Monitor({ store, chain, signers, senders, worker, logger }, { broadcastDelayMs: 0 })

  // Start the way the service does, unless the RPC can't be reached to recover from.
  if (options.initialNonce === undefined) {
    await recover({ store, chains, signers, senders, worker, logger })
  } else {
    for (const address of signers.keys()) senders.add(ANVIL, address, new NoncePool(nonce(options.initialNonce)))
  }

  return {
    store,
    worker,
    monitor,
    senders,
    chain,
    read: rpc.read,
    testClient: createTestClient({ chain: anvil, mode: 'anvil', transport: http(url) }),
    submit(overrides = {}) {
      const { tx } = store.insertRequest({
        idempotencyKey: randomUUID(),
        requestHash: 'test',
        chainId: ANVIL,
        sender: ADDRESS_0,
        to: ADDRESS_1,
        value: 1n,
        data: '0x',
        ...overrides,
      })
      worker.enqueue(tx.id)
      return tx
    },
  }
}
