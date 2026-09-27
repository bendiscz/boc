# Development plan and session handoff

## Current state

- Offline foundation implemented: strict versioned configuration, exact credit amounts, a configuration-checking CLI, restrictive Pi settings, explicit resources, a guarded provider-stream admission boundary proven with a fake-provider `AgentSession`, 46 offline tests, build/lint/type checks, and credential-free CI (passing on GitHub).
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

Next concrete task: milestone 2 — define event/puzzle/attempt identifiers (extend `src/state/ids.ts`, which so far has only `PuzzleId` = `day-NN`), puzzle/attempt state transitions, and the private artifact layout under `storageDir` with a readable index; then a durable run-state/event store reusing the ledger's journal discipline (fsync-before-ack, torn-tail handling, single-writer lock). Also add a `boc ledger status` CLI view and an operator reconciliation command (settle a held reservation from evidence, acknowledge overrun) before live use. Do not begin live calls while either eligibility gate is unresolved. The `ModelRuntime` facade question (FEASIBILITY.md) must be decided before any live session factory.

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

- [ ] Define event/puzzle/attempt identifiers, state transitions, and private artifact layout with a readable index.
- [ ] Implement atomic persistence, structured events, recovery, and single-writer/concurrency coordination. (Done for the credit ledger; run/puzzle state store outstanding.)
- [x] Implement exact credit arithmetic, atomic multi-limit reservations, reconciliation, and conservative handling of uncertain calls.
- [x] Test concurrent admissions, exhaustion, restart/crash cases, separate credit pools, and unaccounted-operation rejection.

### 3. AoC transport and scheduling

- [ ] Implement a trusted cookie-file client with host restrictions, redacted errors, caching, timeouts, and polite request scheduling.
- [ ] Parse puzzle/answer responses and handle authentication failures, part unlocks, cooldowns, duplicates, and ambiguous submissions.
- [ ] Implement past-puzzle mode and release waiting with verified calendar rules and a fake clock for tests.
- [ ] Use only synthetic fixtures in committed tests.

### 4. Solver and subscription orchestration

- [ ] Integrate Pi with explicit resources, custom constrained tools, private session persistence, and no inherited personal extensions or credentials.
- [ ] Implement isolated Python/uv, Node.js, Go, and Rust execution with resource limits and controlled dependencies.
- [ ] Build the solve → test → propose answer → trusted submit → next part loop.
- [ ] Add budget-aware subscription/model selection and compliant fallback that preserves all reservations and limits.
- [ ] Verify no solution-fetching path exists through tools, subprocesses, or unrelated host files.

### 5. Terminal experience and recoverability

- [ ] Show puzzle, phase, provider, spent/reserved/remaining credits by pool, recent actions, and results.
- [ ] Provide headless mode, graceful shutdown, resumable runs, and clear terminal failure states.
- [ ] Produce a human-readable private run summary and navigable per-puzzle artifacts.

### 6. Authorized historical evaluation

- [ ] Ask for credential-file paths and perform the minimum required interactive authorization; never ask for pasted secrets.
- [ ] Validate actual subscription entitlements and credit reconciliation under a small explicit allocation.
- [ ] Validate the dedicated AoC account/session and site conduct before submissions.
- [ ] Evaluate representative older puzzles privately; record correctness, credit usage, latency, and failure modes without consulting solutions.
- [ ] Turn discovered defects into synthetic regression tests and refine scheduling/solver strategy.

### 7. AoC 2026 readiness

- [ ] Recheck site rules, event calendar, provider policy, models, and credit semantics.
- [ ] Exercise outages, quota exhaustion, process death, unknown charges, duplicate submissions, and expired credentials.
- [ ] Document installation, credential setup, budget configuration, private data handling, operation, and recovery.
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
