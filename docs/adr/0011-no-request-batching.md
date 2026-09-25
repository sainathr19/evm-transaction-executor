# ADR 0011: No request batching

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

We considered batching several requests into one transaction through Multicall3. It would save the base cost of each transaction, and the service already manages pending transactions.

## Decision

The service doesn't batch. Each request is sent as its own transaction.

1. **Multicall3 changes the caller.** Target contracts see Multicall3 as `msg.sender`, not the sender's EOA.
   - Clients send arbitrary `data` and expect it to run as their sender.
   - Through Multicall3, an ERC-20 `transfer` would try to move Multicall3's tokens, and anything with access control would see the wrong caller.
   - Only plain ETH transfers and calls that never check the caller are safe to batch, and in general we can't tell which calls those are from the calldata.
2. **Per-request results aren't in the receipt.** A receipt has a status, logs and gas used, but no return data, and Multicall3 emits no events.
   - With `allowFailure: true`, the receipt says success even if some calls failed.
   - With `allowFailure: false`, one bad call reverts every request in the batch. Finding the bad call means tracing the transaction, which many RPC providers don't support, or re-simulating.
3. **Simulating requests one at a time doesn't prove the batch will work.** Two requests can each pass alone and still conflict together, for example when both spend the same balance. Simulating the whole batch (`eth_call` to `aggregate3`) helps before sending, but point 2 still applies on chain.
4. **It breaks the spec's model** of one request, one hash, one receipt.
   - Batched requests share a hash, gas cost and fee bumps.
   - One stuck batch blocks every request in it.
   - Collecting a batch adds latency to every request.
5. **Scope.** It would add many edge cases to this assignment.

## Alternatives considered

- **Multicall3 for all requests.** Rejected, for the reasons above.
- **Multicall3 only for plain ETH transfers.** Rejected. The savings are small for the added complexity.
- **EIP-7702 delegation.** This is the right way to batch arbitrary calls as the sender. The EOA delegates its code to a batch-executor contract, so every call in the batch runs with `msg.sender` set to the EOA itself. It's the path to take if batching is needed later.
- **Batching into a contract designed for it**, where the executor is meant to be the caller. That fits a specific product, not a general-purpose executor.

## Consequences

- Each request pays the full base cost of a transaction.
- `reverted` is final ([ADR 0002](0002-async-api-with-polling.md)). There's no re-batching after a failure.
