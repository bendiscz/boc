# Development plan and session handoff

## Current state

- Offline foundation implemented: strict versioned configuration, exact credit amounts, a configuration-checking CLI, restrictive Pi settings, explicit resources, a guarded provider-stream admission boundary proven with a fake-provider `AgentSession`, 46 offline tests, build/lint/type checks, and credential-free CI (passing on GitHub).
- Terminal dashboard (`--tui`, alternate screen, throttled), private `events.log`, and the operator override `boc submission not-judged` (it only unblocks an answer; it never resubmits).
- `boc run <config> [--days ...]` (`src/app.ts`):
  - It fails closed before any storage, ledger, or AoC access, because the production adapter registry is intentionally empty.
  - It sleeps until each release, retries unlock a bounded number of times, and never refetches solved days.
  - It stops the run on a provider fault.
  - Ctrl-C stops gracefully (exit code 130) and the run can be resumed.
- Solve-loop orchestrator (`src/solver/run.ts`): cached fetch, a fresh per-attempt workspace carrying earlier files forward, ledger-admitted agent runs, a private transcript beside the workspace, write-ahead submission with embargo waits, retries with rejected answers and bounds in the prompt, part 2 progression, and restart resumption. Plus budget-aware subscription selection (`src/budget/select.ts`).
- Solver agent loop over `pi-agent-core` with constrained tools (D015), the host-side attempt workspace, a production Docker executor, and a toolchain image (`SANDBOX.md`). Executor and toolchains verified locally with Docker Desktop.
- Offline AoC transport (D014, `AOC.md`): pinned-host cookie-file client, conservative response parsers, release calendar, and a cached, write-ahead submission service, tested only with fake transports and synthetic HTML.
- Durable run-state journal with a validated puzzle/part state machine, private artifact layout, derived Markdown views, and `status`/`views`/`ledger` CLI commands (D013).
- Durable four-counter credit ledger (`src/budget/ledger.ts`) and ledger-backed `Admission` (`src/budget/admission.ts`) implemented and tested offline with fake providers; see D012. No production `CreditMeter` exists, so nothing can be admitted for a real provider.
- No live provider adapter, AoC client, solver, or TUI yet. Both real providers are deliberately ineligible for chargeable work; see `FEASIBILITY.md`.
- A synthetic Docker isolation probe passed locally; production execution and dependency acquisition remain unimplemented.
- Repository: `https://github.com/bendiscz/boc.git`, branch `main`.
- Only branch: `main` (`master` deleted). History was rewritten once on operator request to set the author to Martin Benda <martin@bendovi.cz>, configured locally for this repository.
- The operator clarified credit-only budgets, multiple subscriptions, runtime prohibition on retrieving solutions, and an AI/bot-permitted private leaderboard.
- No BoC provider credentials or AoC cookie have been requested or used. No live puzzle was fetched or answer submitted.
- Selected Node.js 24 LTS (minimum/tested 24.21.0) and pinned Pi family 0.87.1, TypeScript 6.0.3, Biome 2.5.14, and Zod 4.6.5. npm `11.19.0` was used locally. Dependencies and lockfile are committed; lifecycle scripts are disabled.
- Original `init.md` is replaced by the English project documentation and retained in Git history.

## Next session: start here

Read `AGENTS.md`, `REQUIREMENTS.md`, `DECISIONS.md`, `CONFIGURATION.md`, and `FEASIBILITY.md`. Run `npm ci --ignore-scripts` and `npm run check`.

Next concrete task: **operator decision needed on provider eligibility** (milestone 6 is blocked). All offline milestones through the offline parts of 7 are implemented. The remaining work needs an eligible provider adapter. It must supply a certified per-call credit upper bound, authoritative receipts, and a transport without hidden retries (`src/providers/adapter.ts`, FEASIBILITY.md). Ask the operator whether to:

- (a) research current official GitHub Copilot and ChatGPT/Codex documentation again for a hard per-request bound and per-request credit receipts, then prototype an adapter against a small explicit allocation with operator-provided credential files; or
- (b) wait for provider-side changes.

Do not weaken the gate unilaterally. Offline work that can continue meanwhile:

- hash-pinned `uv` in the image;
- a Linux-host run of the executor probe;
- final-day part 2 handling (needs the page structure verified manually by the operator, not fetched by BoC).

Do not begin live calls while either eligibility gate is unresolved. The `ModelRuntime` facade question (FEASIBILITY.md) must be decided before any live session factory.

