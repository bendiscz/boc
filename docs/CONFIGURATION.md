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
- `aoc.sessionCookieFile`: path to an externally supplied cookie file (owner-only permissions required when used).
- `aoc.contact` (optional for validation, required by the AoC client): operator contact placed in the `User-Agent`, e.g. an email address; printable ASCII without `;`, `(`, or `)`.
- `sandbox.image` (optional for validation, required for solving): the solver toolchain image, pinned as a local image ID (`sha256:...`) or `name@sha256:...`; see `SANDBOX.md`.
- `creditPools`: one or more native-unit aggregate allocations.
- `subscriptions`: one or more explicitly identified provider subscriptions.

Paths are resolved **relative to the configuration file**, not the shell's working directory. No `~`, shell command, or `${...}` expansion is supported. Paths and IDs cannot contain control characters. Store real credentials in ignored `.secrets/` or outside the repository and runtime artifacts in ignored `var/` or outside the repository. Configuration validation does not verify directory permissions, Git exclusion, symlinks, or account ownership; the future startup preflight must do so.

Diagnostics intentionally do not echo input, unknown property names, JSON parser excerpts, or filesystem paths because an accidentally pasted secret could appear there.

## Credit pools and subscriptions

Each pool has a unique `id`, a `provider` (`github-copilot`, `openai-codex`, or `anthropic`), an explicitly named native `unit`, and `limits`. Each subscription has a unique `id`, provider, credential-file path, model ID, `creditPool` reference, and its own `limits`.

Several subscriptions may share a pool only when they use the same provider and the same accounting unit/policy. Each subscription consumes both its own allocation and that pool's allocation. This allows a shared event ceiling with separate subscription sublimits. A pool cannot span providers; the example's Copilot and Codex pools are intentionally separate and have no summed credit total. A unit name is an accounting label, not proof of provider credit semantics.

Limits are **best effort** (D016). Each pool may also set:

- `overshootTolerance`: credits of unacknowledged excess over estimates tolerated before admission to that pool blocks. The default is 5 % of the event limit.
- `providerCap`: `"configured"` if a provider-side spending cap backs the pool, otherwise `"none"` (the default), in which case every run warns.

Each subscription needs an `estimate` block before it can run:

```json
"estimate": {
  "pricing": "github-2026-09",
  "rates": { "input": "300", "output": "1500", "cacheRead": "30", "cacheWrite": "375" },
  "safetyFactor": "1.5",
  "assumedMaxOutputTokens": 32000
}
```

- `rates` are native credits per million tokens, taken from the provider's current official price list for the subscription's model. The values above are illustrative only.
- `safetyFactor` (default `1.5`) pads every estimate.
- `assumedMaxOutputTokens` (default 32000) is the per-response output bound, capped at the model maximum. On providers that enforce an output limit (Copilot), it is also sent as the request's cap. On providers that do not (Codex), it sizes the reservation, and the guard's streaming cutoff stops a response that outgrows it.
  - It dominates each reservation.
  - A value that is too low truncates responses. Each truncated response costs a failed attempt, and the run log reports it as `N response(s) hit the output cap`.
  - Measured on AoC 2025 with `gpt-6-sol` and thinking off: the largest response was 920 output tokens and the median was about 30 (EVALUATION.md). The calibration configs use 8000. Raise it if the log reports cap hits.
- `pricing` labels the rate source and appears in the charge receipts.

Every `limits` object contains:

- `event`: total permitted credits for that event and scope.
- `perPuzzle`: total permitted credits for each puzzle (both parts and all attempts together) in that event and scope.

`perPuzzle` must not exceed `event`. Zero means no admitted consumption, not unlimited. There are no implicit unlimited defaults. A subscription's allocation can exceed the shared pool's allocation: the smaller remaining allowance will control admission. Both limits must be satisfied, not selected as alternatives.

For a request, the ledger (`src/budget/ledger.ts`, see D012) atomically checks **four counters**: subscription/event, subscription/puzzle, pool/event, and pool/puzzle. It reserves the padded estimate durably before dispatch, records the actual charge with its source, and retains uncertain reservations across restarts. Overhead needs an explicit event allocation before it can be enabled. The configuration parser itself enforces none of this. No provider adapter exists yet (D016 requires calibration first).

Credit amounts are **JSON strings**, not numbers. Accepted syntax is a non-negative ordinary decimal with at most 18 integer digits and 18 fractional digits; no exponent, sign, leading integer zeros, whitespace, or rounding. Internally values use `bigint` with a fixed 18-decimal scale. An adapter needing greater precision is unsupported until the representation is upgraded. Do not substitute estimated dollars, tokens, request counts, or usage percentages for native credits.

Duplicate IDs, duplicate credential paths (including normalized relative-path aliases), missing/incompatible pool references, and unused pools are rejected. Symlink aliases and multiple files representing the same billed principal still require account-aware validation before live use. Changing an ID or config file must not reset an existing ledger: the ledger refuses to open if its history references a subscription or pool that is missing, rebound to another pool, or has a different provider or unit. Changing `event.year` selects a different ledger directory. Lowering limits is allowed and applies to existing usage. Migration tooling does not exist yet.

## Commands and exit codes

- `boc check-config <config>` — structural validation only.
- `boc login <config> <subscription> [--browser]` — interactive provider authorization. The default is the device-code flow (Copilot and Codex). `--browser` selects Codex's browser sign-in with a `localhost:1455` callback, for workspaces without device codes. It writes only that subscription's `credentialFile` (`0600`) and never prints tokens.
- `boc calibration-report <config>` — per-subscription estimated versus charged credits by source, for comparison with the provider's billing.
- `boc run <config> [--days 1,2,5] [--tui] [--calibrate]` — `--calibrate` (requires `--days` with already released days) uses implemented but not yet calibrated adapters; solve past days or wait for releases. It refuses to start without an eligible provider adapter (currently GitHub Copilot and ChatGPT/Codex). Ctrl-C stops gracefully with exit code `130`, and rerunning resumes. `--tui` shows a live dashboard when stdout is a terminal; otherwise output is timestamped lines. Every event is also appended to the private `runs/<year>/events.log`.
- `boc status <config>` — read-only run state and credits; takes no lock, safe while BoC runs.
- `boc views <config>` — regenerate private Markdown summaries under `storageDir`.
- `boc ledger settle <config> <reservation-id> <amount> <operator:receipt-ref>` — record an authoritative charge for a held reservation (requires the ledger lock: stop BoC first).
- `boc ledger acknowledge <config> <reservation-id> <note>` — acknowledge a reviewed overrun so admission can resume.
- `boc ledger break-lock <config>` — remove a lock left by a dead process on this host.
- `boc submission not-judged <config> <day> <part> <submission#> <note>` — operator override for a submission AoC never judged, for example one rejected with an auth error and later reconciled as `not-correct`. It makes the answer submittable again by a new attempt; it never submits by itself. It requires the run-state lock, so stop BoC first.

The private artifact layout is documented in `src/state/layout.ts` and D013.

- `0`: success (for `check-config`, live adapters may still be blocked).
- `1`: configuration could not be read or validated, or the command failed (for example, the ledger is locked).
- `2`: unsupported command or arguments.
