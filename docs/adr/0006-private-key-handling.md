# ADR 0006: Private keys from environment variables; KMS or a secret manager in production

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

The spec provides private keys through environment variables. The keys are the most sensitive thing the service handles: anyone who gets one controls that account's funds on every chain.

## Decision (this assignment)

- **Where keys come from:** `SIGNER_PRIVATE_KEYS` holds a comma-separated list of keys. At startup each key becomes a viem account, and its address is how clients name the sender. Every sender can be used on every enabled chain.
- **Startup checks:** a malformed or duplicate key, or no keys at all, stops startup.
- **Keeping keys out of reach:**
  - The keys are read once and then deleted from `process.env`. Only the account objects stay in memory.
  - The logger redacts anything that looks like a key, and errors never include key material.
  - The API and `/health` only ever show addresses.
- **Files:** `.env` is gitignored, and `.env.example` contains placeholders only. anvil's well-known dev keys are fine locally and must never be used on a real network.
- **Signer registry:** the rest of the code only sees a mapping from address to viem `Account`. viem's `toAccount` lets any signer present that interface, so moving to production only changes how the registry is built.

## Production approach (documented, not built)

1. **Preferred: KMS or HSM signing.** AWS KMS and Google Cloud KMS both support secp256k1 keys. Wrapped with `toAccount`, the key never leaves the hardware.
2. **Otherwise, a secret manager** such as HashiCorp Vault or AWS Secrets Manager that injects keys at runtime, or an encrypted JSON keystore whose password comes from a secret manager.
3. **Also:** spending limits per key, signing in a separate process, and a key rotation procedure.

## Alternatives considered

- **An encrypted keystore now.** Rejected. With its password also in an env var, it adds handling without adding protection.
- **KMS now.** Out of scope, because it needs cloud accounts. The signer registry keeps the option open.

## Consequences

- Keys live in process memory and in the environment of whoever starts the process.
- Moving to KMS or a secret manager only changes how the signer registry is built.
