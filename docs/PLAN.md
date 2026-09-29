# Development plan and session handoff

## Current state (2026-09-28, end of session)

- **Working end to end.** `boc run` waits for releases (or takes `--days`), fetches and caches the puzzle and input, and solves with a ledger-admitted, constrained agent loop (`pi-agent-core`, D015). Generated code runs in networkless Docker containers. The run then submits with write-ahead records and continues to part 2. Commands:
  - `run`, `status`, `views`, `--tui`, `events.log`;
  - the ledger and submission operator commands (`break-lock` clears both locks);
  - `login`, `calibration-report`;
  - `replay`, the model benchmark against accepted answers, which never contacts AoC;
  - `alert-test`.
- **Reliability features added on 2026-09-28:**
  - final-day part 2 button;
  - runaway-response limits (120 s per response, 60 s stall, 10 min per attempt; the partial output is kept privately);
  - refusal of known-wrong proposals back to the model;
  - failover between subscriptions on provider refusals (D021);
  - readiness checks at start and T−30 before each release, with a recheck at T−5 (D022);
  - ntfy and healthchecks.io alerts (D023);
  - outage handling (D024, 2026-09-29): outages are refusals with backoff and failover; parts wait up to 6 hours after release; credential checks tell an outage from a rejection; credit exhaustion mid-attempt fails over; stale locks are removed at start.
- **Budgets are best effort (D016).** Each call reserves a padded estimate against four counters, charges are recorded with their source, runaway responses are cut off, and each pool has an overshoot tolerance.
- **Providers and model:**
  - GitHub Copilot and ChatGPT/Codex are calibrated and in `PRODUCTION_ADAPTERS` (FEASIBILITY.md).
  - The solving model is `gpt-6-sol`, which beat `gpt-6-luna` in the replay benchmark (EVALUATION.md).
  - No parallel solving; Anthropic is dropped (D020).
- **Sandbox.** The image `boc-solver:dev` is `sha256:7e4e65ecaffd45149717c8cd0b9e13321088f116b60c5b8b436b90b15bcfeebd` (arm64, rebuilt 2026-09-29 for D028), with `uv` and `advent-of-code-ocr` hash-pinned (`sandbox/*-requirements.txt`). Every private config points to it.
  - `npm run test:executor -- <id> --toolchains` passes on Docker Desktop.
  - `npm run test:linux -- <id>` passes on a native Linux daemon (dind) under umask 022 and 077.
  - An amd64 run and a bare-metal Linux run are still open.
- **AoC account.** All of AoC 2025 (24 stars) and AoC 2024 days 13–25 (25 stars; day 25 part 2 needs days 1–12) are solved on the dedicated account. Results are in EVALUATION.md. AoC conduct is covered in D014 and AOC.md: no delays within a solve burst, no needless requests, and the bug brake of 10 requests per 10 minutes.
- **Private local setup** (ignored by Git; never read or print `.secrets/`):
  - **Secrets:** `.secrets/` holds the AoC cookie, `copilot.json`, `codex.json`, `ntfy-topic-url`, and `healthchecks-ping-url`. The operator's `boc alert-test` passed on 2026-09-28, using `examples/boc.config.json`, whose paths resolve to `.secrets/`.
  - **Event config:** `var/event-2026.config.json` is for event 2026, with storage `var/event-2026`.
    - Subscriptions: sol via Copilot first, then Codex (failover, D021), on separate pools of 300 per event and 100 per puzzle each.
    - Alerts are on, and it uses the image above. Smoke-tested via a 2025 copy (`var/smoke-2025.config.json`): both start checks passed, and Copilot solved day 1.
    - It shares the credential files with the other configs, so never run two BoC processes concurrently (D022).
  - **Other configs, each with its own storage under `var/`:**

    | Config | Purpose | Spent (native credits) |
    | --- | --- | --- |
    | `calibration` | Copilot, 2025 | 15.07 |
    | `calibration-codex` | Codex, 2025 | 6.63 |
    | `eval-2024-copilot` | 2024 days 13–19 | 20.43 |
    | `eval-2024-codex` | 2024 days 20–25 | 10.91 |
    | `bench-luna-2025`, `bench-luna-2024`, `bench-luna-2024b` | luna replays | 1.14, 3.41, 0.51 |
    | `bench-sol-2025`, `bench-sol-2025b`, `bench-sol-2024` | sol replays | 7.96, 5.00, 22.88; `bench-sol-2024` also holds 3.39 by the operator's decision |
    | `smoke-2025` | combined-config smoke test | 2.04 |
    | `drill-2025`, `drill-2025-quota`, `drill-2025-cred` | live failure drills (2026-09-29) | Copilot 4.44 + 0.78 (the held 26.09 was settled at 0); Codex 1.04 |
    | `drill-2025b`, `drill-2025b-quota` | drill rerun after the D024 fixes | Copilot 6.43 + 1.46; Codex 0.88 + 2.02 (the held 13.00 was settled at 0) |
    | `eval-2019` | AoC 2019, all days: 48/50 (EVALUATION.md) | Copilot 105.63; Codex 3.02 |
    | `bench-pi-2019` (on the Pi) | Pi replay benchmark, 6 days of 2019 | Copilot 26.54; Codex 0 |
    | `eval-2019b` | 2019 days 11 and 25 after D028: complete | Copilot 2.12; Codex 0 |
    | `bench-ocr-2019a`, `bench-ocr-2019b` | Codex replay of the letter-art parts | Codex 1.23843; 0 |
    | `finish-2024` | AoC 2024 days 2 and 4–12, all first-submission correct | Copilot 24.74; Codex 0 |
    | `drill-aoc-2024`, `drill-aoc-2024-bogus` (same storage), `drill-aoc-2024-dup` | live AoC drills, and A2b after D026 | Copilot 11.82492; Codex 0 |

  - **Allowance:** the operator's standing allowance is 300 per event and 100 per puzzle per config and provider, in native units. No provider-side caps are configured.