The documentation spike is complete, but neither subscription's hard per-call credit bound is established. Live validation is a later blocker; it does not prevent offline foundation/ledger work. Preserve unknown-charge reservations and do not replace native credits with estimates that can overshoot.

## Milestones

### 1. Validate foundations and establish the project

- [x] Read current installed Pi SDK docs and relevant examples; choose and pin supported Node.js/Pi versions.
- [x] Investigate each requested provider's current authentication, enterprise restrictions, credit definition, usage reporting, and conservative per-call bound. Sources and unresolved eligibility gates are in `FEASIBILITY.md`; no live validation.
- [x] Verify a pre-dispatch enforcement point that covers all Pi calls, including retries, compaction, and auxiliary work. Proven with fakes; see FEASIBILITY.md for the test-only runtime facade limitation.
- [x] Define subscription identity, native credit units, pool allocation, and budget configuration semantics.
- [x] Select networkless Linux-container isolation and document prerequisites; run a synthetic local probe. Production executor and controlled dependency-acquisition implementation remain in milestone 4.
- [x] Scaffold TypeScript, package scripts, lockfile, formatting/linting, type checks, offline tests, and CI. CI must not need private credentials or puzzle data.
- [x] Add validated non-secret configuration examples with credential-file paths only.

### 2. Durable state and credit admission

- [x] Define event/puzzle/attempt identifiers, state transitions, and private artifact layout with a readable index.
- [x] Implement atomic persistence, structured events, recovery, and single-writer/concurrency coordination.
- [x] Implement exact credit arithmetic, atomic multi-limit reservations, reconciliation, and conservative handling of uncertain calls.
- [x] Test concurrent admissions, exhaustion, restart/crash cases, separate credit pools, and unaccounted-operation rejection.

### 3. AoC transport and scheduling

- [x] Implement a trusted cookie-file client with host restrictions, redacted errors, caching, timeouts, and polite request scheduling. (Pacing per operator decision: no delays in a solve burst, no needless requests, sliding-window bug brake; see AOC.md.)
- [x] Parse puzzle/answer responses and handle authentication failures, part unlocks, cooldowns, duplicates, and ambiguous submissions. (Wording unvalidated against live responses; final-day part 2 outstanding.)
- [x] Implement past-puzzle mode and release waiting with verified calendar rules and a fake clock for tests. (`isReleased`/`waitForRelease`; day selection is done by the milestone 4 run loop.)
- [x] Use only synthetic fixtures in committed tests.

### 4. Solver and subscription orchestration

- [x] Integrate Pi with explicit resources, custom constrained tools, private session persistence, and no inherited personal extensions or credentials. (D015 agent loop and tools; transcript persistence arrives with the solve loop.)
- [x] Implement isolated Python/uv, Node.js, Go, and Rust execution with resource limits and controlled dependencies. (`SANDBOX.md`; hash-pinned PyPI acquisition outstanding.)
- [x] Build the solve → test → propose answer → trusted submit → next part loop. (`src/solver/run.ts`, fake transports only.)
- [x] Add budget-aware subscription/model selection and compliant fallback that preserves all reservations and limits. (`src/budget/select.ts`; the ledger still admits every call.)
- [x] Verify no solution-fetching path exists through tools, subprocesses, or unrelated host files. (`test/originality.test.ts`; the Docker probe checks that DNS and HTTP fail inside the container.)

### 5. Terminal experience and recoverability

- [x] Show puzzle, phase, provider, spent/reserved/remaining credits by pool, recent actions, and results. (`boc run --tui`, `src/ui/dashboard.ts`; `boc status`.)
- [x] Provide headless mode, graceful shutdown, resumable runs, and clear terminal failure states. (`boc run`, with headless timestamped lines by default.)
- [x] Produce a human-readable private run summary and navigable per-puzzle artifacts. (`INDEX.md`, `SUMMARY.md`, per-puzzle `README.md`, `events.log`, per-attempt `transcript.json` and `work/`.)

### 6. Authorized historical evaluation

- [ ] Ask for credential-file paths and perform the minimum required interactive authorization; never ask for pasted secrets.
- [ ] Validate actual subscription entitlements and credit reconciliation under a small explicit allocation.
- [ ] Validate the dedicated AoC account/session and site conduct before submissions.
- [ ] Evaluate representative older puzzles privately; record correctness, credit usage, latency, and failure modes without consulting solutions.
- [ ] Turn discovered defects into synthetic regression tests and refine scheduling/solver strategy.

### 7. AoC 2026 readiness

