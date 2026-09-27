# Decisions and feasibility notes

## D001 — Documentation-first bootstrap (completed)

The operator requested feasibility assessment, a context/bootstrap commit, removal of `init.md` (preserved in history), a push, and then a stop before application development. This bootstrap contains no application implementation.

The original instructions are in commit `f9dc772`. Requirements and clarifications now live in `REQUIREMENTS.md`; ongoing work is tracked in `PLAN.md`.

## D002 — Credits are the sole budget metric

The operator clarified that limits are configurable per puzzle and event, may differ by subscription, and must account for AI credits spent. BoC should use all available subscriptions effectively.

Use provider-specific credit pools with durable reservation and reconciliation. Do not equate credit units across providers without an explicit conversion. Every active limit must admit a call before dispatch. Prefer an integer or exact decimal representation once native units are established; do not use floating-point comparisons for hard limits.

A strict budget is an admission-control requirement, not a dashboard feature. A provider lacking a safe pre-request credit bound is ineligible for autonomous chargeable work until an enforceable mechanism exists. Unknown charge outcomes remain reserved. Shared usage outside BoC cannot be controlled by BoC alone.

## D003 — Subscription authentication is not billing integration

The installed Pi distribution inspected during feasibility assessment was version `0.87.1`. Its SDK supports embedded TypeScript sessions, custom tools/resources, events, and persistent sessions. Its installed provider implementation includes GitHub Copilot and OpenAI Codex OAuth modules.

This establishes an integration path, not verified access or accounting for the operator's subscriptions. ChatGPT Business/Codex must not be confused with separately billed OpenAI API access. Enterprise policies, model entitlement, token refresh, permitted third-party use, and credit observability need validation against current official documentation and actual authorized accounts.

Do not read existing personal credentials merely to investigate capabilities. Use explicitly configured private credential files for BoC, and require operator interaction for first-time authorization when needed.

## D004 — Originality is enforced at runtime

The operator's concern is especially newly released puzzles: BoC must not retrieve other people's solutions appearing minutes after release. Prevent solution retrieval through solver tools, subprocess networking, and access to unrelated local repositories. A system prompt alone is insufficient.

General-purpose libraries and algorithms remain permitted. Use a controlled dependency-acquisition path. Historical puzzle evaluation cannot establish absence of training-data exposure; do not claim otherwise.

## D005 — Private competition and private artifacts

The operator confirms that the private leaderboard allows AI and bots. No puzzle text or inputs will be published. Keep runtime data in ignored `var/` or outside the repository, including transcripts and raw HTTP responses. Keep credentials in ignored `.secrets/` or outside the repository. Use synthetic public fixtures.