- **Host.** It sits behind a TLS-intercepting proxy. Prefix live commands with `NODE_EXTRA_CA_CERTS=/Users/benda/Work/ts/pki/ts_bundle.pem`. Docker builds need the CA as a BuildKit secret (SANDBOX.md). An image rebuild takes about 19 minutes through the proxy.
- **Checks.** `npm run check`: 187 offline tests, and credential-free CI on GitHub (`main` at `https://github.com/bendiscz/boc.git`). Pinned versions: Node 24 LTS, the Pi family 0.87.1, and `@earendil-works/pi-agent-core` as a direct dependency.

## Next session: start here

Read `AGENTS.md`, `REQUIREMENTS.md`, `DECISIONS.md`, and the docs listed in AGENTS.md. Run `npm ci --ignore-scripts` and `npm run check`.

Next concrete task: **finish the Raspberry Pi host (D027, [RPI.md](RPI.md)).** `boc@boc.local` is set up and passes every check (RPI.md, "Verification status"). **The Pi owns the credentials:** the Mac's copy was renamed to `.secrets-moved-to-pi/` (ignored), so live BoC commands now run on the Pi only (D022). Remaining:

- **Done (2026-09-30):**
  - Every systemd drill passed: `kill -9`, an outside SIGTERM, `systemctl stop`, and a reboot.
  - Daily checks (D029).
  - A Pi replay benchmark: 12/12; the Pi is 4.8× slower per core than the Mac, and no run came near the 60-second cap (EVALUATION.md).
- **Decided (2026-09-30):** `sandbox.maxRunSeconds` is configurable (default 60, at most 540), and the event config on the Pi sets 240.
- **The operator:** move the system from the SD card to an SSD before 1 December.
- **Afterwards:** the end-to-end rehearsal (milestone 7).

The open findings of the live AoC drills were decided and implemented on 2026-09-29 (D026).

Operator decision (2026-09-29): every held reservation was settled at 0 (`operator:2026-09-29-operator-instruction-settle-zero`), including the 3.39 in `var/bench/sol-2024` that was kept on 2026-09-28. No reservation is held. Rechecking site rules, provider policy, models, and credit semantics (milestone 7) happens a few days before AoC 2026, not now.

Decided (D020, 2026-09-28): keep `gpt-6-sol` as the solving model, with no parallel solving; Anthropic is dropped.

Other open items:

- an amd64 run of `npm run test:linux` (arm64 passed), and a bare-metal Linux host run before the event.

