# ADR 0001: Single instance, and the service is the only user of its keys

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

Nonce safety needs exactly one owner for each sender's nonce sequence. Nonces collide if two processes hand them out for the same sender, or if something outside the service sends from the same key.

## Decision

- The service runs as **one process**. It holds each sender's nonce pool in memory and rebuilds it from SQLite after a restart ([ADR 0009](0009-nonce-pool.md)).
- The service assumes it is **the only thing sending transactions from its keys**.

## Alternatives considered

- **Several instances sharing a lock per sender**, e.g. through Redis or Postgres advisory locks. Too much for this scope.
- **Nonces leased from a shared database.** Too much for this scope.
- **Senders split across instances**, each instance owning a separate set of keys. This needs no coordination, and it's the simplest way to scale out later.

## Consequences

- No horizontal scaling. A restart means brief downtime.
- If a key is used elsewhere, the affected request ends as `failed` with `NONCE_TAKEN`, and the pool is reset from the chain ([ADR 0009](0009-nonce-pool.md)).
- A single-writer store such as SQLite is enough ([ADR 0003](0003-sqlite-save-before-broadcast.md)).
