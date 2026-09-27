# Decisions and feasibility notes

## D001 — Documentation-first bootstrap

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