Live runs (provider calls, AoC requests, submissions) spend real credits: start them only with the operator's explicit go-ahead in that session, and under supervision. Replay benchmarks never contact AoC, but they still spend model credits. Preserve unknown-charge reservations, and never replace native credits with estimates that can overshoot (D016).

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
- [x] Parse puzzle/answer responses and handle authentication failures, part unlocks, cooldowns, duplicates, and ambiguous submissions. (Wording unvalidated against live responses; the final-day part 2 button is handled offline, see AOC.md.)
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

- [x] Ask for credential-file paths and perform the minimum required interactive authorization; never ask for pasted secrets. (`boc login` for Copilot and Codex; the operator re-authorized Codex on 2026-09-28.)
- [x] Validate actual subscription entitlements and credit reconciliation under a small explicit allocation. (Copilot and Codex, 2026-09-27; Anthropic deferred.)
- [x] Validate the dedicated AoC account/session and site conduct before submissions. (2025 days 1–2 fetched and submitted in the calibration run.)
- [x] Evaluate representative older puzzles privately; record correctness, credit usage, latency, and failure modes without consulting solutions. (AoC 2025 complete, EVALUATION.md; harder older days still worth evaluating.)
- [x] Turn discovered defects into synthetic regression tests and refine scheduling/solver strategy. (2026-09-28: runaway limits, refusal handling and failover, known-wrong proposals, umask modes, brake logging; see EVALUATION.md, "Defects found".)

### 7. AoC 2026 readiness

- [ ] Recheck site rules, event calendar, provider policy, models, and credit semantics.
- [ ] Exercise outages, quota exhaustion, process death, unknown charges, duplicate submissions, and expired credentials. (Offline drills in `test/drills.test.ts`. Live drills via replay ran on 2026-09-29, found defects A–D, and passed after the D024 fixes (EVALUATION.md). The AoC-side drills A1–A3 ran live on 2026-09-29: an expired session passes after D025, duplicate protection across storages passes, and a crash during submission loses the part (defect G, fixed by D026).)
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

Best-effort limits verification (2026-09-27):

- Operator decision recorded: best-effort limits, the proposed defaults, the provider cap recommended, Copilot first, and Anthropic added. REQUIREMENTS, AGENTS, README, FEASIBILITY, CONFIGURATION, OPERATOR, DECISIONS (D016, D017), and the example config are updated.
- `npm run check`: 127 offline tests passed. New coverage:
  - estimate padding, pricing input at the cache-write rate, and output-cap handling;
  - charge source precedence (provider, then derived, then estimated) with receipts;
  - a runaway stream cut off early, its upstream aborted and settled as estimated, and the guard still usable;
  - per-pool tolerance blocking, including the default 5 % and a configured zero;
  - other pools unaffected by an overshoot;
  - subscriptions without an estimate not used;
  - the provider-cap warning.

  Existing guard, ledger, and selection tests were updated to the new semantics.

Copilot adapter verification (2026-09-27):

- Read pi-ai 0.87.1's Copilot provider, its OAuth flow, and the three APIs it uses. The findings are in FEASIBILITY.md. Fetched the official GitHub Copilot models-and-pricing page (1 credit = $0.01; the rate conversion is recorded).
- `npm run check`: 134 offline tests passed. New coverage:
  - the adapter uses only the credential file, the token-derived endpoint, the enforced output cap, and `maxRetries` 0;
  - a single refresh is shared by concurrent requests and persisted `0600`, and refresh failures are sanitized with no token in the error;
  - unsafe files, a malformed credential, an unavailable model, a missing estimate, and an unknown model are refused;
  - the real Pi Copilot catalog is used with no network access at construction;
  - login writes only the credential file and never prints tokens;
  - the calibration report aggregates calls by charge source;
  - CLI checks for calibration mode and the login terminal requirement.
- No live Copilot or AoC request has been made.
- Independent review (child Pi, read-only), all addressed:
  - Login errors were hidden as "Command failed." They are now typed, with the provider reason bounded and token-like strings redacted.
  - A credential renewed on disk was ignored by a running adapter. It is now re-read before refreshing.
  - The calibration report did not show uncertain holds; it now counts them.
- The review also confirmed that the explicit `apiKey` prevents pi-ai's `COPILOT_GITHUB_TOKEN` environment fallback, and that adapter construction makes no network request.
- `npm run check`: 136 offline tests passed.

Copilot calibration and promotion (2026-09-27):

