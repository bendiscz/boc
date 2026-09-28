# BoC development instructions

## Mission

Build **Bot of Code (BoC)**, an autonomous Advent of Code contestant, in TypeScript on Node.js using the Pi Agent Harness. All project content, code, commits, and user-facing output must be in English.

Read `README.md`, `docs/REQUIREMENTS.md`, and `docs/PLAN.md` before continuing work. Read `docs/DECISIONS.md` before changing architecture. A fresh session prompted with **“go on”** should continue the next unchecked task in the plan without needing earlier chat history.

## Working autonomously

- Make steady progress with minimal user intervention. Ask only for genuinely blocking decisions, credentials, permissions, or external actions.
- Keep the plan, decisions, verification results, and next concrete task current before ending a session.
- Use available Pi tools and extensions appropriately. Delegate bounded implementation, investigation, or independent review when useful; avoid overlapping file ownership and never give children secrets unnecessarily.
- Read the installed Pi SDK documentation and relevant examples before implementing integrations. Verify actual installed APIs rather than relying on remembered signatures.
- Prefer small, tested increments and clear commit messages. Commit and push completed increments to `origin`; never force-push or overwrite unrelated work. Report push failures honestly.
- Do not claim live provider/AoC verification when only mocks or offline tests have run.

## Non-negotiable boundaries

- Never fetch, search for, copy, or consult existing puzzle solutions, including immediately after release. Solver network and filesystem access must enforce this restriction, not merely request it in a prompt.
- General-purpose algorithms and freely available libraries are permitted. Keep package acquisition separate from unrestricted solver browsing.
- Load secrets from private files. Never commit tokens, cookies, credentials, or resolved secret values. Do not expose them to solver prompts, child processes, logs, or error messages.
- Keep AoC puzzle text, inputs, raw responses, and transcripts containing them out of Git. Use synthetic fixtures in committed tests. Do not publish private runtime artifacts.
- Only the trusted orchestrator may authenticate to AoC and submit answers. Cache downloads, obey cooldowns, avoid aggressive polling, and prevent duplicate submissions.
- The private leaderboard permits AI and bots. Recheck relevant AoC terms before live integration and before each event; this permission does not override site rules.
- Budgets are **AI credits**, not token, request, time, or monetary budgets. Enforce configured per-puzzle, event-wide, and subscription-specific limits across all workers and restarts.
- Limits are **best effort** (operator decision, D016): BoC does not guarantee never exceeding them but must match them as exactly as practical. Reserve a padded estimate before every potentially chargeable operation, including retries, compaction, auxiliary calls, and concurrency. Record actual charges with their source, cut off runaway responses, and block a pool when its unacknowledged overshoot exceeds its tolerance. Unknown costs are never zero; refuse work when no estimate can be made.
- Providers: GitHub Copilot (calibrated), ChatGPT/Codex (calibrated), and Anthropic (deferred: API key only; never Claude subscription OAuth, D019). Do not assume credits from different subscriptions are interchangeable. Do not evade provider limits or enterprise policy by switching accounts.
- Treat generated code and remote content as untrusted. A working directory and a prompt are not a security sandbox. Keep credentials and unrestricted networking outside generated-code execution.

## Current stage

The offline foundation has a configuration-checking CLI, exact credit values, a restrictive Pi settings profile, a provider-stream admission guard proven with a fake-provider Pi session, a durable journal-backed four-counter credit ledger with ledger-backed admission (D012), a validated run-state journal with private artifact layout and status CLI (D013), an offline-only AoC transport (D014, `docs/AOC.md`), a solver agent loop with constrained tools over `pi-agent-core` (D015) plus the solve-loop orchestrator, subscription selection, and a fail-closed `boc run` command. The GitHub Copilot and Codex adapters passed live calibration on 2026-09-27 and are the production adapters; others must pass supervised calibration (`--calibrate`, D018) first, a networkless Docker executor and toolchain image (`docs/SANDBOX.md`), and tests. This development host sits behind a TLS-intercepting corporate proxy: Docker builds need the operator's CA bundle as a BuildKit secret (`--secret id=extra_ca,src=/Users/benda/Work/ts/pki/ts_bundle.pem`, see `docs/SANDBOX.md`); never copy the bundle into the repository or an image layer. Live Node.js requests on this host need `NODE_EXTRA_CA_CERTS` set to the same bundle. Run `npm ci --ignore-scripts` and `npm run check`. An opt-in synthetic Docker probe is documented in `docs/FEASIBILITY.md`. No live provider adapter, production credit meter, solver, or AoC client exists yet. Read `docs/OPERATOR.md`, `docs/CONFIGURATION.md`, `docs/FEASIBILITY.md`, `docs/AOC.md`, and `docs/SANDBOX.md` alongside the plan before continuing. Do not mistake valid configuration or offline ledger tests with fake meters for live credit-budget enforcement.