- [ ] Recheck site rules, event calendar, provider policy, models, and credit semantics.
- [ ] Exercise outages, quota exhaustion, process death, unknown charges, duplicate submissions, and expired credentials. (Offline drills done in `test/drills.test.ts`; live drills are pending.)
- [x] Document installation, credential setup, budget configuration, private data handling, operation, and recovery. (`OPERATOR.md`)
- [ ] Run an end-to-end rehearsal and obtain any remaining operator-side setup.

## Verification and handoff discipline

For every implementation increment, record commands run and their outcomes here or in a linked development note. Run type checks and relevant tests before committing. Distinguish offline tests from live validation. Update the next task, unresolved risks, and operational prerequisites before ending a session.

Bootstrap verification:

- Reviewed requirements, decisions, and the milestone sequence against the original instructions and operator clarifications.
- `git diff --cached --check` — passed.
- `git check-ignore` for representative credential files, private inputs/transcripts, `.env`, `auth.json`, and `node_modules/` — all correctly ignored.
- Reviewed staged paths and change summary — documentation, `.gitignore`, and removal of `init.md` only; no private data.
- At bootstrap there was no application to test. No live provider or AoC validation was performed.

Foundation verification (2026-09-27):

- `npm install --ignore-scripts` followed by a clean `npm ci --ignore-scripts` — completed; audit reported zero vulnerabilities at installation time.
- `npm run check` — lint, type checks, 22 offline tests, and ESM build passed locally.
- `node dist/main.js check-config examples/boc.config.json` — passed, explicitly reporting disabled live providers; credential files not read.
- `npm ls` for the Pi family — all five packages resolved to 0.87.1.
- `npm run test:sandbox -- <local Node image ID>` — passed the synthetic isolation checks on Docker 29.8.0; no image pull or puzzle/provider traffic.
- Independent read-only review found no P1 issues and one P2 verification gap: a non-root write failure did not prove read-only root. Added a `/proc/self/mountinfo` assertion and reran all checks. A negative-control run with `--read-only` removed correctly failed that assertion.
- Representative credential, private artifact, dependency, and build paths were confirmed ignored by Git.
- GitHub CI passed remotely for the foundation commit. No live provider or AoC testing.

Admission-boundary verification (2026-09-27):

- Added `@earendil-works/pi-ai@0.87.1` as a direct dependency. It is **not** deduplicated: `pi-coding-agent` ships a shrinkwrap with its own nested copy, so two pi-ai module instances exist at runtime. Known risk (e.g. `instanceof`/registry mismatches); the current code relies only on structural stream objects. Revisit before live integration.
- `npm run check` — 46 offline tests (15 guard unit tests, 9 fake-provider `AgentSession` tests) passed with lint, type checks, and build.
- Independent review: two P1s (compaction test never dispatched; request-rewriting options forwarded after admission) and five P2s (denials faulted the guard; aborted terminals were settled; forged-model test was blocked by the fixture, not the guard; retry tests could not observe retries; incorrect dedupe claim). All fixed and covered by tests; doc claims corrected.
- Probe confirmed Pi `setModel` accepts a forged same-provider model; the guard (not the fixture) rejects its dispatch before admission (regression test).

Credit-ledger verification (2026-09-27):

- `npm run check` — lint, type checks, 67 offline tests (14 ledger, 7 ledger-admission including a fake-provider `AgentSession` tool loop stopped by the durable pool limit), and build passed.
- Covered: exact boundaries on each of the four counters, per-puzzle vs event scope, shared and separate pools, 20 concurrent admissions against a 3-slot limit, invalid/zero/duplicate/unknown-scope rejection, restart with orphaned and uncertain holds, stale-lock refusal and dead-PID breaking, torn-tail recovery, corruption and config-mismatch refusal, persistent overrun blocking until acknowledged, injected fsync failure faulting the ledger while counting the reservation, private file modes, close draining queued work, abort-after-admission and transport-failure annotations.
- Independent review (child Pi, read-only): addressed abort-after-reservation annotation (new optional `Reservation.abandon`, annotation only), full-line appends (`appendFile`), parent-directory fsync, and a close-draining test. The claim that close could race queued operations was checked and is not reachable (closure is checked synchronously before enqueuing); covered by a test. PID reuse can block `breakStaleLock` (refusal is intentional; manual removal after review is the override). Receipt uniqueness is not enforced (duplicate receipts over-count, which errs safe).
- Fsync-failure behavior was tested by patching `FileHandle.prototype.sync`, not by real disk faults. No power-loss testing. No live provider or AoC activity.

Run-state and artifact verification (2026-09-27):

