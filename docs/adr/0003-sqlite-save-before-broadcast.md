# ADR 0003: SQLite, saving each signed transaction before broadcast

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

In-flight transactions, idempotency keys and nonce ownership must survive a restart. The worst failure is a crash after a transaction is broadcast but before it's recorded. The service then loses track of a transaction that may still execute, and could send it again.

## Decision

- Persist to SQLite using better-sqlite3. It's a single file with no server, and its synchronous API is simple to reason about in a single process.
- Two tables. The initial columns may be refined during implementation.
  - **`transactions`:** id, idempotency key (unique) and request hash, chain id, sender, to, value, data, status, nonce, gas limit, current hash, receipt (JSON), failure (JSON), timestamps.
  - **`attempts`:** one row per signed version of a transaction (the original and each fee bump), with transaction id, hash, signed raw transaction, fee fields and broadcast time.
- **Every attempt is saved before it's broadcast.** A transaction's hash is known as soon as it's signed, and resending the same signed transaction is harmless: a node either accepts it or answers `already known`. So a crash mid-broadcast and an RPC call that times out recover the same way, by resending the saved transaction.
- **On startup:**
  - A request with at least one saved attempt may have been broadcast, so it goes to the monitor.
  - A `queued` request with no attempt goes back to the worker.
  - Nonce pools are rebuilt ([ADR 0009](0009-nonce-pool.md)).

## Alternatives considered

- **In memory.** Fastest to build, but a restart forgets in-flight transactions and idempotency keys. The transactions still execute; the service just stops tracking them.
- **Postgres or Redis.** Only needed with multiple instances ([ADR 0001](0001-single-instance-exclusive-keys.md)).

## Consequences

- The database file must be on persistent storage.
- **Treat the file as sensitive.** It holds signed transactions. One that was never broadcast, or was rejected, is still valid, and anyone who reads the file could broadcast it while its nonce is still free.
- A single writer fits the single-instance model.