The official [AoC About/FAQ](https://adventofcode.com/about) consulted during feasibility assessment discourages AI use, leaves private leaderboard expectations to their organizers, and asks that puzzle text and inputs not be redistributed. Recheck site policies before live operation; do not assume leaderboard permission exempts BoC from them.

## D006 — Trusted orchestrator, untrusted solver

The host orchestrator owns AoC access, provider credentials, durable budgets, scheduling, and answer submission. The solver receives only necessary puzzle content and isolated workspace access. Generated code must not inherit secrets or unrestricted network access.

Select and verify an OS-level isolation strategy during the feasibility spike. Node.js, a tool allowlist, and a working directory alone do not sandbox subprocesses. Unsupported environments should fail safely rather than quietly run untrusted code with host privileges.

## D007 — Persist enough context for autonomous continuation

Maintain `AGENTS.md`, requirements, decisions, and an actionable plan in Git. Each development increment should update verification status and next steps. Use small descriptive commits and push completed work. Runtime puzzle artifacts remain private even when development progress is committed.

## D008 — Offline-first foundation and provider eligibility

The 2026-09-27 [feasibility spike](FEASIBILITY.md) found that documented session/usage limits do not establish the required pre-dispatch ceiling. Pi's pinned Codex payload builder also does not serialize a generic output-token limit. Neither requested adapter is eligible for autonomous chargeable execution yet. Continue offline ledger, fake-transport, and solver-isolation development without weakening that gate. Live-account validation is a later dependency, not implied by OAuth support.

Pin Node.js to the 24 LTS line (tested/minimum 24.21.0) and the Pi package family to 0.87.1. Use TypeScript, native Node tests, Biome, a lockfile, and credential-free CI. Disable dependency lifecycle scripts. The initial CLI validates configuration only.

## D009 — Explicit native pools and exact decimal credits

Configuration v1 names subscriptions and provider-specific aggregate credit pools. Every subscription references exactly one compatible pool. Both have explicit event and per-puzzle limits; requests must eventually reserve against all four applicable counters. Separate provider units are never summed. Zero means no admitted consumption. Current limits are uniform across puzzles; per-puzzle overrides can be added through a versioned schema if needed.

Store amounts as JSON decimal strings and represent them internally as `bigint` at 18-decimal scale. Reject unsupported precision rather than rounding down. Credential paths are relative to the config file; no shell expansion or secret values are supported. Schema success is not account validation or an admission decision. See [configuration semantics](CONFIGURATION.md).

## D010 — Networkless container execution, not host tools

Select a separate non-root, resource-limited, networkless Linux container as the initial generated-code boundary. Keep the trusted orchestrator and all credentials outside it. A local Docker synthetic probe passed; no production executor or toolchain image has been built. The final image must contain Python/uv, Node.js, Go, and Rust even if those tools are already installed on the host. Require Docker/VM provisioning rather than silently falling back to host execution. Dependency acquisition remains separate and controlled. See [isolation requirements and evidence](FEASIBILITY.md#solver-isolation-decision).

## D011 — Admission at the provider-stream boundary

Enforce credit admission inside the provider `stream`/`streamSimple` implementation handed to Pi, not around `session.prompt()` or `agent.streamFunction`, because tool loops, compaction, summaries, and cache warming each issue their own dispatches. One reservation per dispatch attempt; no implicit retries; completion is withheld until authoritative settlement; uncertain outcomes stay reserved and fault the boundary. Model selection in Pi is not a security control, so the guard re-checks the exact model on every dispatch. The Pi SDK's concrete `ModelRuntime` requirement is an open integration issue (see FEASIBILITY.md); the facade cast is test-only.

## D012 — Journal-only durable credit ledger

The credit ledger for one event lives at `<storageDir>/ledger/<year>/` as an append-only JSON-lines journal (`journal.jsonl`) plus an exclusive lock file (`journal.lock`), both managed by the shared `src/state/journal.ts`. There is no snapshot/rename step: journals are small (one record per model call), and replay is simple to audit. Each record carries a contiguous sequence number, is validated before writing, and is fsynced before its effect is acknowledged. A reservation is therefore durable before the guard may dispatch. On open, a torn final line (never acknowledged) is truncated; any other malformed, out-of-order, or inconsistent record refuses to open.

Check-and-reserve runs inside one in-process serialized queue against all four counters, so concurrent workers cannot oversubscribe. Cross-process exclusion uses the lock file created with `O_EXCL`. A stale lock is broken only for a dead PID on the same host; anything else requires manual review.

Reservations leave the held state only through a recorded authoritative actual charge (`settle`). Unknown outcomes, missing receipts, aborts after admission, and restarts leave reservations held (annotated `uncertain` or reported as `orphaned`); nothing auto-releases them. An actual charge above the reservation is recorded truthfully and blocks all admission until an operator acknowledgement record. An I/O failure faults the ledger for the process lifetime and counts a possibly written reservation as held.

History must match configuration: a journal referencing a subscription or pool that is renamed, removed, rebound, or given a different provider/unit refuses to open, so edits cannot reset usage. Lowering limits is allowed. Explicit migration tooling is future work. `CreditMeter` (bound + authoritative receipt) is the provider-specific contract; no production meter exists, so provider eligibility gates are unchanged.

## D013 — Run state as a validated journal-backed state machine

Puzzle progress for one event is a second journal (`<storageDir>/runs/<year>/`, same discipline as D012) whose records are transitions of an explicit per-part state machine (`src/state/run-state.ts`). Each transition is validated before it is written and re-validated on replay, so an impossible history refuses to open. Identifiers: puzzles are `day-NN` (syntactic 1–31 bound, no calendar claim); parts are 1 and 2; attempts and submissions are 1-based per-part sequences (`day-01/part-2/attempt-003`).

Submission safety is enforced by the state machine rather than by callers: a `submission-started` record is written ahead of any future HTTP request; a restart turns `submitting` into `uncertain`, which only an explicit reconciliation (for example, a later puzzle-page check) can resolve; judged answers (including reconciled "not-correct") cannot be resubmitted for that part; integer answers contradicting too-high/too-low verdicts are rejected; and a server wait sets a conservative event-wide embargo. A `cooldown` verdict means the answer was not judged, so it may be resubmitted after the embargo. Part 2 cannot start before part 1 is solved. Interrupted attempts are recorded as `interrupted`, never silently resumed.

Markdown views (`INDEX.md`, `runs/<year>/SUMMARY.md`, per-puzzle `README.md`) are derived, regenerated with atomic replace (temp + fsync + rename + directory fsync), and never authoritative. Read-only inspection (`boc status`) takes no lock and modifies nothing; ledger mutations from the CLI require the lock (BoC stopped), and operator settlements must use an `operator:` receipt prefix for auditability. AoC's special final-day part 2 and exact AoC response mapping are left to the AoC transport milestone.

## D014 — Trusted AoC transport with conservative outcomes

Only the orchestrator constructs the AoC client (`src/aoc/client.ts`). The client is pinned to `https://adventofcode.com`. It reads the session cookie from an owner-only file, owned by the current user, into a closure, and sends an identifiable `User-Agent` with the required `aoc.contact`. Requests are serialized with minimum spacing, time out, never follow redirects, have bounded responses, and are never retried automatically. Errors are typed with fixed messages. Every failure after dispatch is marked as possibly having reached the server.

`AocService` caches statements and inputs through the private layout and records their hashes in the run state. It never silently re-downloads a recorded input. Submissions go through the D013 write-ahead record. A failure proven locally before dispatch records `not-sent`, and the answer can be resubmitted. Any other failure, or any unrecognized response, records `uncertain`. An uncertain submission is resolved only by reading the puzzle page, never by resubmitting. Parsed waits get a margin; implied but unparseable waits use conservative defaults.

Release timing is midnight EST (05:00 UTC), per the official FAQ; event length is not assumed. The request-rate interpretation for a racing bot is an open operator question (`AOC.md`). No live AoC request may happen before it is resolved and before milestone 6 validation.
