# ADR 0008: Retries and failure handling

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Failures happen at different points, and each needs a different response. The dangerous case is when we can't tell whether a transaction reached a node. Retrying blindly can send it twice, and giving up can lose track of a transaction that later executes.

## Decision

Retries happen at four layers.

### 1. Every RPC read

- viem's HTTP transport retries timeouts, rate limits and server errors with exponential backoff. We keep viem's defaults: 3 retries, a 150 ms base delay and a 10 s timeout.
- When a chain lists several RPC URLs, viem's `fallback` transport moves to the next URL when one keeps failing.

### 2. Before broadcast (gas estimate, fee lookup)

- **RPC still unreachable after layer 1:** the request stays `queued`, and the worker retries with backoff (up to 30 s between tries) for up to 2 minutes. It then marks the request `failed` with `RPC_UNAVAILABLE`. Nothing has been signed, so giving up is safe.
- **Estimate reverts, or fee is above the cap:** the request fails immediately ([ADR 0007](0007-gas-limit-and-fees.md)). Retrying would get the same answer.

### 3. The broadcast

- Broadcasts use a separate viem client with automatic retries and fallback turned off. Our own loop sends the same signed transaction up to 3 times, moving to the next URL each time, and records whether any send got no answer.
- **Why our own loop:** viem's automatic retries hide what happened to earlier sends.
  - A first send can reach a node and lose its reply. The retry then gets an error that looks like a rejection.
  - On a fast chain, the first send can even be mined before the retry. The retry then gets `nonce too low`, because geth only answers `already known` while the transaction is still in its mempool.
  - Treating that as a rejection would execute the request twice.
- **Classifying the result:**
  - Accepted, or `already known`: the request becomes `submitted`.
  - Any send unanswered: the request becomes `submitted`, keeps its nonce, and the monitor resolves it.
  - Every send clearly rejected: handled as described in [ADR 0009](0009-nonce-pool.md). The nonce is rolled back or reset, and the request is retried or marked `failed`.
- **Matching node errors:** viem maps common node messages to typed errors, such as `InsufficientFundsError`, `NonceTooLowError` and `NonceTooHighError`. We match `already known`, and variants like `known transaction`, ourselves. Node software words errors differently, so this is best effort. An unrecognised error becomes `BROADCAST_REJECTED` and keeps the node's message.

### 4. After broadcast: the monitor

The monitor runs one loop per chain, every `pollIntervalMs`. For each `submitted` request:

1. **Look for a receipt for every attempt**, not just the latest, because the original can be mined after a replacement was sent. If one exists, the request becomes `succeeded` or `reverted`.
2. **If there's no receipt and the latest attempt is older than `stuckAfterMs`:**
   - If bumps remain and the new fee stays under the cap, sign a replacement with the same nonce. Both fee fields go up by `bumpPercent` (rounded up), or to the current market fee if that's higher. Save the replacement, then broadcast it.
   - Otherwise, resend the latest attempt unchanged. This also covers a transaction that was dropped from a mempool.
   - If a node rejects a replacement, for example with `replacement transaction underpriced`, nothing changes. The earlier attempt is still valid, the bump counts toward `maxBumps`, and the next bump uses a higher fee.
3. **Check whether another transaction has taken the nonce** ([ADR 0009](0009-nonce-pool.md)).

**A broadcast transaction is never marked `failed` because time ran out.** It can still be mined, so it stays `submitted` until a receipt appears or another transaction uses its nonce. When the bumps run out, the service stops paying more but keeps watching, and `/health` and the logs show the transaction as stuck.

Two choices within the monitor:

- **One timer handles both stuck and dropped transactions.** A dropped transaction gets a small fee bump rather than a plain resend. That's usually what you want, because nodes drop the lowest-paying transactions first.
- **Stuck is measured in time, not blocks.** With automatic mining off, anvil produces no blocks, so a block-count rule couldn't be tested. And on a chain that stops producing blocks, raising fees doesn't help.

### Defaults

| Setting | Default | Basis |
|---|---|---|
| RPC retries | 3 retries, backoff from 150 ms, 10 s timeout | viem's defaults, kept |
| Pre-broadcast retry window | 2 minutes, backoff up to 30 s | Our choice |
| Sends per broadcast | 3 | Our choice |
| `stuckAfterMs` (per chain) | About 5 blocks' worth: 60 s on Ethereum mainnet, 10 s on Base | Our choice |
| `bumpPercent` (per chain) | 12.5% | geth rejects a replacement unless both fee fields rise by at least 10%. That's the default of its `--txpool.pricebump` setting, and a node can require more. The extra 2.5 points are our margin for rounding and for nodes that require more. |
| `maxBumps` (per chain) | 5 | Our choice. Five bumps compound to about 1.8× the first fee, or more if the market fee rose faster. The fee cap limits it either way. |

## Alternatives considered

- **Mark a `submitted` transaction `failed` after a timeout.** Rejected. It can still be mined, and a client that then retries would execute the request twice.
- **Detect dropped transactions with `eth_getTransactionByHash`.** Rejected. Each node has its own mempool, and load-balanced RPCs give inconsistent answers. Resending the same signed transaction is harmless, so we don't need to know.
- **Measure stuck in blocks.** Rejected, for the reasons above.
- **Let viem retry broadcasts.** Rejected, for the reasons above.

## Consequences

- A transaction whose bumps have run out and that still isn't mined stays `submitted` indefinitely. It needs attention from whoever runs the service, and `/health` shows it.
- Clients only see `failed` for requests that never reached the chain, or whose nonce was taken by another transaction.
- Classifying broadcast errors depends on node error messages, which differ between node implementations.
