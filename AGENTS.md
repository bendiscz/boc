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

BoC works end to end. The two production adapters, GitHub Copilot and ChatGPT/Codex, passed supervised live calibration on 2026-09-27 (AoC 2025 days 1–4 solved). Anthropic is deferred until an API key exists; never use Claude subscription OAuth (D019). The architecture is recorded in `docs/DECISIONS.md` (D001–D019). The current state and the next task are in `docs/PLAN.md` under "Next session: start here".

Run `npm ci --ignore-scripts` and `npm run check`. Read `docs/OPERATOR.md`, `docs/CONFIGURATION.md`, `docs/FEASIBILITY.md`, `docs/AOC.md`, and `docs/SANDBOX.md` alongside the plan before continuing.

This development host sits behind a TLS-intercepting corporate proxy:

- Docker builds need the operator's CA bundle as a BuildKit secret (`--secret id=extra_ca,src=/Users/benda/Work/ts/pki/ts_bundle.pem`; see `docs/SANDBOX.md`). Never copy the bundle into the repository or an image layer.
- Live Node.js requests need `NODE_EXTRA_CA_CERTS` set to the same bundle.

Private runtime files exist only locally and are ignored by Git:

- `.secrets/aoc-session`, `.secrets/copilot.json`, and `.secrets/codex.json`. Never read, print, or copy their contents.
- The calibration configs `var/calibration.config.json` (Copilot) and `var/calibration-codex.config.json` (Codex), with their storage under `var/calibration*/`.

Live runs spend real credits and submit real answers. Start them only with the operator's explicit go-ahead, within the operator's current allowance (see the plan), and never without supervision.
