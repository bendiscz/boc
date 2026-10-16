# GPT-6.1 Sol comparison and Node 26 rollout

Requested 2026-10-16. **Production still runs Node 24.21.0 and GPT-6 Sol.** The service is active; no live model comparison or runtime replacement may run until the operator stops it. This request authorizes the model evaluation, but not unbounded spending or concurrent credential use.

## Node 26: offline implementation

- Development default: **26.11.1**, with Node types **26.6.5**. Package engines also retain **24.21.0+ within 24.x** for rollback; Node 25 and 27 are not supported.
- CI covers Node 24.21.0 and 26.11.1 on Linux and macOS; all four jobs passed at `02708e6` ([run 38931635552](https://github.com/bendiscz/boc/actions/runs/38931635552)). Pi setup defaults to 26.11.1, and preflight checks both supported ranges including minimum versions.
- Node 26.11.1 / npm 11.20.0: clean install, lint, type checking, **212 tests**, build, audit (zero findings) and Docker executor/toolchain probe pass on the Mac.
- Node 24.21.0 / npm 11.19.0: clean install and full check also pass with the new lockfile/types. Two test diagnostics needed a non-undefined assertion message under the newer Node typings. No application source change was needed.
- The official arm64 Node 26.11.1 archive and Node 24.21.0 rollback archive are staged on the Pi in `var/deploy/node26-20261016/`, verified against their respective official `SHASUMS256.txt` files. A private extracted candidate runs `--version` successfully; `/usr/local/bin/node` is still 24.21.0. No credentials were touched and no service was stopped.

**Release status:** Node 26.11.1 is Current, not yet LTS. The official schedule lists LTS on **2026-10-28**. This is an explicitly requested move to the next even-numbered line, not a claim that 26 is already LTS. Sources: [26.11.1 release](https://nodejs.org/en/blog/release/v26.11.1), [release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), checked 2026-10-16.

This increment upgrades the **trusted host/orchestrator runtime**. The digest-pinned solver image and its Node 24 toolchain remain unchanged; upgrading generated-code toolchains is a separate image rebuild/probe, not necessary to run BoC on Node 26.

## GPT-6.1 Sol: pricing evidence and comparison design

The Pi 1.3.0 catalogs and offline wire tests already support `gpt-6.1-sol` on both BoC providers. Catalog presence is not authenticated account entitlement. **No GPT-6.1 Sol call has been made yet.**

Official rates fetched 2026-10-16 (native credits per million tokens):

| Provider/model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| Copilot GPT-6 Sol, ≤272K input | 200 | 20 | 250 | 1000 |
| Copilot GPT-6.1 Sol, ≤272K input | 200 | 10 | 250 | 1000 |
| Copilot GPT-6.1 Sol, >272K input | 400 | 20 | 500 | 1500 |
| Codex GPT-6 Sol, Standard | 50 | 5 | 0 | 250 |
| Codex GPT-6.1 Sol, Standard | 50 | 2.5 | 0 | 250 |

Copilot converts USD token prices at **100 AI credits per dollar**; Codex publishes native Standard credit rates directly. Do not derive Codex subscription credits from OpenAI API-dollar prices. Input/output prices are unchanged; cached input is half the price. That does not establish equal total task costs or performance.

Sources: [GitHub Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), [Codex pricing and token rates](https://developers.openai.com/codex/pricing). Codex also states that published credit rates do not determine included subscription usage by themselves; comparison is not billing reconciliation. Recheck against the account dashboard where possible.

### Supervised comparison after the service is stopped

1. First compare both models on the **existing Node 24 runtime**. This isolates model effects from the Node upgrade. Never test both changes simultaneously and attribute the difference to one.
2. Use sequential replays, no AoC traffic or submissions, with separate ignored configs/storage. Only the existing private-file credentials are used, on the Pi, one process at a time. Account refusal ends that provider's candidate lane; do not evade it or substitute another account/auth flow.
3. Candidate sets: **2019 days 8, 14 and 25** (letter art, arithmetic boundary, interactive/tool-heavy task) and **2024 days 15 and 24** (harder algorithmic tasks). Sources: the existing Pi caches/configs listed in PLAN.md. Day 25's model-free button is not scored. Use `low` reasoning and 32000 output assumptions for both models. Compare the same parts and budgets, not just one easy puzzle.
4. Aggregate comparison allowance: **at most 300 native credits per provider**, best effort, across old/new models and both source years. Four private configs per provider (two models × two years), each capped at **75 event / 75 per puzzle**; their configured limits sum to 300. Provider units remain separate. At most one attempt and six turns per part; retain uncertain charges and stop that lane on unresolved accounting. Small contexts must stay below the short-context pricing threshold: add an explicit conservative pre-dispatch context bound to the comparison harness, inspect reported usage, and do not activate a model in production without safe long-context pricing/handling. No unknown or zero prices.
5. Record first-proposal correctness, finished parts, errors/timeouts, wall time, turns, native spent/held credits, actual/estimate ratios, and maximum reported input including cache tokens. Keep puzzle-bearing evidence private. A single sample per part is noisy; repeat discriminating cases only if the aggregate remaining allowance permits.
6. Prefer GPT-6.1 Sol only if entitlement works, accuracy is not worse on the representative set, and cost/latency are acceptable. A small speed difference is not conclusive. Copilot and Codex may have different outcomes; do not assume both should switch together.
7. Before switching, confirm native rates/accounting, address long-context tiers (current config has flat rates), back up the event config privately, and preserve provider/pool/subscription identities and existing journals. Keep `low`, the output assumption, event limits and provider order unchanged. New model activation is conditional, not automatic.

## Pi maintenance sequence and operator actions

1. **Operator:** `sudo systemctl stop boc`. Agent verifies PID 0/no other BoC process before replays or other credential-using commands.
2. Run the model comparison above on Node 24 and record its results before any runtime replacement.
3. **Operator root action:** install the verified Node 26 archive into `/usr/local` (the current unit and `boc` wrapper use `/usr/local/bin/node`). Do not rerun the full `setup.sh` merely to upgrade Node: it also upgrades the OS, touches the unit and firewall, and rebuilds BoC. The staged Node 24 archive is the rollback path. A bounded installation command will be supplied after the service-stop verification; verify the staged checksum immediately before extraction.
4. Deploy the green-CI revision with `git pull --ff-only`, `npm ci --ignore-scripts`, and `npm run check` under Node 26. Run `check.sh --probe`, read-only event status, and bounded current/selected-model provider replays in fresh storage. Check readiness and alerts with the event config unchanged unless a model switch has independently passed its gates.
5. On any regression, keep the service stopped, restore the Node 24 runtime and compatible application/config revision, and retest. Never roll back rotated OAuth credentials or reset journals/held charges.
6. **Operator:** restart `boc.service`. Verify active state, start check, waiting state, credits, notification receipt and next daily check. Avoid unattended live experiments.

## Next concrete task

Node 26 support is implemented, pushed and green in CI. Have the operator stop the service for model evaluation. Live benchmarks, the model-switch decision and the root-owned Node upgrade are pending; the running Pi is unchanged.
