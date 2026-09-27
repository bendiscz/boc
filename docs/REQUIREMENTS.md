# Requirements

This document replaces the original `init.md` specification, retained in Git history, and incorporates the operator's subsequent clarifications.

## Product

1. BoC is an autonomous programming contestant. It waits for new AoC puzzles, then attempts to solve them as quickly as practical within safety and credit constraints. Solving every puzzle or winning is not guaranteed.
2. Use TypeScript on Node.js, built on the Pi Agent Harness. Pin and verify dependencies during implementation.
3. Provide a simple English terminal UI showing current puzzle, phase, provider, credit usage/reservations, and results. Persist enough state that the UI is not required for recovery.
4. Store detailed progress, generated solutions, test results, answer attempts, and final outcomes in readable, navigable local files. Provide a human-readable run summary alongside structured events and state.
5. Authenticate AoC requests using an externally supplied session cookie loaded from a private file. Fetch puzzle statements and inputs, submit answers, and handle part unlocks, incorrect answers, cooldowns, expired sessions, and transient failures.
6. Support GitHub Enterprise Copilot and ChatGPT Business/Codex subscriptions. Use multiple configured subscriptions effectively, subject to their capabilities, credit budgets, usage policies, and availability. ChatGPT subscription access is not ordinary OpenAI API credit.
7. Generated solutions may use installed Python via `uv`, Node.js, Go, or Rust. General-purpose algorithms and freely available libraries are allowed.
8. Develop and evaluate using older AoC puzzles on a new dedicated account; prepare for the 2026 event. Do not hardcode an unverified future event calendar or number of days.

## AI-credit budgets

The operator clarified that the only budget metric is **AI credits spent**. Tokens, request counts, elapsed time, and currency are not substitute budget metrics, though they may be useful telemetry or safety controls.

- Support configurable per-puzzle and event-wide limits, with separate limits for different subscriptions.
- Charge all BoC AI activity to an explicit subscription, event, and puzzle or explicitly budgeted event-overhead scope. No unaccounted planning, retries, summaries, compaction, or auxiliary agents.
- Define exactly what a provider calls a credit and how it is charged. Record pricing/accounting versions and any model-dependent multipliers.
- Preserve native credit units per subscription. A cross-subscription scalar limit is valid only if an explicit, justified conversion policy exists; otherwise represent the event/puzzle budget as separate credit pools.
- Before dispatch, atomically reserve a conservative maximum charge against every applicable limit. Reconcile only when authoritative usage establishes the actual charge. Track spent and reserved credits durably.
- Include concurrent calls and crash recovery. Unknown outcomes retain their reservations until reconciled; do not automatically retry potentially charged calls as if free.
- Reject chargeable work when costs, remaining allocation, or reservation safety cannot be established. A final usage counter or a post-response abort alone cannot enforce a hard ceiling.
- Admission checks must cover Pi's automatic internal calls as well as explicit application prompts.
- Switching subscriptions cannot bypass an event/puzzle limit, provider restriction, or enterprise policy.
- Application limits govern BoC's attributable usage. A shared provider account's overall ceiling additionally needs provider-side enforcement or an exclusive allocation.

Each provider adapter must prove that these semantics are possible before it is enabled for autonomous paid operation. If a required subscription cannot expose or bound its credit charge, report the incompatibility rather than silently weakening the requirement.

## Originality, privacy, and site conduct

- Never fetch or consult existing solutions, including freshly published solutions during a live event. Enforce network and tool restrictions so that generated code cannot bypass this rule.
- Historical models may have seen old puzzles in training; absolute training-data originality is not promised. The main originality goal is independent solving of newly released puzzles without external solution retrieval.
- The operator's private leaderboard explicitly permits AI and bots. AoC discourages AI solving; continue to respect its site rules and avoid presenting BoC as human participation.
- Do not publish puzzle statements, personal inputs, or transcripts/raw responses containing them. Keep such files in ignored private storage; committed tests use synthetic fixtures.
- Cache downloads, use an identifiable client, obey server cooldowns and request limits, and avoid wasteful polling. Do not guess or spam answers. Treat ambiguous submission outcomes conservatively.
- Keep solver networking separate from trusted AoC and model-provider access. Fetching general libraries must not open an unrestricted channel to puzzle solutions.
- Secrets are read from private files, never committed, printed, or included in model context. Restrict credential permissions and redact diagnostics. Redaction is defense in depth, not permission to log secrets.

## Acceptance gates

- Offline tests cover calendar scheduling, AoC response handling, two-part progression, duplicate prevention, restart recovery, and file persistence.
- Budget tests cover concurrency, exact boundaries, mixed subscription pools, retries, unknown usage, internal Pi calls, crashes, and fail-closed behavior.
- Security tests verify credential separation, artifact exclusion from Git, and solver network restrictions.
- TUI and headless operation expose truthful state, failures, and credit accounting.
- Provider tests distinguish mocked behavior from authenticated evidence and document actual credit semantics.
- Authorized live tests solve selected older puzzles end to end, retain private evidence, and measure correctness, speed, and credits without retrieving solutions.
- Event readiness includes restart and outage drills, credential checks, accounting checks, verified scheduling, and an operator guide.