- Operator-run calibration as recorded in FEASIBILITY.md: passed.
- Promoted Copilot to `PRODUCTION_ADAPTERS`, and `providerReadiness` now reports it eligible.
- Adapters whose construction fails (missing or unsafe credential, zero rates) are now logged and skipped, so a run with no usable subscription still refuses to start. The adapter refuses zero rates before reading any credential, which keeps tests hermetic against the example config.
- `npm run check`: 136 offline tests passed.

Codex adapter verification (2026-09-27):

- Read pi-ai 0.87.1's Codex provider, OAuth, and responses API. Checked the official Codex authentication and pricing pages; the Help Center page returned 403. The findings and the Anthropic policy result are in FEASIBILITY.md.
- Refactored the Copilot adapter into a generic `oauth-adapter.ts`. `boc login` now supports Codex (device code chosen automatically) and refuses Anthropic.
- Errors before any output now settle at zero rather than at the full reservation.
- `npm run check`: 140 offline tests passed, including all Copilot tests unchanged after the refactor. New coverage:
  - Codex estimates using the assumed output maximum;
  - a credential without an account is refused;
  - Codex registered for calibration only, and Anthropic in no registry;
  - the real Pi Codex catalog provides `gpt-6-sol`;
  - device-code selection;
  - Anthropic login refused;
  - zero-charge early errors.
- The operator's Codex workspace does not allow device-code login. Added `boc login … --browser`: it prints the authorization URL, cancels the paste prompt when the localhost callback arrives, and never prints tokens. `npm run check`: 141 offline tests passed.

Codex calibration and promotion (2026-09-27):

- Operator-run calibration as recorded in FEASIBILITY.md. It passed by exact token reconciliation, since included usage debits no credits. Codex is promoted to `PRODUCTION_ADAPTERS` and reported eligible. `npm run check`: 141 offline tests passed.

Final-day part 2 handling (offline):

- The 2025 rehearsal ends on the event's final day (day 12), so part 2's button had to be handled before that run. See AOC.md, "Final day's part 2".
- `parsePuzzlePage` now exposes a hidden `answer` input (`fixedAnswer`). `AocService.answerForm` classifies a part's form as `answer`, `fixed`, or `none`, refetching once when a cached page has no form. `reconcile` treats a complete page without a part-2 answer as correct.
- Before any model call on part 2, the solve loop checks the form: a button becomes a model-free `orchestrator` attempt, and no form returns `needs-stars` with no spend.
- The page and response wording are from memory, not validated live. An unrecognized response goes to `uncertain`, and reconciliation reads the page once.
- `npm run check`: 143 offline tests passed. New tests: the button is pressed with only the part 1 model call admitted; missing stars spend nothing and succeed on a later run; hidden versus text answer inputs are parsed correctly.

