# Configuration v1

The current executable only validates configuration. It does not authenticate, read credential files, invoke models, execute solver code, or contact AoC.

```sh
npm ci --ignore-scripts
npm run check
node dist/main.js check-config examples/boc.config.json
```

A successful check means **structurally valid**, not ready for live solving. Both real providers are deliberately ineligible until the [credit feasibility gates](FEASIBILITY.md) are met.

## File format

See [`examples/boc.config.json`](../examples/boc.config.json). It contains synthetic allocations and placeholder model IDs, not recommended budgets or verified entitlements.

- `version`: exactly `1`; unknown properties are rejected throughout.
- `event.year`: integer from 2015 to 9999. This identifies accounting scope; it does not establish an event's dates or day count.
- `storageDir`: private runtime artifact directory.
- `aoc.sessionCookieFile`: path to an externally supplied cookie file.
- `creditPools`: one or more native-unit aggregate allocations.
- `subscriptions`: one or more explicitly identified provider subscriptions.

Paths are resolved **relative to the configuration file**, not the shell's working directory. No `~`, shell command, or `${...}` expansion is supported. Paths and IDs cannot contain control characters. Store real credentials in ignored `.secrets/` or outside the repository and runtime artifacts in ignored `var/` or outside the repository. Configuration validation does not verify directory permissions, Git exclusion, symlinks, or account ownership; the future startup preflight must do so.

Diagnostics intentionally do not echo input, unknown property names, JSON parser excerpts, or filesystem paths because an accidentally pasted secret could appear there.

## Credit pools and subscriptions

Each pool has a unique `id`, a `provider` (`github-copilot` or `openai-codex`), an explicitly named native `unit`, and `limits`. Each subscription has a unique `id`, provider, credential-file path, model ID, `creditPool` reference, and its own `limits`.

Several subscriptions may share a pool only when they use the same provider and the same accounting unit/policy. Each subscription consumes both its own allocation and that pool's allocation. This allows a shared event ceiling with separate subscription sublimits. A pool cannot span providers; the example's Copilot and Codex pools are intentionally separate and have no summed credit total. A unit name is an accounting label, not proof of provider credit semantics.

Every `limits` object contains:

- `event`: total permitted credits for that event and scope.
- `perPuzzle`: total permitted credits for each puzzle (both parts and all attempts together) in that event and scope.

`perPuzzle` must not exceed `event`. Zero means no admitted consumption, not unlimited. There are no implicit unlimited defaults. A subscription's allocation can exceed the shared pool's allocation: the smaller remaining allowance will control admission. Both limits must be satisfied, not selected as alternatives.

For a request, the ledger (`src/budget/ledger.ts`, see D012) atomically checks **four counters**: subscription/event, subscription/puzzle, pool/event, and pool/puzzle. It reserves durably before dispatch, reconciles authoritative debits, and retains uncertain reservations across restarts. Overhead needs an explicit event allocation before it can be enabled. The configuration parser itself enforces none of this, and no real provider can currently be admitted because no certified credit meter exists.

Credit amounts are **JSON strings**, not numbers. Accepted syntax is a non-negative ordinary decimal with at most 18 integer digits and 18 fractional digits; no exponent, sign, leading integer zeros, whitespace, or rounding. Internally values use `bigint` with a fixed 18-decimal scale. An adapter needing greater precision is unsupported until the representation is upgraded. Do not substitute estimated dollars, tokens, request counts, or usage percentages for native credits.

Duplicate IDs, duplicate credential paths (including normalized relative-path aliases), missing/incompatible pool references, and unused pools are rejected. Symlink aliases and multiple files representing the same billed principal still require account-aware validation before live use. Changing an ID or config file must not reset an existing ledger: the ledger refuses to open if its history references a subscription or pool that is missing, rebound to another pool, or has a different provider or unit. Changing `event.year` selects a different ledger directory. Lowering limits is allowed and applies to existing usage. Migration tooling does not exist yet.

## Exit codes

- `0`: help displayed, or configuration structurally valid (live adapters may still be blocked).
- `1`: configuration could not be read or validated.
- `2`: unsupported command or arguments.
