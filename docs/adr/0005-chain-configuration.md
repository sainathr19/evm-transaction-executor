# ADR 0005: Chains identified by chain id, configured from env vars

- **Status:** Accepted
- **Date:** 2026-09-25, revised 2026-09-26

## Context

The spec requires RPC endpoints to come from environment variables. Adding a network should need nothing more than that. A few settings also differ between chains, mainly because block times range from about 250 ms to 12 s, and fee levels differ by orders of magnitude.

## Decision

- **The chain id is the only identifier.** Requests carry it in the spec's `network` field, as an integer (`"network": 84532`). The field was briefly named `chainId`, which says exactly what it holds, but it was renamed back so the API matches the spec's request fields. Inside the service it's still called `chainId`.
- **`RPC_URL_<chainId>` alone enables a chain.** A comma-separated list sets a fallback order. Adding a chain needs no code change.
- **Three optional settings per chain**, for the values that really differ between chains:

  | Variable | Default | Why it varies |
  |---|---|---|
  | `POLL_INTERVAL_MS_<chainId>` | 2000 | How often the monitor looks for receipts; should follow the block time |
  | `STUCK_AFTER_MS_<chainId>` | 60000 | About 5 blocks' worth ([ADR 0008](0008-retries-and-failure-handling.md)) |
  | `MAX_FEE_GWEI_<chainId>` | 500 | The fee cap; fee levels differ by orders of magnitude ([ADR 0007](0007-gas-limit-and-fees.md)) |

- **Every other setting is one default in code**, the same on every chain (`src/config/defaults.ts`): the gas limit buffer, base fee multiplier and minimum tip ([ADR 0007](0007-gas-limit-and-fees.md)), fee bumps ([ADR 0008](0008-retries-and-failure-handling.md)) and the in-flight cap ([ADR 0012](0012-in-flight-cap.md)).
- **The fee type isn't configured.** The latest block decides: a base fee means EIP-1559, none means legacy ([ADR 0007](0007-gas-limit-and-fees.md)).
- **No viem chain definitions.** RPC clients are created without one. The service only uses standard JSON-RPC, and signing takes the chain id from the request.
- **Startup checks fail fast:**
  - each of a chain's RPC URLs must return its `eth_chainId`, which also catches a mistyped chain id in `RPC_URL_<chainId>`;
  - a per-chain setting for a chain with no `RPC_URL_<chainId>` stops startup, since it's most likely a typo in the chain id;
  - a malformed value stops startup;
  - at least one chain must be enabled.
- The startup log lists each chain's settings in effect, without its RPC URLs, which often contain API keys.
- There's no `confirmations` setting ([ADR 0004](0004-first-receipt-is-final.md)).

## Alternatives considered

- **A typed file per chain in `src/config/chains/`.** This was the first version: an `RPC_URL_<chainId>` without a matching file stopped startup. It gave typed, reviewed settings, but adding a network took a code change and a redeploy, while the spec expects networks to come from env vars. Replaced.
- **Keeping the files as optional overrides.** Rejected. It means two places to look for a chain's settings, and a rule for which one wins.
- **Every setting per chain in env vars** (`GAS_LIMIT_BUFFER_PERCENT_84532=…`). Rejected. Most settings don't need to differ between chains, and a dozen variables per chain are hard to review. Only the three that do differ are exposed.
- **Named networks** (`"network": "base-sepolia"`). Rejected. Names need a mapping to chain ids, while the chain id is already unique and every RPC can confirm it.
- **A JSON or YAML config file.** Rejected. It's one more file to deploy, and it doesn't fit the spec's env-var setup.

## Consequences

- Adding a chain means one env var.
- A per-chain value for any other setting, such as the in-flight cap, means a code change.
- Only standard EVM transactions are signed: EIP-1559 or legacy. Chains that need their own transaction format, such as zkSync's EIP-712 transactions or Celo's fee currencies, aren't supported.
- Env var names are less readable (`RPC_URL_84532`) than chain names.
- If a chain's RPC is unreachable at startup, the service doesn't start, because the chain id check can't run. Revisit if that's a problem in practice.
