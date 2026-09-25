# ADR 0002: Asynchronous API with polling

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Clients submit a transaction and eventually need its receipt. Confirmation can take seconds or minutes. A stuck transaction is replaced by one with a higher fee, which has a new hash, so a transaction hash isn't a stable handle for a request.

## Decision

- `POST /transactions` validates the request, stores it as `queued` and immediately returns `202 { id, status }`.
- `GET /transactions/:id` returns the current status, the hash, every attempt, the receipt once there is one, and the error if the request failed.
- Clients track requests by **our id**, not by transaction hash.
- POST only runs checks that don't call an RPC: the body's shape, and whether the chain and sender are configured. Gas estimation, fee lookup and broadcasting happen in the background worker.

| Status | Meaning | Final |
|---|---|---|
| `queued` | Accepted, not broadcast yet | no |
| `submitted` | Broadcast; hash known | no |
| `succeeded` | Receipt shows success | yes |
| `reverted` | Mined, but execution reverted (gas was spent) | yes |
| `failed` | Never reached the chain | yes |

`reverted` and `failed` are separate on purpose. A reverted transaction cost gas and used up a nonce; a failed one did neither. `reverted` is final, and the service doesn't retry it.

## Alternatives considered

- **Block until the receipt arrives.** Rejected. Connections would stay open for minutes, proxies and client timeouts would cut them, and client retries would risk duplicates.
- **Block until broadcast and return the hash.** Rejected. RPC latency and failures would sit in the request path, and the hash can change later anyway.
- **Optional long-poll (`?waitMs=`).** Deferred. It's handy for scripts and demos and takes about 20 minutes to build. It can be added later without breaking clients.
- **Webhooks.** Rejected. They need delivery retries, payload signing, and protection against callback URLs that point at internal addresses.
- **Retrying reverted transactions.** Rejected. Here one request is one transaction, and retrying reruns the same call, which usually reverts again.

## Consequences

- Clients must poll.
- A transaction that would revert gets `202` on POST, and then shows as `failed` with `ESTIMATION_REVERTED` when polled. It doesn't get a 4xx.
- POST stays fast and unaffected by RPC problems. All chain-related failure handling lives in one place.
