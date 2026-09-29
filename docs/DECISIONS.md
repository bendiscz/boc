# Decisions and feasibility notes

## D001 — Documentation-first bootstrap (completed)

The operator requested feasibility assessment, a context/bootstrap commit, removal of `init.md` (preserved in history), a push, and then a stop before application development. This bootstrap contains no application implementation.

The original instructions are in commit `f9dc772`. Requirements and clarifications now live in `REQUIREMENTS.md`; ongoing work is tracked in `PLAN.md`.

## D002 — Credits are the sole budget metric (hard-ceiling part superseded by D016)

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

Select a separate non-root, resource-limited, networkless Linux container as the initial generated-code boundary. Keep the trusted orchestrator and all credentials outside it. A local Docker synthetic probe passed. The production executor (`src/sandbox/executor.ts`) and toolchain image (`sandbox/Dockerfile`) now exist; see `SANDBOX.md`. Each command runs in a fresh container with a read-only workspace mount and a tmpfs scratch area. Libraries are baked in at image build time, which is the controlled dependency-acquisition path. The final image must contain Python/uv, Node.js, Go, and Rust even if those tools are already installed on the host. Require Docker/VM provisioning rather than silently falling back to host execution. Dependency acquisition remains separate and controlled. See [isolation requirements and evidence](FEASIBILITY.md#solver-isolation-decision).

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

Only the orchestrator constructs the AoC client (`src/aoc/client.ts`). The client is pinned to `https://adventofcode.com`. It reads the session cookie from an owner-only file, owned by the current user, into a closure, and sends an identifiable `User-Agent` with the required `aoc.contact`. Requests are serialized without artificial spacing: per the operator, fetching a new puzzle, its input, and answering right after release is ordinary user behaviour. Needless traffic is prevented structurally, with no polling while waiting for a release, cached downloads, and server-reported answer waits. A sliding-window cap (default 10 requests per 10 minutes) acts only as a brake against bugs. Requests time out, never follow redirects, have bounded responses, and are never retried automatically. Errors are typed with fixed messages. Every failure after dispatch is marked as possibly having reached the server.

`AocService` caches statements and inputs through the private layout and records their hashes in the run state. It never silently re-downloads a recorded input. Submissions go through the D013 write-ahead record. A failure proven locally before dispatch records `not-sent`, and the answer can be resubmitted. Any other failure, or any unrecognized response, records `uncertain`. An uncertain submission is resolved only by reading the puzzle page, never by resubmitting. Parsed waits get a margin; implied but unparseable waits use conservative defaults.

Release timing is midnight EST (05:00 UTC), per the official FAQ; event length is not assumed. No live AoC request may happen before milestone 6 validation.

## D015 — BoC-owned agent loop over pi-agent-core

This resolves the `ModelRuntime` question in FEASIBILITY.md. The solver uses `pi-agent-core`'s `Agent` directly (`src/solver/agent.ts`), not `pi-coding-agent`'s `AgentSession`. `Agent` needs only an explicit `streamFn`, which BoC sets to the guarded streams (D011). No `ModelRuntime`, provider catalog, ambient credential discovery, compaction, branch summaries, cache warming, built-in tools, or resource discovery exist in this loop. The default-stream fallback is never used because `streamFn` is always passed. BoC sets `transport: "sse"`, sequential tool execution, and a hard turn cap independent of credits. Persistence lives in BoC's own journals, and transcripts will be private artifacts.

`@earendil-works/pi-agent-core@0.87.1` is now a direct dependency, and it deduplicates with the direct `pi-ai`. `pi-coding-agent` remains a dependency for the existing admission-boundary tests and settings/resources helpers. It is not used by the solver and may be removed later. The test-only `ModelRuntime` facade cast must not be used in production.

Solver tools (`src/solver/tools.ts`) are exactly `write_file`, `read_file`, `list_files`, `run`, and `propose_answer`. File tools reach only the host-side attempt workspace. `run` reaches only the networkless executor. `propose_answer` validates the answer and hands it to the orchestrator, which alone decides whether to submit.

## D016 — Best-effort credit limits with estimated reservations

On 2026-09-27 the operator relaxed the hard-ceiling requirement. BoC does not guarantee that credit limits are never exceeded, but it tries to match them as exactly as practical. The operator accepted these defaults: safety factor 1.5, overshoot tolerance 5 % of the pool's event limit, calibration tolerance 10 %, and a provider-side cap recommended rather than required. GitHub Copilot comes first.

What stays the same: durable atomic reservations against all four counters before every dispatch, held unknown outcomes, restart safety, separate native units, one dispatch path through the guard, and no unaccounted calls.

What changes:

- **Estimated reservation.** `src/budget/estimate.ts` estimates each call conservatively. Input tokens are estimated as request bytes / 3 plus 1000, and priced at the higher of the input and cache-write rates. Output tokens are taken at the provider-enforced cap, or at the configured `assumedMaxOutputTokens` when the provider ignores caps. The total uses the configured rates per million tokens and is multiplied by the safety factor. Subscriptions need an `estimate` block, otherwise they are not used. Zero or unknown rates are refused.
- **Actual charge with a source label.** The charge is the provider-reported figure (`provider`) if available, otherwise one derived from reported token usage (`derived`), otherwise the estimate itself (`estimated`). Operators can settle held reservations (`operator`).
- **Overshoot bound.** A charge above its estimate is recorded truthfully. Admission to that pool blocks only once the pool's unacknowledged excess exceeds `overshootTolerance` (default 5 % of the event limit). Other pools are unaffected. Acknowledging clears that entry's contribution.
- **Streaming cutoff.** The guard aborts a response whose running estimate exceeds its reservation, and settles it as `estimated` at the larger of the running estimate and the reservation. This is not a fault, so the guard stays usable.
- **Provider cap.** `providerCap: "configured"` records that a provider-side cap backs the pool. Otherwise every run warns.
- **Worst case per limit.** The limit, plus one call's excess over its estimate, plus the tolerance. Status views state that limits are best effort.
- **Eligibility.** An adapter is used only after a supervised calibration run with a small explicit allocation. It passes if no single charge exceeds its estimate by more than the safety factor, and BoC's total is within 10 % of the provider's billed total. The results are recorded in FEASIBILITY.md.

## D017 — Anthropic as a third provider

On 2026-09-27 the operator added Anthropic as a supported LLM provider (`provider: "anthropic"`). The native unit is the operator's billing unit, typically USD for the API. Pi 0.87.1 ships an Anthropic provider. Its details are verified when its adapter is built, and it follows D016 like the others. Unverified expectations to check then: whether the Messages API enforces `max_tokens`, and whether responses report input, output, and cache token usage. If both hold, estimates from published per-token prices can be accurate. Anthropic comes after GitHub Copilot.

## D018 — Calibration-only adapters and interactive login

Implemented adapters start in `CALIBRATION_ADAPTERS` (`src/providers/adapter.ts`) and can run only through `boc run --calibrate --days …`, for already released days (past puzzles) under operator supervision. `boc calibration-report` summarizes, per subscription, the calls made, estimated versus charged credits by source, held reservations, and the largest actual/estimate ratio, for comparison with the provider's billing. An adapter moves to `PRODUCTION_ADAPTERS` only after FEASIBILITY.md records a passing calibration. `boc login <config> <subscription>` performs the provider's interactive authorization and writes only that subscription's credential file; tokens are never printed or passed as arguments.

## D019 — Codex via the operator's own ChatGPT sign-in; Anthropic deferred

On 2026-09-27 the operator chose to skip Anthropic for now: the compliant API-key path needs Claude Console access that is not available. Anthropic stays in the configuration schema but has no adapter, and `boc login` refuses Anthropic because subscription OAuth is prohibited for third-party tools (FEASIBILITY.md).

Codex uses the operator's own ChatGPT Business sign-in through pi-ai's Codex provider. The official Codex docs describe ChatGPT sign-in for Codex apps and do not prohibit this, but they do not document a third-party contract either (FEASIBILITY.md). The Copilot and Codex adapters share `src/providers/oauth-adapter.ts`. Codex does not enforce output caps, so its estimates use the assumed maximum and rely on the streaming cutoff. Codex joins `CALIBRATION_ADAPTERS`, and moves to production only after a passing calibration.

## D020 — Two providers, one solving model, no parallel solving

On 2026-09-28, after the luna vs sol replay benchmark (EVALUATION.md), the operator decided:

- **Solving model:** `gpt-6-sol` is the solving model. It was faster and more reliable than `gpt-6-luna`, and its higher credit cost stays comfortably within budget.
- **No parallel solving:** there is no agreement, race, or escalation ladder across models. The single-attempt-per-part run state (D012) stays.
- **Anthropic dropped:** Anthropic support is no longer planned. This supersedes the provider scope of D017 and D019. BoC's providers are GitHub Copilot and ChatGPT/Codex. The dormant `anthropic` value in the configuration schema has no adapter, and `boc login` refuses it.

## D021 — Failover between subscriptions on provider refusals

On 2026-09-28, following the Codex credential outage during the benchmark:

- **What counts as a refusal:** a usage limit or a rejected credential, reported before or during an attempt. The guard reduces these to safe categories (EVALUATION.md).
- **Recording:** the attempt is recorded with outcome `refused`. `refusedAttempts` counts these separately, and they never count toward `maxAttemptsPerPart`, because the model did not fail.
- **Failover:** the part continues with the next subscription in configuration order (operator preference). A subscription that refused is not retried within the same part.
- **Run-level skipping:** the run loop skips a usage-limited subscription until the announced reset (default 60 minutes). A subscription with a rejected credential is skipped until a readiness check passes (amended by D022). Before D022, it was skipped for the rest of the day.
- **Stopping:** the run stops only when every subscription has refused. (Superseded by D024: outages are refusals too, the part waits within a retry window, and the run then continues with the next day.)
- **Limits:** the ledger still admits every call, so failover cannot bypass a limit, and units from different pools are never combined.
- **Provider faults** (unknown charges) still stop the run without failover: the adapter's accounting just failed, and the charge must be reconciled first.

## D022 — Readiness checks at start and before each release

On 2026-09-28 the operator decided that credentials are checked when BoC starts and 30 minutes before each release. An unattended multi-day run needs the second check as much as the first.

- **Credentials.** `ProviderAdapter.checkCredential` forces an OAuth refresh without a model call, and persists the rotated credential.
  - For Copilot, the refresh is the GitHub-to-Copilot token exchange, so it also proves the entitlement. For Codex, it is the auth.openai.com refresh.
  - A forced refresh also repairs an invalidated access token while the refresh token is still valid.
  - A failed check marks the subscription unavailable, so selection fails over (D021) before the release rather than at it. It stays unavailable until a later check passes, for example after `boc login`. (Amended by D024: only a rejected credential does; an unreachable provider is retried after 1 minute.)
  - A credential refusal during a run triggers an immediate check.
  - Refresh tokens can be single-use, so concurrently running BoC processes must never share a credential file.
- **AoC session.** `AocClient.checkSession` makes one authenticated read of `/settings`, re-reading the cookie file first, and classifies the result as `ok`, `logged-out`, or `unknown`.
  - A logged-out session is logged prominently but cannot fail over: there is one AoC account. The release fetch then stops with the existing clear error.
  - Traffic: one request at start and one at T−30 per unreleased day, plus one recheck at T−5 only if the T−30 check failed. Past or already solved days get no pre-release check.
- **Timing.** At T−30 BoC runs the checks, and if any failed it rechecks at T−5. (Amended by D029: a daily check during long waits.) It then sleeps to the release as before. A run started within 30 minutes of a release relies on its start check.
- **Verification.** Live on 2026-09-28, with one authenticated request made with the operator's go-ahead, `/settings` returned HTTP 200 (about 6 KB) with the logged-in marker, and the check reported `ok`. The operator confirmed in an anonymous browser window that without a valid session `/settings` redirects to `/2025`. BoC does not follow redirects and classifies any 3xx as `logged-out`.

## D023 — Operator alerts: ntfy push and a healthchecks.io dead-man's switch

On 2026-09-28 the operator chose ntfy for push notifications and healthchecks.io as a dead-man's switch. The dead-man's switch covers what push alone cannot: a stopped host, a crashed process, or a run that was never started.

- **Senders:** only the trusted orchestrator sends alerts, never generated code.
- **Destinations:** the ntfy topic URL, optional token, and healthchecks ping URL come from private owner-only files that the config references by path. They never appear in logs or errors. A configured but unusable file fails the run at start (fail closed).
- **Content:** day, part, outcome, attempts, submission count, credits, time since release, and fixed-message error descriptions. Never puzzle text, inputs, or answers.
- **Heartbeat:** a success ping after each passed readiness check (start, T−30, T−5). `/fail` goes out on a failed check or a stopped run. The operator's cron schedule on healthchecks.io defines "missing".
- **Delivery:** best effort. A 10-second timeout per request, no redirects, deduplication within 10 minutes, at most 30 alerts per hour (then one "suppressed" notice), and a bounded flush before exit. A failure never affects a run. Replay benchmarks are silent.

## D024 — Outage handling, a 6-hour retry window, and automatic stale-lock removal

The live failure drills of 2026-09-29 (EVALUATION.md) found four defects. On the same day the operator approved these fixes and set the retry window to 6 hours after release:

- **Credential checks tell an outage from a rejection.** The adapter classifies a failed refresh:
  - `rejected`: an explicit 400, 401, or 403, `invalid_grant`, or "unauthorized". The subscription is skipped until a check passes (D022), and the log says `run boc login`.
  - `unreachable`: anything else, such as a network or TLS failure, a timeout, a 5xx, or a malformed reply. The subscription is retried after 1 minute. Errors default to `unreachable`: retrying a dead credential costs a refresh request, while skipping over an outage would lose a release.
- **Outages are refusals.** The guard classifies a provider error as `outage` with pi-ai's own transient-error classifier (`isRetryableAssistantError`), after the credential and usage-limit rules.
  - As with other refusals (D021), the attempt is recorded as `refused` and does not count toward the attempt cap, and the part fails over.
  - The outage keeps the subscription out for 15 s, 30 s, 60 s, 120 s, then 5 minutes per consecutive outage. The counter resets once the provider answers.
  - A brief outage that other subscriptions cover alerts once. A lone, first outage does not alert at all.
- **Waiting instead of giving up.** When no subscription can run, the part first offers the refused subscriptions again (each such retry follows a real refusal, so it cannot spin). If none can run, it sleeps until the earliest one becomes available.
  - Rejected credentials are rechecked every 5 minutes, so `boc login` repairs them within the window.
  - The window ends 6 hours after the later of the puzzle's release and the time that day's solving began. The second case covers past-day and replay runs.
  - After the window the part ends as `provider-unavailable` (resumable), an urgent alert goes out, and **the run continues with the next day** instead of stopping.
  - Replay waits in real time for providers, while its AoC embargoes stay virtual.
- **Credit exhaustion inside an attempt fails over.** The attempt is recorded as `budget-exhausted` and counts. The part returns to `ready` (a change to the state machine; older journals replay the same way), and that subscription is excluded for the rest of the part. The part gives up only through the attempt cap, or ends as `no-subscription` when no subscription can afford an attempt.
- **Stale locks are removed at start.** `boc run` and `boc replay` remove a ledger or run-state lock of this host in two cases: its PID no longer exists, or the host has booted since the lock was taken. Locks now record the boot time. A live owner's lock, or another host's, is kept. The error then names the owner's PID and points to `boc ledger break-lock`. This makes systemd `Restart=on-failure` safe.
- **Unchanged:** provider faults (unknown charges) still stop the run (D021).

## D025 — AoC resilience: session detection, retried page reads, and adopting answers from the page

The live AoC drills of 2026-09-29 (EVALUATION.md) showed that AoC answers an unknown or expired session cookie with HTTP 500, and that a 5xx on any page read stopped the run. The retry policy follows D024 and the AoC request pacing (AOC.md):

- **Session check.** A 500 from `/settings` makes one more request: a cookie-less read of `/about`. If that succeeds, the session is `logged-out`; otherwise the result is `unknown`.
- **Page reads** (puzzle page, input, and the reconciliation read) go through `src/aoc/resilient.ts`.
  - A transient failure (5xx, network, timeout) is retried after 15 s, 30 s, 60 s, then every 15 minutes, like a just-released puzzle.
  - A rejected session sends one urgent alert and waits for the operator to replace the cookie file. The file is watched locally every minute. The session is rechecked when the file changes, and at most every 15 minutes otherwise.
  - Both last until the day's retry window ends: 6 hours after the later of the release and the start of that day's solving (D024). The original error is then thrown, which stops the run.
  - Answer submissions are never retried; unknown outcomes are reconciled (D014).
- **Adopting answers from the page.** A `ready` part whose accepted answer is already on the puzzle page (solved outside this storage) is recorded with the new run-state record `part-adopted` as solved. There is no model call and no submission. This prevents duplicate submissions after a storage reset or a manual solve. The final day's part 2 shows no answer and is not adopted.

## D026 — One resubmission after an unknown outcome; a separate brake window for session checks

On 2026-09-29 the operator decided the two open findings of the live AoC drills (EVALUATION.md):

- **Crash during a submission (defect G): option (b).** Reconciliation marks an unknown outcome `not-correct` when the page shows the level still open, but AoC may never have judged it. Such an answer may be submitted **once more** automatically. The verdict of that resubmission is final, and a second unknown outcome for the same answer blocks it. If AoC had in fact judged the first submission wrong, the cost is one repeated wrong answer and its wait. This deliberately relaxes the no-duplicates rule (D014) for this narrow case only. Answers with a judged verdict (wrong, too high, too low) are never resubmitted.
  - The solver prompt lists such an answer as "interrupted, outcome unknown" rather than rejected, so the model proposes it again when its program produces it.
  - `boc submission not-judged` still unblocks an answer when the operator has evidence.
- **The bug brake leaves session checks out.** `/settings` checks and the cookie-less `/about` probe use their own sliding window with the same cap (10 per 10 minutes). A session recovery can no longer delay the puzzle, input, and answer requests. A runaway session-check loop is still braked.

## D027 — Unattended host: a dedicated Raspberry Pi 5 appliance

On 2026-09-29 the operator approved deploying BoC on a dedicated Raspberry Pi 5 (8 GB), set up as described in [RPI.md](RPI.md):

- **Operating system:** Raspberry Pi OS Lite (64-bit) on an SSD, with nothing else on the host. Only SSH is allowed inbound, unattended updates are security-only, and automatic reboots are disabled.
- **Runtime:** Docker Engine from Docker's repository, and the official Node.js 24 build. BoC runs as a dedicated `boc` user in the `docker` group, which is root-equivalent: another reason the host is single-purpose.
- **Service:** systemd with `Restart=on-failure` (60 s), at most 5 starts per hour, and no retry of usage errors (exit 2). It starts only after a synchronized clock and Docker. D024's stale-lock removal makes restarts safe.
- **Solver image:** transferred with `docker save | docker load`, which keeps the ID, rather than rebuilt, so the host runs the probed image.
- **Credentials:** moved to the Pi, which then owns them. The development machine must not run BoC with the same credential files again (D022).
- **Checks before enabling the service:** the memory cgroup, so that solver memory limits apply, is enabled by `setup.sh` if missing; Docker memory-limit support, the 16K page size, NTP, the SSD, and private-file modes are checked by `check.sh`; and the executor probe runs with every toolchain.

## D028 — Decoding letter art: prompt guidance and a preinstalled OCR library

On 2026-09-29 the operator chose remedies (a) and (b) for defect H (EVALUATION.md: letters drawn as ASCII art were misread):

- **(a) Prompt guidance.** The solver system prompt says never to read drawn letters by eye. The model decodes them in code, proposes exactly the string its program printed, and fixes the drawing (crop, orientation, pixel characters) instead of guessing. The prompt names the library and its input requirements: 6 equal rows starting at the first drawn column, with no trailing blank columns.
- **(b) Library.** `advent-of-code-ocr` 1.1.0 (MIT, a general-purpose decoder of AoC's 6-row block letter font, not a puzzle solution) is preinstalled in the solver image.
  - It is hash-pinned in `sandbox/python-requirements.txt` and installed with `--require-hashes --only-binary=:all: --no-deps`, like uv.
  - Its dependency `click` serves only the command-line entry point and is not installed.
- **Verification:** the toolchain probe decodes synthetic glyphs taken from the library's own font table. Live runs are recorded in EVALUATION.md.
- **Not chosen:** (c), refusing near-duplicate readings.

## D029 — Daily readiness checks during long waits

On 2026-09-30 the operator decided that BoC, started weeks before the event (as the Pi service is), checks readiness every day while it waits. Before this, the first check after the start check came at T−30 on 1 December: about 62 idle days for the refresh tokens, and an expired credential or cookie would have been found with 30 minutes to fix it.

- **When:** during a wait for a pre-release check, whenever 24 hours have passed since the last check. There is no daily check within a day of T−30, and none during the event, where the gaps between checks are under a day.
- **What:** the D022 readiness check. That is a forced OAuth refresh of every subscription (no model call; the rotated credential is persisted) and one authenticated AoC `/settings` read. It adds one AoC request per day of waiting, far below the 15-minute guidance for automated traffic.
- **Reporting:** the log reads `daily check passed` or `daily check FAILED: …`. A failure sends an urgent alert and healthchecks `/fail`, and marks the subscription unavailable until a later check passes (D022, D024). A pass sends the success heartbeat, which healthchecks.io ignores outside its December schedule.