Days 5–12 rehearsal (live, 2026-09-28, agent-run with the operator's go-ahead):

- Ran `boc run var/calibration.config.json --days 5,6,7,8` (Copilot), then `boc run var/calibration-codex.config.json --days 9,10,11,12` (Codex), both headless. Result: 16 of 16 parts correct, each on its first attempt and submission. The final-day button was validated live. Aggregates are in EVALUATION.md; private notes and logs are in `var/rehearsal/`.
- Defect: the bug-brake waits were silent and could not be aborted. Every wait is now logged through `onBrake`, and the wait is abortable in `boc run`; a regression test was added. `npm run check`: 143 offline tests passed.

Output cap tuning (offline, 2026-09-28):

- Measured output tokens from the ledger receipts: 92 calls, maximum 920. The private calibration configs were lowered from 16000 to 8000 `assumedMaxOutputTokens`; the code default remains 32000.
- Responses that hit the output cap (a provider `length` stop or the guard cutoff) are now logged per attempt. The system prompt asks for brief responses.
- CONFIGURATION.md now describes the setting's dual role correctly: the enforced cap on Copilot, and the reservation size plus cutoff on Codex.
- `npm run check`: 144 offline tests passed. The new test covers a truncated response that is reported and then retried.

AoC 2024 days 13–25 evaluation (live, 2026-09-28, agent-run with the operator's go-ahead):

- New private configs for event 2024 (300/100) and storage `var/eval-2024-*`. Result: 25 of 25 solvable parts correct on the first attempt, day 25 part 2 `needs-stars`, 20.43 Copilot and 10.91 Codex credits, and no output-cap hits. Aggregates are in EVALUATION.md; private notes are in `var/eval-2024/`. No code changes.

Replay benchmark and provider-refusal handling (2026-09-28):

- Added `boc replay` (`src/bench/replay.ts`). Tests cover: judging against accepted answers without contacting AoC; a virtual embargo; the solver never seeing the answer it is judged against; refusal of shared storage and of missing sources; and a tampered page that would leak an answer, refused before any model call.
- Live, with the operator's go-ahead: luna on 2025 days 1–12 and 2024 days 13–25, and sol on 2025 until the Codex token was invalidated. Results are in EVALUATION.md.
- Provider refusals (usage limit, rejected credential) now stop the part as `provider-unavailable` after one attempt, and the run stops. The raw error goes only into a private `provider-error.txt`. `npm run check`: 148 offline tests passed.

Benchmark completion and runaway fixes (2026-09-28):

- After the operator re-authorized Codex, the sol replays finished: 2025 days 10–12 in `var/bench/sol-2025b` and 2024 days 13–25; luna's two failed days were rerun in `var/bench/luna-2024b`. The comparison is in EVALUATION.md.
- Runaway responses are now stopped after 120 s, or after 60 s of stall, and settled like the credit cutoff. Attempts have a 10-minute deadline between turns. Cut-off partial output is kept privately, and the retry prompt explains the previous failure. `break-lock` also clears the run-state lock.
- `npm run check`: 151 offline tests passed. The new tests cover: slow and stalled streams, including an upstream that ignores the abort; a stalled response followed by an informed retry; the attempt deadline; and the run-state lock.
- Known-wrong proposals (already judged wrong, or contradicting a too-high/too-low bound) are refused back to the model within the attempt; the rule is shared with the submission check (`answerRejection`). `npm run check`: 152 offline tests passed.

Operator decisions and hash-pinned uv (2026-09-28):

- D020: keep `gpt-6-sol`, no parallel solving, Anthropic dropped. The plan, AGENTS, README, REQUIREMENTS, OPERATOR, and FEASIBILITY status lines are updated.
- `uv` is now installed from `sandbox/uv-requirements.txt` with `--require-hashes`, and the `UV_VERSION` build argument is removed. The image was rebuilt (arm64, about 19 min through the proxy; an earlier attempt failed once with a transient `cannot allocate memory` in Docker Desktop). Checks: the downloaded wheel hash matched the pin; an altered hash was refused (offline negative control); no build CA certificate is in the image; the executor probe with toolchains passed. All private configs point to the new image ID.
- Linux executor probe (`npm run test:linux`, `sandbox/linux-probe.sh`): a native Linux daemon in a digest-pinned `docker:dind` container, reachable only on an internal network, with the probe running as UID 1000 on ext4. It found a real defect: under umask 077 the workspace files were `0600`, unreadable by the container's UID. Fixed with explicit `fchmod`/`chmod`, and a regression test was added. Both umasks pass on arm64. `npm run check`: 153 offline tests passed.

Failover between subscriptions (D021, 2026-09-28):

- A provider refusal (usage limit or rejected credential) records the attempt as `refused`, which does not count toward the attempt cap. The part fails over to the next subscription in configuration order. The run loop skips a usage-limited subscription until its reset and a credential-rejected one for the rest of the day; it stops only when every subscription refuses. Anthropic was removed from the example config (D020). `npm run check`: 154 offline tests passed. The new end-to-end test covers two subscriptions on separate pools, the first rejecting its credential, over two days with an attempt cap of 1.

Readiness checks (D022, 2026-09-28):

- Forced OAuth refresh (`checkCredential`) and the AoC `/settings` session check run at start, at T−30 before each unreleased day, and at T−5 after a failure. A failed credential makes that subscription unavailable until a check passes; a credential refusal during a run triggers an immediate check.
- The tests exposed a selection bug: a repaired but refused subscription blocked failover because selection kept returning it first. The binding now receives the part's refused set as `exclude`.
- `npm run check`: 159 offline tests passed. New tests: session check classification and cookie re-read; forced refresh persisted and sanitized; start-check failover without a model call; refusal repaired by refresh; T−30 and T−5 timing with a fix picked up at T−5.
- Live, with the operator's go-ahead: one authenticated `GET /settings` through the real client's `checkSession()` returned HTTP 200 with the logged-in marker, and the check reported `ok`. Only the status, size, and marker presence were observed; no cookie or page content was printed. The logged-out response remains unverified by design (no unauthenticated request was made).

Operator alerts (D023, 2026-09-28):

- `src/alerts/notifier.ts` handles ntfy pushes and healthchecks.io pings from private files, and `boc alert-test` sends a test push and ping.
- Wired into the run: failed checks, failover, day summaries, stops, and errors, including preflight errors, which now alert too because the notifier is created first. Replay is silent.
- `npm run check`: 166 offline tests passed. New tests: file and URL validation; request format with title sanitizing, priority, and token; heartbeat URLs; deduplication and the rate limit with the suppressed notice; delivery failures logged without the destination; bounded flush; and run-level alerts for check failure, day summaries, failover, and a preflight error. Not live-tested.

Combined-config smoke test (live, 2026-09-28, with the operator's go-ahead):

- `replay var/smoke-2025.config.json` (a 2025 copy of the event config with storage `var/bench/smoke-2025`) on day 1. Both adapters loaded, and the start check passed: both credential files were rewritten by the forced refresh. Copilot was chosen first and solved both parts on the first submission (8.6 s and 15.1 s) for 2.04 AI credits; Codex spent 0.
- Not covered: the AoC `/settings` check (replay never contacts AoC; verified separately) and alert delivery (replay is silent; `boc alert-test` passed).

Test hermeticity fix (2026-09-28):

- Once the operator created `.secrets/ntfy-topic-url` and `.secrets/healthchecks-ping-url`, the example config's `../.secrets/` paths resolved to the real alert destinations. Three CLI tests ran `boc run` on the example in place. The "no eligible provider" test therefore likely sent a real urgent ntfy push and a healthchecks `/fail` ping on each full test run after the operator's alert test, and the aborted-run test a low-priority push. It also failed locally, although it passed in CI, where the files do not exist.
- Fixed: `hermeticExample()` in `test/cli.test.ts` redirects every secret path and the storage into an empty temp directory and asserts that no `.secrets` path remains. Rule for new tests: never run a command against a config whose secret paths can resolve to real files. `npm run check`: 166 offline tests passed.

Live failure drills (live, 2026-09-29, agent-run with the operator's go-ahead):

- Five drills via `boc replay` on AoC 2025 days 1, 2, 5, 6, 7, and 8; no AoC contact. New private configs: `var/drill-2025*.config.json`. Drill tooling and logs: `var/drill/` (the toggleable CONNECT proxy `proxy.mjs`, and a synthetic bogus Copilot credential in `var/drill/secrets/`).
- Passed: process death and resume (after a manual `break-lock`), and a rejected credential with failover at the start check.
- Found defects A–D (EVALUATION.md). Also found a drill-method artifact: Node's `NODE_USE_ENV_PROXY` loops on dropped CONNECT tunnels.
- No code changes; `npm run check`: 166 offline tests passed before the drills.

Outage handling and drill rerun (D024, 2026-09-29):

- Fixes A–D as recorded in D024. The operator chose the 6-hour retry window.
- `npm run check`: 174 offline tests passed. New tests:
  - outage failover without counting an attempt, with backoff;
  - waiting when every subscription is out, then solving, with one alert per part;
  - a persistent outage given up about 6 hours after release, after which the run continues with the next day;
  - an unreachable start check retried in time for the release;
  - credit exhaustion mid-attempt failing over;
  - stale-lock removal for a dead PID and for an earlier boot, while a live owner is kept with a clear error;
  - classification of outages versus credential rejections, and of refresh failures.
- Live rerun of drills 1–4 via replay, all passed (EVALUATION.md). Drill tooling: `var/drill/proxy.mjs` (`SIGUSR1` toggles a full outage, `SIGUSR2` a Copilot-only one, `down` starts in an outage) and `var/drill/run.sh`.

Live AoC drills and AoC resilience (D025, 2026-09-29, agent-run with the operator's go-ahead):

- Held reservations settled at 0 on the operator's instruction.
- Page adoption (`part-adopted`) and D025 implemented. `npm run check`: 179 offline tests passed. New tests:
  - adoption with no model call or submission;
  - the session check's `/about` probe;
  - resilient reads: backoff, waiting for a replaced cookie, a 15-minute recheck, the deadline, and answers never retried;
  - reconciliation retried after an outage.
- Live on AoC 2024, drills A1–A3 (EVALUATION.md): about 30 AoC requests in total, and a 10-minute gap between processes. Real submissions: day 1 (two correct answers) and the day 2 part 1 submission of unknown outcome.

Operator decisions on the AoC drills (D026, 2026-09-29):

- Option (b), one automatic resubmission after an unknown outcome, and a separate brake window for session checks. The rule change is in `answerRejection`; the prompt now lists such answers as "outcome unknown".
- `npm run check`: 181 offline tests passed. New tests:
  - one resubmission, then blocked after a second unknown outcome;
  - end to end, an interrupted submission resubmitted once and solved;
  - session checks braked in their own window.
- Live, with the operator's go-ahead: drill A2b (2024 day 3), a crash during a submission, then a resubmission judged correct. Both parts solved (EVALUATION.md).

AoC 2024 days 2 and 4–12 (live, 2026-09-29, agent-run with the operator's go-ahead): 20/20 correct on the first submission, 24.74 Copilot credits (EVALUATION.md). Idle sleep on the development Mac paused the run once.

Raspberry Pi deployment files (D027, 2026-09-29):

- Added `docs/RPI.md` and the files in `deploy/rpi/`: `setup.sh`, `boc.service`, `check.sh`, `push-image.sh`, and `push-private.sh`.
- Verification without a Pi:
  - shellcheck (`-s sh`) is clean on all scripts;
  - `setup.sh` ran end to end in a `debian:trixie` arm64 container, with only `systemctl`, `timedatectl`, and `ufw` stubbed. That covered Docker's apt repository, the Node.js 24.21.0 checksum, the `boc` user, the clone and build, the `boc` wrapper, and the unit installation;
  - the generated unit passes `systemd-analyze verify`.
- Not run on real Pi hardware yet.

AoC 2019 evaluation (live, 2026-09-29, agent-run with the operator's go-ahead): 48/50 parts, 47 on the first submission; day 11 part 2 lost to misread ASCII-art letters (defect H). Two real Copilot outages were handled as D024 intends. Copilot 105.63, Codex 3.02 (EVALUATION.md).

Letter-art decoding (D028, 2026-09-29):

- Prompt guidance and the hash-pinned `advent-of-code-ocr` library; the image was rebuilt and every private config updated.
- Fixed pressing the final-day button after an adopted part 1 (no input), with a regression test. `npm run check`: 182 offline tests passed.
- Live, with the operator's go-ahead: 2019 day 11 part 2 and the day 25 button. AoC 2019 is complete. A Codex replay of day 8 part 2 used `convert_6` (EVALUATION.md).

Raspberry Pi setup (live, 2026-09-29):

- The operator ran `setup.sh` on `boc.local`. The agent then pushed the image and the private files, and ran `check.sh`, the probe, a memory-limit test, and a start-check smoke test (no model calls; one AoC read per run). Results are in RPI.md.
- **Defect I:** the smoke test showed `TimeoutOverflowWarning`. A wait longer than 2^31-1 ms (about 24.8 days, here about 62 days to the 2026 pre-release check) fired after 1 ms. BoC would have fetched unreleased puzzles and ended with exit 0, which systemd does not restart. It was stopped before any puzzle request.
  - Fixed: the pre-release waits use `sleepUntil` (wall-clock steps of at most 60 s), and `abortableSleep` splits long delays. Regression tests were added.
  - `npm run check`: 185 offline tests passed. The smoke test was rerun on the Pi: it kept waiting and stopped cleanly on SIGTERM.

systemd restart drills and daily checks (2026-09-30):

- On the Pi, with `boc.service` enabled by the operator:
  - `kill -9` of BoC: systemd restarted it after 60 s, the new run removed both stale locks, and the start check passed.
  - `kill -TERM` from outside systemd: a clean stop with exit 130 and no locks left, then a restart after 60 s and a passing start check.
- D029: daily readiness checks during long waits. `npm run check`: 186 offline tests passed. The new test covers two daily checks, a rejected credential found by one of them (urgent alert, `/fail`), and recovery at T−30.

Pi replay benchmark (live, 2026-09-30, with the operator's go-ahead; the service was stopped for it): 2019 days 12, 16, 18, 20, 22, and 24, 12/12 first-submission correct, Copilot 26.54. The Pi is 4.8× slower per core. EVALUATION.md has the run-time headroom analysis.