- Extracted the journal (lock, fsync-before-ack, torn-tail repair, sequence checks, fault latch) into `src/state/journal.ts`; the ledger now uses it (lock file renamed to `journal.lock`). All ledger tests still pass.
- `npm run check` — lint, type checks, 77 offline tests, and build passed. New coverage: two-part lifecycle, forbidden transitions writing nothing, duplicate/bounded/cooldown-blocked submissions, cooldown-verdict resubmission after the embargo, crash during submission → `uncertain` and no retry, interrupted attempts, replay of an impossible journal and wrong event refused, layout paths, atomic view writes with private modes and Markdown escaping, lock-free status, CLI settle refused while the ledger is locked and requiring an `operator:` receipt.
- Independent review (child Pi, read-only): `writeViews` now tolerates a missing `runs/` directory (not reachable via the current write order, but hardened); `boc status` now uses the unified summary renderer; D012 lock name corrected. Not changed: a directory fsync after torn-tail truncation (truncation is file metadata, covered by the file fsync); the `as never` cast in `RunStore.record` (records are schema-validated at runtime before append).
- No live provider or AoC activity.

AoC transport verification (2026-09-27):

- Documentation recheck only: fetched the AoC About/FAQ directly. Automation guidance came from search-result excerpts of the site author's subreddit posts; the pages themselves could not be rendered. No puzzle, input, or solution content was fetched; BoC made no AoC request. Findings are in `AOC.md`.
- `npm run check` — lint, type checks, 86 offline tests, and build passed. New coverage: verdict and wait parsing, including defaults and unrecognized responses; puzzle-page parsing; release times and sleep-based waiting; host pinning, User-Agent, cookie header, form encoding, manual redirects, request spacing and serialization; typed sanitized errors that never contain the cookie; unsafe cookie files and missing contact refused; oversized responses; cached downloads; too-high embargo; part 2 unlocking; timeout → uncertain → read-only reconciliation (still-uncertain, conflicting answer, not-correct, correct); crash adoption of atomically written files; and the pre-dispatch not-sent path.
- Independent review (child Pi, read-only):
  - Fixed: pre-dispatch failures no longer strand submissions as `uncertain`. There is a cookie preflight before the write-ahead record, plus a new `not-sent` verdict for proven non-dispatch.
  - Fixed: wait clauses are no longer cut at periods.
  - Recorded, not changed: reconciliation's `not-correct` may block an answer the server never judged (errs toward no duplicates), the POSIX-only cookie permission check (the orchestrator targets POSIX hosts), and final-day handling.
- Operator pacing decision applied: removed the 5-second minimum spacing and added a sliding-window bug brake (`rateCap`, default 10 per 10 minutes). The unlock retries and the answer-wait embargo are unchanged. `npm run check` — 87 offline tests passed.

Solver loop and executor verification (2026-09-27):

- Added `@earendil-works/pi-agent-core@0.87.1` (deduplicates with the direct `pi-ai`). `npm run check`: 93 offline tests passed. New coverage:
  - Workspace confinement, symlink refusal, and limits.
  - Output sanitization.
  - Docker argument isolation and the digest-only image rule.
  - A fake-provider solver run (write → run → propose, with 3 ledger-admitted turns and no extra call after the proposal).
  - Credit exhaustion and the turn cap stopping a looping solver.
  - Invalid proposals and paths returned to the model as tool errors.
- Built `sandbox/Dockerfile` locally (arm64, Docker Desktop 29.8.0) behind the operator's TLS-intercepting proxy. The operator's CA was supplied as a BuildKit secret; the image history, `/tmp`, and the file tree were checked and contain no copy of it. Toolchains: Python 3.13.5, uv 0.8.22, Node 24.20.0, Go 1.24.4, rustc/cargo 1.85.1.
- `npm run test:executor -- <image-id> --toolchains` passed:
  - isolation: non-root, no host variables, read-only `/work`, writable `/tmp`, no external interface, bounded output, and a killed and removed timed-out container;
  - toolchains: python3 with numpy/scipy/sympy/networkx, `uv run --no-project`, node, `go run`, rustc, and cargo (after copying the project to `/tmp`, because `/work` is read-only; the tool description tells the model this).
