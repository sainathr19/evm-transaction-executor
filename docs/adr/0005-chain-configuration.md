# ADR 0005: Chains identified by chain id, one config file per chain

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

The spec requires RPC endpoints to come from environment variables. Each chain also needs its own settings, such as polling interval, gas and stuck detection, with room to add more later.

## Decision

- **The chain id is the only identifier.** The request's `network` field is the chain id, as an integer. The field keeps the spec's name so the API matches the spec's field list.
- **One typed file per chain** in `src/config/chains/`, keyed by the `id` of its viem chain definition. Shared defaults are merged with each chain's overrides. The filename is only for humans.

  ```ts
  // src/config/chains/base-sepolia.ts
  export default {
    chain: baseSepolia,               // chain.id (84532) is the key everywhere
    pollIntervalMs: 2_000,
    stuckAfterMs: 10_000,
    maxInFlightPerSender: 16,
    gas: {
      type: 'eip1559',                // or 'legacy'
      gasLimitBufferPercent: 20,
      baseFeeMultiplier: 2,
      minPriorityFeeWei: 0n,
      maxFeePerGasWei: parseGwei('5'), // example value; set per chain
      bumpPercent: 12.5,
      maxBumps: 5,
    },
  } satisfies ChainConfig
  ```

  The defaults and where they come from are listed in [ADR 0007](0007-gas-limit-and-fees.md) (gas), [ADR 0008](0008-retries-and-failure-handling.md) (retries) and [ADR 0012](0012-in-flight-cap.md) (in-flight cap).
- **RPC URLs** come from `RPC_URL_<chainId>`. A comma-separated list sets a fallback order. A chain is enabled when its variable is set.
- **Settings that aren't secret live in code**, where they're typed and reviewed. RPC URLs stay in env vars because they often contain API keys.
- **Startup checks fail fast:**
  - each enabled chain's RPC must return the configured `eth_chainId`;
  - an `RPC_URL_<id>` with no matching config file stops startup, because a typo in a chain id should be loud;
  - at least one chain must be enabled.
- There's no `confirmations` setting ([ADR 0004](0004-first-receipt-is-final.md)).

## Alternatives considered

- **Named networks** (`"network": "base-sepolia"`). Rejected. Names need a mapping to chain ids and config, while the chain id is already unique and every RPC can confirm it.
- **All settings in env vars** (`BASE_SEPOLIA_POLL_INTERVAL_MS=…`). Rejected. They're untyped strings and awkward for nested settings.
- **A JSON or YAML config file.** Rejected. It loses type checking, and viem's chain definitions are already TypeScript.

## Consequences

- Adding a chain means one small file and one env var.
- Changing a chain setting means a code change and a redeploy.
- Env var names are less readable (`RPC_URL_84532`). The chain's config file says which chain it is.
- If a chain's RPC is unreachable at startup, the service doesn't start, because the chain id check can't run. Revisit if that's a problem in practice.
