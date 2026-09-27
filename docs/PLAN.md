# Development plan and session handoff

## Current state

- Documentation-only bootstrap; no implementation or test suite yet.
- Repository: `https://github.com/bendiscz/boc.git`, branch `master`.
- The operator clarified credit-only budgets, multiple subscriptions, runtime prohibition on retrieving solutions, and an AI/bot-permitted private leaderboard.
- No BoC provider credentials or AoC cookie have been requested or used. No live puzzle was fetched or answer submitted.
- Feasibility inspection found Node.js `v24.21.0`, npm `11.19.0`, and Pi `0.87.1` in the development environment. These are observations, not selected support versions.
- Original `init.md` is replaced by the English project documentation and retained in Git history.

## Next session: start here

Read `AGENTS.md`, `REQUIREMENTS.md`, and `DECISIONS.md`, then begin milestone 1. The immediate task is a provider-credit and isolation feasibility spike followed by a minimal TypeScript project skeleton. Work offline where possible. Do not start potentially chargeable experiments without explicit credential configuration and a safe credit allocation.

Prioritize early discovery of a subscription that cannot satisfy hard credit accounting. Report a real incompatibility instead of building an apparently budget-safe adapter over estimates that can overshoot.

## Milestones

### 1. Validate foundations and establish the project

- [ ] Read current installed Pi SDK docs and relevant examples; choose and pin supported Node.js/Pi versions.
- [ ] Investigate each requested provider's current authentication, enterprise restrictions, credit definition, usage reporting, and conservative per-call bound. Record sources and clearly separate documented from experimentally verified behavior.
- [ ] Verify a pre-dispatch enforcement point that covers all Pi calls, including retries, compaction, and auxiliary work. Disable hidden/unaccounted chargeable behavior until guarded.
- [ ] Define subscription identity, native credit units, pool allocation, and budget configuration semantics.
- [ ] Choose a feasible generated-code sandbox and controlled dependency-acquisition mechanism; document host prerequisites.
- [ ] Scaffold TypeScript, package scripts, lockfile, formatting/linting, type checks, offline tests, and CI. CI must not need private credentials or puzzle data.
- [ ] Add validated non-secret configuration examples with credential-file paths only.

### 2. Durable state and credit admission

- [ ] Define event/puzzle/attempt identifiers, state transitions, and private artifact layout with a readable index.
- [ ] Implement atomic persistence, structured events, recovery, and single-writer/concurrency coordination.
- [ ] Implement exact credit arithmetic, atomic multi-limit reservations, reconciliation, and conservative handling of uncertain calls.
- [ ] Test concurrent admissions, exhaustion, restart/crash cases, separate credit pools, and unaccounted-operation rejection.

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
- There is no application to test yet. No live provider or AoC validation has been performed.
