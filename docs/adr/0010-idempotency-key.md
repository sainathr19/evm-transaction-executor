# ADR 0010: Required Idempotency-Key

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

A client that retries a POST, for example after a network timeout, must not cause a second transaction. The service moves money, so a duplicate is a real loss. Duplicate protection works at two levels:

- **Client to service:** this ADR.
- **Service to chain:** each signed transaction is resent unchanged, and a nonce belongs to one request once a node has accepted it ([ADR 0003](0003-sqlite-save-before-broadcast.md), [ADR 0009](0009-nonce-pool.md)).

## Decision

- `POST /transactions` **requires** an `Idempotency-Key` header. A request without one gets `400 IDEMPOTENCY_KEY_MISSING`.
- **Format:** 1–255 printable ASCII characters. The 255 limit is our choice. UUIDs are recommended.
- **Scope:** unique across the whole service. There's no auth, so there's no notion of separate clients. With auth, keys would be unique per client.
- **Stored with the key:** a SHA-256 hash of the normalised request. Normalising means lowercasing `sender`, `to` and `data`, writing `value` as a canonical decimal, and including the chain id.

| Request | Response |
|---|---|
| New key | Insert the row, return `202` with the queued transaction |
| Same key, same body | `200` with the existing transaction in its current status, and an `Idempotent-Replayed: true` header |
| Same key, different body | `422 IDEMPOTENCY_KEY_REUSED` |

- **Two identical POSTs at the same moment:** the `UNIQUE` constraint on `idempotency_key` settles it. The second insert fails and is answered from the existing row.
- **A replay returns the request whatever its status,** including `failed`. To try again, a client uses a new key.
- **Status codes follow the IETF `Idempotency-Key` header draft:** `400` for a missing key where one is required, and `422` for a key reused with a different payload. The draft's `409` is for "a request with this key is still being processed", which can't happen here because POST only inserts a row and returns.
- **Keys never expire.**

## Alternatives considered

- **Optional key, as in Stripe and many other APIs.** Rejected. Without a key, a retried POST silently sends the money twice.
- **Detecting duplicates by request content.** Rejected. Sending the same transfer twice can be legitimate.
- **Expiring keys after a retention period.** Deferred. A late retry after expiry would create a duplicate. Production would pick a retention period, in the range of days to weeks.
- **`409` for a reused key.** Replaced by `422` to follow the draft.

## Consequences

- Every client must generate a key for each logical request. It's one line of code.
- Idempotency keys accumulate without limit. At this scale the rows are tiny.
- Internal gap-fill records have no key. The column is nullable, and SQLite allows any number of `NULL`s under a `UNIQUE` constraint.
