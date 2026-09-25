# ADR 0009: Nonce management with a nonce pool

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Each sender needs a nonce sequence without gaps or collisions, while many of its requests are in flight at once. The hard cases:

- **A nonce is handed out, but its transaction never reaches a node.** Unless the nonce is reused, every later nonce is stuck behind the gap.
- **A transaction looks dropped, but a node still has it.** Reusing its nonce for a different request can execute the original request twice (see below).
- **The service restarts while transactions are in flight.**

The design is adapted from a nonce pool used in an earlier project, written in Rust as a `BTreeSet` behind a mutex.

## Decision

### The pool

There's one pool per (chain, sender). It holds the nonces that are free to use: nonces that were rolled back, plus the *top*, which is the next nonce never used.

| Operation | Behaviour |
|---|---|
| `take()` | Removes and returns the smallest free nonce. If that empties the pool, adds `n + 1` as the new top. |
| `rollback(n)` | Puts `n` back, then merges: while `top - 1` is free, removes `top`. For example, {6, 7, 8} becomes {6}. After merging, any free nonce below the top is a real gap, meaning some nonce above it is held. |
| `reset(confirmed)` | Removes every nonce below the chain's confirmed count. If that empties the pool, adds `confirmed`. |

In TypeScript the pool is a sorted array, because it's tiny: the top plus a few gaps. It needs no mutex. None of the operations awaits, so Node runs each one without interruption. `reset` fetches the confirmed count first, then applies it without awaiting.

The worker takes the nonce as late as possible: after gas estimation and fee pricing, just before signing. Failures before that point never touch the pool.

### The invariant

> A nonce goes back to the pool only when no node can have the transaction: either it was never sent, or every send was clearly rejected. Once a send is accepted or goes unanswered, the nonce belongs to that request until the chain's confirmed nonce moves past it.

The nonce belongs to the **request**, not to one signed transaction. Fee bumps re-sign the same request at the same nonce, so every attempt shares it. That means rollback only ever applies to a request's first attempt. If a replacement is rejected, the earlier attempt is still valid and the nonce stays held.

**Why we don't roll back when a transaction looks dropped** (as the earlier project did):

1. Request A gets nonce 5 and is broadcast.
2. One node evicts it, or a load-balanced RPC returns `null` for it, but another node still has it.
3. We roll back 5 and retry A. Before A's retry runs, request B takes 5, and A's retry gets 8.
4. The original A transaction is then mined at nonce 5, and A's retry also executes at nonce 8. A has run twice.

Keeping the nonce and resending the same signed transaction is never worse, because resending a truly dropped transaction has the same effect as retrying it.

### Broadcast outcomes

Broadcasting is described in [ADR 0008](0008-retries-and-failure-handling.md): up to three sends of the same signed transaction, recording whether any went unanswered.

