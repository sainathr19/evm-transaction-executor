# ADR 0012: Per-sender in-flight cap, no ordering guarantee

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

The nonce pool ([ADR 0009](0009-nonce-pool.md)) lets many transactions from one sender be built and broadcast at once. Without a limit:

- any number of later transactions can pile up behind a stuck one, all waiting on its nonce;
- nodes only keep a limited number of pending transactions per account. geth, for example, guarantees 16 slots per account for transactions ready to be mined (`--txpool.accountslots`). When its pool fills up, an account's transactions beyond that are the first to be evicted.

Clients might also expect one sender's requests to be mined in the order they were sent.

## Decision

### Cap

- Each (chain, sender) can have at most `maxInFlightPerSender` requests in progress. The default is 16, and it's set per chain.
- A request takes a slot when the worker starts on it, before gas estimation. It keeps the slot until it reaches a final status (`succeeded`, `reverted` or `failed`). This includes time spent on broadcast retries (`nonce too high`, `nonce too low`).
- Requests over the cap stay `queued` and are picked up as slots free up. POST isn't affected and still returns `202`.
- The gap filler doesn't take a slot. The transactions stuck behind a gap may be holding every slot, and only the filler can unblock them.

### Ordering

- The worker picks up a sender's queued requests oldest first, but **the order they're mined in isn't guaranteed**:
  - requests are processed at the same time, and gas estimation takes different amounts of time;
  - a rolled-back nonce goes to whichever request takes a nonce next, which can be a later request.
- A client that needs one transaction mined before another, such as approve and then swap, must wait for the first to reach a final status before submitting the second.
- Setting `maxInFlightPerSender` to 1 gives strict arrival order. One request runs from estimation to a final status before the next one starts.

### Defaults

| Setting | Default | Basis |
|---|---|---|
| `maxInFlightPerSender` (per chain) | 16 | Matches geth's default of 16 guaranteed slots per account (`--txpool.accountslots`). Other nodes and L2 sequencers have their own limits; matching geth is our choice. |

## Alternatives considered

- **No cap.** Rejected. Unlimited transactions could pile up behind a stuck one, and some might be evicted from the mempool.
- **A cap of 1 on every chain.** Rejected as the default, because it allows only about one transaction per block per sender. It's still available through config when strict order matters more than throughput.
- **Guaranteed arrival order with a cap above 1.** Rejected. Nonce assignment and broadcasting would have to go through one serial step, and a failed request would hold up every request after it. Order isn't a requirement.
- **Rejecting requests over the cap with `429`.** Rejected. Clients would need their own retry logic, and queueing is simpler for them.

## Consequences

- At most 16 of a sender's transactions wait behind a stuck one.
- Throughput per sender is limited by the cap. More throughput comes from more senders.
- If every in-flight transaction of a sender is stuck with no fee bumps left, the sender takes on no new work until they're mined. The logs show this.
- A sender's queue of waiting requests has no limit. If a flood of requests becomes a problem, the next step is a per-sender queue limit that returns `429`.