- Not yet done: a Linux-host executor run, hash-pinned uv/PyPI, and any live model use.
- Independent review (child Pi, read-only):
  - Fixed: a proposal made in the same turn as other tool calls did not end the loop, because pi-agent-core terminates only when every tool result asks to. `shouldStop` in `finishTurn` now enforces it, and only one proposal is accepted per run.
  - Fixed: aborts now kill the container (the executor accepts `signal`; verified in the Docker probe).
  - Fixed: CSI/OSC escape sequences are fully stripped, and workspace `mkdir` errors are typed.
  - Not changed: container-name cleanup, since `--rm` plus a killed container covered all probe runs.
  - Not changed: the Linux parent-directory permission concern. The container sees only the bind-mounted directory at `/work`, and host parents are resolved by the daemon; this still needs confirmation on a Linux host.
- `npm run check`: 94 offline tests passed.

Solve-loop verification (2026-09-27):

- `npm run check`: 101 offline tests passed. New end-to-end fake run:
  - part 1: a wrong (too-high) answer, then a sleep for the server wait, then a correct retry, whose prompt lists the rejected answer and the bound and carries the previous files forward;
  - part 2: unlocked, with the part 1 files copied and the part 1 answer in the prompt;
  - 4 ledger-admitted calls, 6 AoC requests with none repeated, and a private transcript outside the container-visible workspace.

  Also covered: credit exhaustion gives up without any submission; the attempt cap; no eligible subscription; a restart resuming a proposed answer without a new attempt; part 2 unavailable when not unlocked; statement text conversion; and prompt delimiters that the puzzle text cannot break.
- Independent review (child Pi, read-only):
  - Fixed: the workspace is now prepared before `attempt-started`, and crash debris is replaced.
  - Fixed: file carry-over is per file, so one bad file no longer aborts the rest.
  - Fixed: puzzle text can no longer close the prompt delimiters.
  - Fixed: `maxAttemptsPerPart` is validated.
  - Not changed: an answer proposed from settled turns before a later provider fault is kept as a proposal. A proposal ends the run, so this is theoretical, and the answer came from admitted, settled work.
  - Not changed: selection does not avoid subscriptions that already hold reservations; the ledger already counts held reservations.

Run command and originality audit verification (2026-09-27):

- `npm run check`: 111 offline tests passed. New coverage:
  - With no eligible adapter, nothing is created or contacted, and an adapter/model mismatch is refused.
  - Past mode solves released days; an unreleased explicit day gets exactly the bounded unlock retries.
  - A rerun of a solved day makes no AoC request.
  - Live mode sleeps until release plus margin before the first request, then stops at the first unavailable day.
  - An aborted wait leaves state resumable and locks released.
  - CLI refusal, day validation, and the abort exit code.
  - The originality audit: exact tool set, forbidden imports in solver and sandbox code, and Docker arguments with no network, extra mounts, environment, or socket.
- `npm run test:executor -- <boc-solver image>` passed with the new DNS and HTTP failure checks.
- Independent review (child Pi, read-only), all addressed:
  - Sleep abort listeners leaked; a shared `abortableSleep` now removes them.
  - The provider-fault exclusion set was never used. It is removed, and the run now stops on a fault by design.
  - Out-of-range `--days` values are now rejected.
  - Tests for the aborted-run exit code were missing and have been added.

Terminal view and operator tooling verification (2026-09-27):

- `npm run check`: 117 offline tests passed. New coverage:
  - dashboard content (phase, subscription, per-pool credits, holds, results, events) and width clipping;
  - alternate-screen enter and restore with no draw after close;
  - progress snapshots carrying the current puzzle;
  - `events.log` content, `0600` permissions, and the link from the summary;
  - the override unblocking only never-judged submissions, never judged ones, and never resubmitting by itself;
  - the CLI override requiring exact arguments and the store lock.
- Independent review (child Pi, read-only), all addressed:
  - The override re-proposed an uncertain answer, so the next run would have submitted it automatically. It now returns the part to `ready`, and only a fresh proposal can submit that answer again.
  - The TUI did not restore the terminal. It now uses the alternate screen, hides and restores the cursor, and restores on exit.
  - The event buffer was kept even without the TUI; it is now kept only for the TUI.

Operator guide and drills verification (2026-09-27):

- Added `OPERATOR.md`.
- Added offline drills (`test/drills.test.ts`):
  - A network failure after the server received an answer becomes uncertain; the same run reconciles it by reading the page, with exactly one submission.
  - An outage during reconciliation stops the run with the part left uncertain, and a later run resolves it without resubmitting.
  - An expired session stops the run before any model call and resumes after renewal.
  - With per-puzzle limits of 1 credit, quota exhaustion falls over to the second subscription and no counter is exceeded.
  - A process killed mid-attempt resumes with the attempt recorded as interrupted, reuses the cached input, and records one submission.
- `npm run check`: 122 offline tests passed.
