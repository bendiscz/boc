# Bot of Code

**BoC** is a planned autonomous Advent of Code contestant, built with TypeScript, Node.js, and the [Pi Agent Harness](https://github.com/earendil-works/pi).

It will wait for a puzzle to unlock, download the authenticated puzzle and input, develop and test its own solution, and submit answers while respecting AI-credit budgets. A simple terminal UI will show progress; private, navigable files will retain the detailed run history and results.

The target is Advent of Code 2026, with development and evaluation against earlier puzzles on a dedicated account. The operator's private leaderboard permits AI and bots.

## Planned capabilities

- GitHub Enterprise Copilot (first), ChatGPT Business/Codex, and Anthropic integrations, subject to actual account access and provider policy.
- Effective use of multiple available subscriptions, with separate credit accounting and budget-aware scheduling.
- Configurable per-puzzle and event-wide AI-credit limits, including subscription-specific limits.
- Python (`uv`), Node.js, Go, and Rust solution toolchains.
- Recoverable runs, detailed local artifacts, and a lightweight TUI.
- No retrieval of existing solutions, no publication of AoC puzzle text or inputs, and file-based secrets kept outside Git.

**Budget safety (best effort):** each call reserves a padded cost estimate against every limit before it starts. Actual charges come from the provider, from token usage, or from the estimate, and each is labelled with its source. Runaway responses are cut off, and a pool blocks once its overshoot passes a tolerance. BoC tries to match limits as exactly as practical but does not guarantee never exceeding them. A provider-side spending cap is the recommended hard backstop. Limits cover BoC's activity only.

## Status

The offline TypeScript foundation is implemented: configuration checking, exact credit representation, conservative Pi settings, a guarded provider-dispatch boundary, a durable four-counter credit ledger, a durable puzzle run-state machine with private artifact views, an offline-tested AoC transport (no live AoC access yet), a constrained solver agent loop with a two-part solve orchestrator and budget-aware subscription selection, a networkless Docker executor with a toolchain image, and offline tests. Live solving, provider requests, AoC access, and the TUI are not implemented yet. Both subscription adapters remain disabled pending enforceable credit accounting.

Requires Node.js 24.21+ within the 24 LTS line and npm:

```sh
npm ci --ignore-scripts
npm run check
node dist/main.js check-config examples/boc.config.json
node dist/main.js status examples/boc.config.json   # read-only; see CONFIGURATION.md
node dist/main.js run examples/boc.config.json      # refuses: no eligible provider adapter yet
```

Configuration checking reads no credentials and makes no network requests. Example budgets and model IDs are placeholders, not verified provider allocations.

- [Operator guide](docs/OPERATOR.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Provider, Pi, and isolation feasibility findings](docs/FEASIBILITY.md)
- [AoC access and site conduct](docs/AOC.md)
- [Solver sandbox and toolchain image](docs/SANDBOX.md)
- [Requirements and acceptance criteria](docs/REQUIREMENTS.md)
- [Development plan and handoff](docs/PLAN.md)
- [Decisions and feasibility notes](docs/DECISIONS.md)
- [Instructions for continuing development](AGENTS.md)

To continue development in Pi, open this repository and say **“go on”**.

## Private data

Use `.secrets/` for local credential files and `var/` for runtime artifacts, or configure paths outside the repository. Both directories are ignored. Configuration examples contain paths and placeholders only, never real credentials. Puzzle-bearing artifacts and transcripts remain private even if they contain no credentials.

Do not supply secrets in chat or Git. Live testing will require a dedicated AoC session-cookie file and authorized provider credential files; these are not needed for the initial offline implementation.

## License

See [LICENSE](LICENSE). This repository's license does not cover Advent of Code puzzle text, inputs, or other third-party content.
