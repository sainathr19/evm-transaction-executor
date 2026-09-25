# EVM Transaction Executor

An HTTP service that sends transactions to EVM chains from accounts whose keys it holds. It handles nonces, gas, retries and receipts, so clients only have to say what to send.

A client posts `{ chainId, sender, to, value, data }` and gets an id back immediately. The service then:

1. estimates gas and prices the fee,
2. assigns a nonce, signs and broadcasts,
3. watches the transaction until a receipt appears, resending it or raising its fee if it gets stuck.

The client polls with the id to get the result.

> **Status:** implemented as designed below. `npm run dev` runs the service; see [Development](#development). The decisions made along the way are in the ADRs.

## Development

Requires Node.js 24+ and [Foundry](https://book.getfoundry.sh/)'s `anvil`, which the integration tests start themselves.

```bash
npm install
```

Four separate checks, each of which must pass:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm test
```

`npm run format` fixes formatting. TypeScript is pinned to 6.0 because typescript-eslint's type-aware rules don't support TypeScript 7 yet.

To run the service, copy `.env.example` to `.env`, fill it in, then run:

```bash
npm run dev
```

To run the whole service against a local anvil node, including a 1,000-transfer stress test, see [Localnet testing and results](#localnet-testing-and-results).

### Project layout

```
src/
  main.ts        startup: load and check config, then start the service
  app.ts         HTTP API
  config/        env parsing, one file per chain, defaults, signer registry
  executor/      worker, monitor, nonce pool, gas pricing, broadcast, RPC clients
  store/         SQLite schema and queries
  logger.ts
  types.ts       types shared by the store and the executor
tests/
  unit/          pure logic
  integration/   against a real anvil node, started per test file
  helpers/
scripts/         end-to-end and stress runs against a local anvil node (not part of npm test)
```

## Stack

| Concern | Choice |
|---|---|
| Language and runtime | TypeScript 6.0 on Node.js 24 |
| HTTP | Express |
| Chain access and signing | viem |
| Persistence | SQLite (better-sqlite3) |
| Validation | zod |
| Logging | pino |
| Tests | vitest, with anvil as a local chain |
| Lint and format | ESLint with type-aware typescript-eslint rules; Prettier |

## How it works

```mermaid
flowchart LR
    Client -->|"POST, GET"| API
    API <--> Store[(SQLite)]
    API -->|new request| Worker
    Worker <-->|"take / rollback"| Pools["Nonce pools<br/>(chain, sender)"]
    Worker -->|save attempt| Store
    Worker -->|"estimate, fees, broadcast"| RPC[(RPC nodes)]
    Monitor["Monitor<br/>(one per chain)"] <--> Store
    Monitor -->|"receipts, resends, fee bumps"| RPC
    Monitor <--> Pools
```

| Component | Responsibility |
|---|---|
| **API** | Validates requests, enforces idempotency, stores each request as `queued`, and serves status. Never calls an RPC. |
| **Worker** | Takes each queued request through: estimate gas → price fees → take nonce → sign → save attempt → broadcast. Works on at most `maxInFlightPerSender` requests per sender at a time. |
| **Nonce pools** | One per (chain, sender). Hands out the smallest free nonce. Takes a nonce back only when no node can have the transaction. |
| **Monitor** | One loop per chain. Looks for receipts, resends or fee-bumps stuck transactions, and detects nonces used outside the service. |
| **Store** | SQLite tables `transactions` and `attempts`. The source of truth: nonce pools are rebuilt from it after a restart. |
| **Chain registry** | One config file per chain, plus `RPC_URL_<chainId>` env vars. Checked against each RPC at startup. |
| **Signer registry** | Maps each sender address to a viem `Account`, built from `SIGNER_PRIVATE_KEYS`. |

### Life of a request

1. **Accept.** `POST /transactions` checks the body, that the chain and sender are configured, and the idempotency key. It stores the request as `queued` and returns `202` with the queued transaction, including its id. No RPC calls happen here.
2. **Estimate and price.** Once the sender has a free slot ([ADR 0012][0012]), the worker estimates gas (plus a buffer) and prices the fee. If the estimate reverts, or the fee is above the chain's cap, the request fails here, before anything is signed.
3. **Take a nonce** from the sender's pool. This happens as late as possible, so earlier failures never touch the pool.
4. **Sign and save.** The signed transaction is saved as an *attempt* **before** it's broadcast.
5. **Broadcast.** If a node accepts it, or any send goes unanswered, the request becomes `submitted` and keeps its nonce. If every send is clearly rejected, no node has it: the nonce is released and the request fails ([ADR 0009][0009]).
6. **Watch.** On every poll the monitor checks receipts for all of the request's attempts, and replaces a stuck transaction with a higher-fee one at the same nonce. When a receipt appears, the request becomes `succeeded` or `reverted`.

### Statuses

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> submitted: accepted, or a send went unanswered
    queued --> failed: never reached the chain
    submitted --> succeeded: receipt with status success
    submitted --> reverted: receipt with status reverted
    submitted --> failed: nonce used by another transaction
```

| Status | Meaning | Final |
|---|---|---|
| `queued` | Accepted by the API, not broadcast yet. It may be waiting for a free slot for its sender. | no |
| `submitted` | Broadcast; hash known | no |
| `succeeded` | Mined, and execution succeeded | yes |
| `reverted` | Mined, but execution reverted. Gas was spent and the nonce used. The service doesn't retry it. | yes |
| `failed` | Never made it on chain, so no gas was spent. `error.code` says why. | yes |

## API

### Response envelope

Every JSON response has the same three fields, whatever the HTTP status. The HTTP status is set separately, so a client can read the body the same way every time.

```json
{ "status": "ok", "result": { "id": "…", "status": "queued", "…": "…" }, "error": null }
```

```json
{
  "status": "error",
  "result": null,
  "error": { "code": "UNSUPPORTED_CHAIN", "message": "chain 1 is not configured", "details": { "supported": [31337] } }
}
```

`error.details` is always present: `null`, or extra information for that code (the failed fields for `VALIDATION_ERROR`, the supported chain ids for `UNSUPPORTED_CHAIN`).

### `POST /transactions`

Requires an `Idempotency-Key` header: 1–255 printable ASCII characters. A UUID is recommended.

```json
{
  "chainId": 84532,
  "sender": "0x…",
  "to": "0x…",
  "value": "1000000000000000",
  "data": "0x"
}
```

| Field | Type | Notes |
|---|---|---|
| `chainId` | integer | Must be a configured chain. The spec calls this field `network`; see [ADR 0005][0005]. |
| `sender` | address | Must match one of the configured keys. |
| `to` | address | Required. Contract deployment isn't supported. |
| `value` | string | Wei, as a decimal string. JS numbers lose precision on large amounts. |
| `data` | hex string | Optional. Defaults to `0x`. |

| Case | HTTP status | Envelope |
|---|---|---|
| New key | `202` | `result`: the queued transaction |
| Same key, same body | `200`, plus an `Idempotent-Replayed: true` header | `result`: the existing transaction, in its current status |
| Same key, different body | `422` | `error.code`: `IDEMPOTENCY_KEY_REUSED` |
| Missing key | `400` | `error.code`: `IDEMPOTENCY_KEY_MISSING` |
| Invalid body, or not JSON | `400` | `error.code`: `VALIDATION_ERROR`; `error.details.issues` lists each field |
| Body over 256 kB | `413` | `error.code`: `PAYLOAD_TOO_LARGE` |
| Chain not configured | `400` | `error.code`: `UNSUPPORTED_CHAIN`; `error.details.supported` lists the chain ids |
| Sender not configured | `400` | `error.code`: `UNKNOWN_SENDER` |

A new request and a replay return the same transaction shape, so a client handles both the same way.

### `GET /transactions/:id`

Returns the current state of a request in `result` with `200`, or `404` with `error.code` `NOT_FOUND`. Track requests by this id, not by transaction hash, because a fee bump produces a new hash. Example `result`:

```json
{
  "id": "…",
  "status": "succeeded",
  "chainId": 84532,
  "sender": "0x…",
  "to": "0x…",
  "value": "1000000000000000",
  "data": "0x",
  "nonce": 42,
  "gasLimit": "25200",
  "hash": "0x…",
  "attempts": [
    {
      "hash": "0x…",
      "outcome": "accepted",
      "fees": { "type": "eip1559", "maxFeePerGas": "…", "maxPriorityFeePerGas": "…" },
      "createdAt": "…"
    }
  ],
  "receipt": {
    "transactionHash": "0x…",
    "blockNumber": "…",
    "blockHash": "0x…",
    "gasUsed": "21000",
    "effectiveGasPrice": "…",
    "status": "success"
  },
  "failure": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```

- **Every field is always present.** Anything the request doesn't have yet is `null`: `nonce`, `gasLimit` and `hash` until it's signed, `receipt` until it's mined.
- **`hash`** is the attempt that was mined. While the request is still `submitted`, it's the latest attempt.
- **`failure`** is set when `status` is `failed`: its `code` (see below), a one-line `message`, and the details for that code, such as `capWei` for `FEE_ABOVE_CAP`.
- **Signed transactions are never returned.** One whose nonce is still free could be broadcast by anyone who has it ([ADR 0003][0003]).

### `GET /health`

Returns `Online` as plain text, outside the JSON envelope, while the service is running. It doesn't check RPCs or senders. Stuck transactions and rejected broadcasts show up in the logs.

### Failure codes

| Code | Meaning |
|---|---|
| `ESTIMATION_REVERTED` | Gas estimation reverted. Includes the decoded revert reason. Nothing was broadcast. |
| `FEE_ABOVE_CAP` | The current base fee plus tip is above the chain's `maxFeePerGasWei`. |
| `RPC_UNAVAILABLE` | The RPC couldn't be reached for gas estimation or fee lookup, even after viem's retries. |
| `INSUFFICIENT_FUNDS` | The node rejected the transaction because the balance can't cover value plus the maximum gas cost. |
| `BROADCAST_REJECTED` | Any other rejection. Includes the node's message. |
| `NONCE_TAKEN` | A transaction from outside the service used this request's nonce. |
| `INTERNAL_ERROR` | Signing or saving failed before anything was sent. |

## Configuration

### Environment

```ini
# One per chain, named by chain id. A comma-separated list sets a fallback order.
RPC_URL_31337=http://127.0.0.1:8545
RPC_URL_84532=https://…

# Comma-separated private keys. Each key's address becomes a sender.
SIGNER_PRIVATE_KEYS=0x…,0x…
```

A chain is enabled when its `RPC_URL_<chainId>` is set. Every sender can be used on every enabled chain.

### Per-chain settings

Each chain has a typed file in `src/config/chains/`. Settings a file leaves out come from shared defaults.

```ts
// src/config/chains/base-sepolia.ts   (the filename is only for humans)
export default {
  chain: baseSepolia,               // viem chain definition; chain.id is the key everywhere
  pollIntervalMs: 2_000,
  stuckAfterMs: 10_000,
  maxInFlightPerSender: 16,
  gas: {
    type: 'eip1559',                // or 'legacy'
    gasLimitBufferPercent: 20,
    baseFeeMultiplier: 2,
    minPriorityFeeWei: 0n,
    maxFeePerGasWei: parseGwei('5'), // example value; set per chain
    bumpPercent: 12.5,
    maxBumps: 5,
  },
} satisfies ChainConfig
```

The ADRs list every default and where it comes from: [0007][0007] for gas, [0008][0008] for retries, [0009][0009] for nonces, [0012][0012] for the in-flight cap.

### Startup checks

The service refuses to start if:

- no chain or no key is configured;
- a key is malformed or duplicated;
- an `RPC_URL_<id>` is set but no config file exists for that chain id;
- a chain's RPC reports a different `eth_chainId` than its config, or can't be reached to check.

## Edge cases

| Scenario | What happens | ADR |
|---|---|---|
| Many concurrent requests from one sender | Up to `maxInFlightPerSender` (default 16) are processed at once, each with its own nonce from the sender's pool. The rest wait as `queued`. | [0009], [0012] |
| A sender's requests must be mined in order | Not guaranteed. Wait for the first to finish, or configure the chain with a cap of 1. | [0012] |
| Client retries a POST after a timeout | The same `Idempotency-Key` returns the original request; no second transaction | [0010] |
| Same key reused with a different body | `422` | [0010] |
| Transaction would revert | Caught by gas estimation: `failed` with `ESTIMATION_REVERTED`, no gas spent | [0007] |
| Fee spike above the chain's cap | `failed` with `FEE_ABOVE_CAP`. Replacement fees are capped too. | [0007] |
| RPC timeouts, rate limits, 5xx on reads | viem retries with backoff, then moves to the next RPC URL | [0008] |
| RPC down before broadcast | viem retries each read; if it's still down, `failed` with `RPC_UNAVAILABLE`. Nothing was signed. | [0008] |
| Broadcast unanswered: did the node get it? | Nonce kept and request `submitted`. The monitor finds the receipt or resends the same signed transaction. | [0008], [0009] |
| Resending a transaction the node already has | `already known` counts as success | [0008] |
| Broadcast clearly rejected | The request fails. Its nonce goes back to the pool, which resyncs from the chain, and is reused by the next request. | [0009] |
| Transaction stuck in the mempool | Replaced at the same nonce with higher fees, up to `maxBumps` and within the cap | [0008] |
| Transaction dropped from a mempool | Resent or fee-bumped at the same nonce. The nonce never goes back to the pool. | [0008], [0009] |
| Original mined after a replacement was sent | Receipts are checked for every attempt, so either outcome is recognised | [0008] |
| Rolled-back nonce with later nonces in flight | The sender's next request takes that nonce first, which unblocks the later ones | [0009] |
| Parallel broadcasts arrive out of order (`nonce too high`) | The request fails and its nonce goes back to the pool; the client resubmits | [0009] |
| Nonce used outside the service, before our broadcast | The request fails with `nonce too low`. The pool resyncs from the chain, so the next request gets a fresh nonce. | [0009] |
| Nonce used outside the service, after our broadcast | `failed` with `NONCE_TAKEN`; the pool is resynced from the chain | [0001], [0009] |
| Crash between signing and broadcasting | The signed transaction was saved first, so after restart the monitor resends it | [0003] |
| Restart with transactions in flight | Nonce pools are rebuilt from SQLite and the chain | [0009] |
| RPC URL pointing at the wrong chain | The service refuses to start | [0005] |
| Reorg removes a mined transaction | **Not handled.** The first receipt is final. | [0004] |

## Known limitations

- Runs as a single instance, and assumes nothing else sends from its keys ([0001]).
- No reorg handling ([0004]).
- One sender's requests aren't guaranteed to be mined in the order they were sent ([0012]).
- Two dependent transactions sent back to back (approve, then swap) can fail estimation, because the first isn't mined yet ([0007]).
- A sender's queue of waiting requests has no limit ([0012]).
- Node error messages differ between node implementations, so classifying broadcast errors is best effort. Unrecognised errors become `BROADCAST_REJECTED` ([0008]).
- A rejected broadcast fails the request rather than retrying it. The client resubmits with a new key ([0009]).
- If a request is rejected while the same sender's later transactions are in flight, those wait until the sender's next request fills the rejected nonce. With no further requests, they stay in the mempool ([0009]).
- Each RPC URL is assumed to behave like a single node. A load balancer that accepts a tx on one backend and returns another backend's error can leave a request marked `failed` although it ran ([0009]).
- Every configured RPC must be reachable at startup ([0005]).
- No contract deployment, no client-supplied gas or fees, and no batching ([0011]).
- On OP-stack L2s the L1 data fee isn't modelled, so senders need slightly more balance than gas × fee ([0007]).
- Keys come from env vars. Production should use a KMS or a secret manager ([0006]).
- Idempotency keys never expire ([0010]).

## Observability, security and testing

These were open questions in the design and were settled during implementation.

- **Observability:**
  - pino JSON logs, each carrying the `txId` and `chainId` it concerns, plus the `sender`, `nonce` and `hash` where relevant;
  - a line when a request is submitted, mined or fails, when a stuck transaction is replaced or resent, and when a broadcast is rejected;
  - `/health` answers `Online`. There are no metrics.
- **Security beyond keys:**
  - every request is validated with zod, and unknown fields are rejected;
  - request bodies are limited to 256 kB;
  - the service listens on `127.0.0.1` by default, since the API has no auth;
  - responses never include signed transactions, and the SQLite file is treated as sensitive ([0003]).
- **Testing:**
  - vitest unit tests for the pure logic: nonce pool, fee math, error classification, store, config and API;
  - integration tests against anvil, which reproduce stuck transactions (automatic mining off), dropped transactions (`anvil_dropTransaction`), fee spikes (`anvil_setNextBlockBaseFeePerGas`), nonces used outside the service, and restarts;
  - one end-to-end test that starts the real service and uses it over HTTP only.

## Localnet testing and results

Two scripts run the real service against a local anvil node and use it over HTTP only. They're test tools: separate from `src/`, and not part of `npm test`.

```bash
npm run e2e
```

```bash
npm run stress
```

**`npm run e2e`** runs each scenario from the [edge-case table](#edge-cases) once. It uses anvil's test methods to create each condition: mining turned off, a fee spike, a dropped transaction, transactions sent from outside the service, and a restart with a transaction in flight. Latest run: 21 of 21 checks passed.

**`npm run stress`** sends 1,000 transfers from 5 senders twice. The first phase is clean. The second goes through a proxy that injects faults into broadcasts:
- **5% clear rejections**, never forwarded. The request fails, and the client resubmits it with a new key.
- **5% lost replies**, forwarded to anvil and then answered with HTTP 502.
- **2% of signed transactions never delivered**, on any send, so the monitor has to replace them.

Each phase checks:
- **Exactly once:** every transfer has a unique value, so the recipient's balance must rise by exactly their sum.
- **Nonces:** each sender's mined nonces are contiguous and unique, and its on-chain nonce count rose by exactly that many.
- **Records:** every mined request is recorded under the hash that was mined, and the service log has no errors.

For a quicker run, use `TRANSFERS=100 npm run stress`.

Latest results, on a laptop against a local anvil node. They show how the service behaves, not a benchmark. The faulted phase varies between runs, since the faults are random.

| | Clean | Faults injected |
|---|---|---|
| Invariants | All passed | All passed |
| Duration | 8.0 s (125 transfers/s) | 45.8 s (22 transfers/s) |
| Accepted → mined, p50 / p95 | 3.9 s / 6.9 s | 8.4 s / 39.1 s |
| Faults injected | None | 36 rejections, 55 lost replies, 75 blackholed sends |
| Recovery | None | 30 requests resubmitted; 62 needed a replacement |

- **The clean phase's latency is queueing.** All 1,000 requests arrive at once, but at most 80 are in flight (5 senders × a cap of 16). A slot only frees when the monitor sees the receipt, on its 500 ms poll ([0012]).
- **The faulted phase's long tail comes from blackholed transactions.** Each one holds up its sender until the monitor replaces it after `stuckAfterMs`, which is 5 s on anvil ([0008]).
- **Lost replies never caused a double send.** Every one of them was mined, and the exactly-once check still passed ([0008], [0009]).

## Architecture decision records

Each significant decision is recorded in [`docs/adr/`](docs/adr/) with its context, the alternatives considered, and its consequences.

| ADR | Decision |
|---|---|
| [0001] | Single instance; the service is the only user of its keys |
| [0002] | Asynchronous API: `202` and polling |
| [0003] | SQLite; save each signed transaction before broadcasting it |
| [0004] | The first receipt is final |
| [0005] | Chains identified by chain id; one config file per chain |
| [0006] | Private keys from env vars now; KMS or a secret manager in production |
| [0007] | Gas limit and fee pricing |
| [0008] | Retries and failure handling |
| [0009] | Nonce management with a nonce pool |
| [0010] | Required `Idempotency-Key` |
| [0011] | No request batching |
| [0012] | Per-sender in-flight cap; no ordering guarantee |

[0001]: docs/adr/0001-single-instance-exclusive-keys.md
[0002]: docs/adr/0002-async-api-with-polling.md
[0003]: docs/adr/0003-sqlite-save-before-broadcast.md
[0004]: docs/adr/0004-first-receipt-is-final.md
[0005]: docs/adr/0005-chain-configuration.md
[0006]: docs/adr/0006-private-key-handling.md
[0007]: docs/adr/0007-gas-limit-and-fees.md
[0008]: docs/adr/0008-retries-and-failure-handling.md
[0009]: docs/adr/0009-nonce-pool.md
[0010]: docs/adr/0010-idempotency-key.md
[0011]: docs/adr/0011-no-request-batching.md
[0012]: docs/adr/0012-in-flight-cap.md
