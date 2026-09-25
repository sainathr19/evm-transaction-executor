# ADR 0007: Gas limit and fee pricing

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Fees change every block. A gas estimate can be wrong by the time the transaction is mined. A fee spike could make the service overpay badly.

## Decision

### When

The worker computes gas and fees just before signing, never when the POST arrives, because fee estimates go stale within seconds. We call viem's estimation functions directly rather than `prepareTransactionRequest`, so the buffer, multiplier and cap live in our code, in one place.

### Gas limit

`gasLimit = estimateGas × (100 + gasLimitBufferPercent) / 100`

The default buffer of 20% is **our practical choice. There's no standard value.**

- **Too little costs far more than too much.**
  - If the limit is too low, the transaction runs out of gas. It's still mined, but it reverts and the gas is spent.
  - A limit that's too high costs nothing extra, because unused gas isn't charged. The sender just needs a larger balance up front, and a very large limit is harder to fit into a nearly full block.
- **What it covers:** the most common reason a transaction uses more gas than estimated is a storage write that becomes a first-time write (zero to non-zero) between the estimate and inclusion. That costs about 17,000 more gas: 20,000 instead of 2,900. 20% absorbs one such change on a call that uses about 85,000 gas or more.
- **What it doesn't cover:** that same change on smaller calls, and contracts whose gas use grows with state, such as loops over growing arrays.
- **Tuning:** compare `gasUsed` on stored receipts with the limit we set.

If the estimate reverts, the request becomes `failed` with `ESTIMATION_REVERTED` and the node's message, which carries the revert reason when the node gives one. Nothing is broadcast.

### Fee type

The latest block decides. If it has a base fee, the chain uses EIP-1559 fees; if not, legacy fees. Nothing is configured, so a new chain is priced correctly with no setup ([ADR 0005](0005-chain-configuration.md)). An earlier version set the type in each chain's config file; that was dropped with the files.

### Fees: EIP-1559

- `tip = max(eth_maxPriorityFeePerGas, minPriorityFeeWei)`
- `maxFeePerGas = min(baseFee × baseFeeMultiplier + tip, maxFeePerGasWei)`

The default `baseFeeMultiplier` is 2:

- EIP-1559 lets the base fee rise by at most 12.5% per block, so 2× stays valid through about six full blocks in a row. The 12.5% rule is part of the protocol; allowing about six blocks is our choice.
- The actual charge is only the base fee plus the tip, so the extra headroom costs nothing unless fees really do rise.
- viem's default multiplier is 1.2×, which lasts about one full block.

### Fees: legacy

Chains without a base fee use `eth_gasPrice` as the gas price.

### Fee cap

Every chain has a cap, `maxFeePerGasWei`. It defaults to 500 gwei and is set per chain with `MAX_FEE_GWEI_<chainId>`.

500 gwei is our own choice, not a standard. No single value fits every chain, because fee levels differ by orders of magnitude between Ethereum mainnet and L2s. 500 gwei rarely blocks mainnet, even in a spike. On L2s, where fees are fractions of a gwei, it only catches values that are clearly wrong, such as a faulty RPC suggesting a huge tip. A deployment should set a tighter cap for each chain.

- If `baseFee + tip`, or the legacy `gasPrice`, is already above the cap, the transaction couldn't be mined right now. The request becomes `failed` with `FEE_ABOVE_CAP`. It isn't kept waiting for fees to drop; the client decides whether to retry.
- Otherwise `maxFeePerGas` is clamped to the cap, as shown above.
- Fee bumps ([ADR 0008](0008-retries-and-failure-handling.md)) are capped the same way.

### Arithmetic

All wei math uses `bigint`. Percentages and multipliers are converted to basis points, and results are rounded up where a minimum matters, as with fee bumps.

### Defaults

| Setting | Default | Basis |
|---|---|---|
| `gasLimitBufferPercent` | 20 | Our practical choice (see above) |
| `baseFeeMultiplier` | 2 | The 12.5%-per-block limit is protocol; about six blocks of headroom is our choice |
| `maxFeePerGasWei` | 500 gwei; `MAX_FEE_GWEI_<chainId>` sets it per chain | Our own choice (see Fee cap) |
| `minPriorityFeeWei` | 0 | No minimum by default. It exists for chains where the node suggests a zero tip. |

## Alternatives considered

- **viem's defaults via `prepareTransactionRequest`.** Rejected. The 1.2× base fee headroom gets transactions stuck when fees rise, and the logic would be hidden inside the library.
- **A fixed gas price.** Rejected. It either overpays or gets stuck.
- **A third-party gas oracle.** Rejected. It's an external dependency we don't need; the node's own data is enough.
- **Detecting EIP-1559 support automatically.** Rejected in favour of explicit config.
- **Waiting in the queue while fees are above the cap.** Rejected for now, because it hides latency from the client.
- **Client-supplied gas or fees.** Not part of the spec's request, but could be added later.

## Consequences and what's not handled

- A transaction that would only succeed after some later state change is rejected at estimation.
- Two dependent transactions sent back to back (approve, then swap) can fail estimation, because the first isn't mined yet. One sender's requests also aren't guaranteed to be mined in order ([ADR 0012](0012-in-flight-cap.md)), so a client should wait for the first to finish before sending the second.
- On OP-stack L2s the L1 data fee is charged separately. The node deducts it automatically, but the sender needs slightly more balance than gas × fee.
