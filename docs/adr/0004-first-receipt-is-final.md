# ADR 0004: The first receipt is final

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

A chain reorganisation (reorg) can remove a transaction from the chain after its receipt has been seen. Handling that means tracking confirmations and re-checking receipts.

## Decision

When the monitor finds a receipt for any attempt, the request becomes `succeeded` or `reverted`, and that's final. There's no confirmation depth and no reorg handling. The chain config deliberately has no `confirmations` setting, because it would imply behaviour the service doesn't have.

## Alternatives considered

- **N confirmations per chain.** A reorged transaction would go back to `submitted` and be resent. This is about 20 minutes of extra work, since the monitor already checks receipts. Deferred.
- **Wait for the `finalized` block tag.** This is the strongest guarantee, but it takes about 13 minutes on Ethereum mainnet, and not every chain or RPC supports it well.

## Consequences

- A reorg can undo a transaction the service has already reported as final. Clients that need stronger guarantees must check the depth themselves.
- **Upgrade path:**
  - Add `confirmations` to the chain config.
  - The monitor keeps re-checking the receipt until it's that many blocks deep.
  - If the receipt disappears, the request moves back to `submitted`.