| Outcome | Nonce | Request |
|---|---|---|
| Accepted, or `already known` | Held | `submitted` |
| Any send unanswered | Held | `submitted`, and the monitor resolves it |
| Rejected | Rolled back, then the pool resyncs from the chain | `failed` (`INSUFFICIENT_FUNDS` or `BROADCAST_REJECTED`, with the node's message) |
| Signing or saving failed, so nothing was sent | Rolled back | `failed` (`INTERNAL_ERROR`) |

"Rejected" means every send was answered with a rejection. After a send that went unanswered, the result is `unknown` instead (ADR 0008): even `nonce too low` can then mean our own transaction has already been mined.

**Resync on rejection.** After a rejection the worker gives the nonce back, then calls `reset` with the sender's confirmed nonce count from the chain.
- If the chain hasn't used the nonce, it stays available for the next request.
- If another transaction already used it, `reset` drops it.

So a pool that is out of sync heals itself on the next rejection, and no decision about the nonce depends on the node's message. That matters because node software words rejections differently and uses one error code for all of them: anvil returns -32003 for every case. The message only picks the failure code. The request isn't retried; the client can resubmit, and the resubmitted request gets a usable nonce.

**Assumption: each RPC URL behaves like a single node.** A clear rejection then means that node didn't take the transaction. A load balancer that accepts a transaction on one backend and returns another backend's error breaks this: the request would be marked `failed` although it ran. Detecting that would take a receipt lookup after every rejection, which was left out to keep the worker simple.

### Releasing a held nonce

A held nonce never goes back to the pool. The request ends when the monitor sees one of two things:

- **A receipt for any of its attempts.** The request becomes `succeeded` or `reverted`.
- **The chain's confirmed nonce has moved past the request's nonce, with no receipt for any attempt, for at least `stuckAfterMs`.** The request becomes `failed` with `NONCE_TAKEN`, and the pool is `reset`.
  - The wait is there because a lagging or load-balanced RPC can report the new nonce before it can return our receipt. Every poll during the wait must see the nonce used; a poll that doesn't starts the wait again.
  - Failing too early is the costly mistake. The request would show `failed` although it ran, and a client that resubmits it would execute it twice. Waiting too long only delays the answer.
  - An earlier version failed the request on the second poll in a row that saw the nonce used. On a chain with 2 s blocks that's about one block, which a lagging node can exceed.
  - Under [ADR 0001](0001-single-instance-exclusive-keys.md), this only happens if something outside the service used the key.

### Gaps

A gap appears when a request is clearly rejected while the sender's later nonces are already in flight, or when the pool is rebuilt at startup. `take()` always hands out the lowest available nonce, so the sender's next request fills the gap, and the transactions waiting behind it can then be mined.

There is no gap filler. An earlier version of this design sent 0 ETH from the sender to itself to fill a gap that stayed open for `stuckAfterMs`. It was dropped to keep the service simple: it only helps when a sender gets no further requests, and when the gap came from insufficient funds, the filler is rejected for the same reason.

### Restart

The pool isn't saved. At startup it's rebuilt for each sender from SQLite and the chain:

- **held:** nonces of unfinished requests that have at least one saved attempt;
- **top:** the larger of the chain's pending count and the highest held nonce + 1;
- **pool:** every nonce from the chain's confirmed count up to the top that isn't held, plus the top, then merged as in `rollback`.

### Defaults

| Setting | Default | Basis |
|---|---|---|
| Wait before `NONCE_TAKEN` | `stuckAfterMs`: 60 s by default, set per chain | Our choice. It's already about 5 blocks on each chain, which gives a lagging RPC time to return the receipt. |

## Alternatives considered

- **One serial queue per sender with a local counter.** A nonce can only be returned if nothing after it has been handed out, and every broadcast has to go through one queue.
- **viem's `nonceManager`.** It only lives in memory. It can reset to the chain's count but can't take back a specific nonce, and after a restart it knows nothing about our saved attempts.
- **Asking the RPC for the pending nonce for every transaction.** Races when requests are concurrent, and load-balanced RPCs return inconsistent counts.
- **Rolling back when a transaction looks dropped.** Rejected, because it can execute a request twice (see above).
- **A gap filler** that sends 0 ETH from the sender to itself at a gap that stays open. Dropped (see Gaps above).

## Consequences

- Many transactions per sender can be built and broadcast at the same time.
- A nonce whose transaction was clearly rejected is reused by the sender's next request, which unblocks the later nonces.
- **Known limitation:** if a sender gets no further requests after a rejection, its later transactions wait in the mempool (geth drops such transactions after about 3 hours). Sending any request from that sender fills the gap.
- Parallel broadcasts can reach a node out of order. Nodes that reject `nonce too high` instead of holding the transaction make those requests fail, and clients resubmit them.
- A sender that runs out of funds keeps failing with `INSUFFICIENT_FUNDS` until it's topped up, and the logs show this.
- Correctness depends on the service being the only user of its keys ([ADR 0001](0001-single-instance-exclusive-keys.md)).
