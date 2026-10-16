# GPT-6.1 Sol comparison and Node 26 rollout

Requested 2026-10-16. **The rollout is running: the operator restarted the service at 2026-10-16 18:07:47 UTC, and its start check passed at 18:07:50 UTC.** The Pi's global runtime is now **Node 26.11.1**, independently verified after the operator's installation, and the event config now selects **GPT-6.1 Sol on both providers**, after successful target-runtime smoke checks. The reported `node -v` of 26.11.1 did not reflect `/usr/local/bin/node` on the Pi. Global installation and service restart are verified; only post-restart observation remains. The verified Node 24 rollback archive remains staged.

## Node 26: offline implementation

- Development default: **26.11.1**, with Node types **26.6.5**. Package engines also retain **24.21.0+ within 24.x** for rollback; Node 25 and 27 are not supported.
- CI covers Node 24.21.0 and 26.11.1 on Linux and macOS; all four jobs passed at `02708e6` ([run 38931635552](https://github.com/bendiscz/boc/actions/runs/38931635552)). Pi setup defaults to 26.11.1, and preflight checks both supported ranges including minimum versions.
- Node 26.11.1 / npm 11.20.0: clean install, lint, type checking, **212 tests**, build, audit (zero findings) and Docker executor/toolchain probe pass on the Mac.
- Node 24.21.0 / npm 11.19.0: clean install and full check also pass with the new lockfile/types. Two test diagnostics needed a non-undefined assertion message under the newer Node typings. No application source change was needed.
- The official arm64 Node 26.11.1 archive and Node 24.21.0 rollback archive are staged on the Pi in `var/deploy/node26-20261016/`, verified against their respective official `SHASUMS256.txt` files. A private extracted candidate runs `--version` successfully; `/usr/local/bin/node` is still 24.21.0. No credentials were touched and no service was stopped.

**Release status:** Node 26.11.1 is Current, not yet LTS. The official schedule lists LTS on **2026-10-28**. This is an explicitly requested move to the next even-numbered line, not a claim that 26 is already LTS. Sources: [26.11.1 release](https://nodejs.org/en/blog/release/v26.11.1), [release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), checked 2026-10-16.

This increment upgrades the **trusted host/orchestrator runtime**. The digest-pinned solver image and its Node 24 toolchain remain unchanged; upgrading generated-code toolchains is a separate image rebuild/probe, not necessary to run BoC on Node 26.

## GPT-6.1 Sol: pricing evidence and comparison design

The Pi 1.3.0 catalogs and offline wire tests already support `gpt-6.1-sol` on both BoC providers. Catalog presence is not authenticated account entitlement. **Live entitlement and a bounded comparison now pass on both providers; see results below.**

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

## Same-runtime comparison results (2026-10-16)

All eight lanes ran sequentially on the Pi with **Node 24.21.0 / Pi 1.3.0**, `low`, 32000 output assumptions, one attempt and six turns per part. Source caches were the accepted-answer replay storages `bench-hard-{2019,2024}-low`; only puzzle pages/input were exposed to the solver, not source solution code or accepted answers for the part being solved. No AoC requests or submissions occurred.

| Provider | Model | Correct / scored | Calls | Derived native credits | Total wall seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Copilot | GPT-6 Sol | 7/9 | 29 | 17.99952 | 118.7 |
| Copilot | GPT-6.1 Sol | 9/9 | 22 | 14.57630 | 137.2 |
| Codex | GPT-6 Sol | 8/9 | 29 | 6.39848 | 123.0 |
| Codex | GPT-6.1 Sol | 9/9 | 21 | 4.41085 | 128.3 |

Every scored correct part was correct on the first proposal. The old-model incompletions made **no wrong proposals**: the six-turn test cap ended 2019 day 25 on both providers and 2024 day 24 part 2 on Copilot. Production has a looser turn cap, so these are constrained-task completions, not demonstrated general accuracy failures. One sample per part is noisy; total times include incomplete old-model attempts and are not directly comparable completion-speed measures. The new model was not consistently faster, but completed more within the turn cap using about 19% fewer Copilot credits and 31% fewer Codex credits.

All charges were usage-derived at published native rates, **not independently reconciled with account billing dashboards**. No held charges remained. Maximum context was 52073 serialized bytes (pre-dispatch ceiling 200000); maximum reported input including cache was 8166 tokens. Maximum actual/reservation ratio was below 0.039. Only numeric metrics/outcomes are documented; puzzle-bearing artifacts stay private on the Pi.

Private configs: `var/sol61-{copilot,codex}-{old,new}-{2019,2024}-20261016.config.json`; storage under `var/bench/` with the same stem; driver `var/sol61-compare-20261016.mjs`; safe metric summaries/index under `var/deploy/sol61-node26-20261016/`. All completed allocations were closed by lowering event/per-puzzle limits to their final spent amounts, without touching journals. Total comparison spend: **32.57582 Copilot** and **10.80933 Codex**. A subsequent smoke cap of 100 per provider keeps cumulative authorized exposure below 300 per provider.

**Selection applied:** GPT-6.1 Sol is configured for both providers after passing target-runtime smoke and readiness. D034 adds optional long-context rates: reserve/cut off at worst category rates, settle at the tier selected by reported input including cache (strictly above threshold). Copilot production must explicitly configure 272000 and the published high-tier rates; its conservative minimum attempt headroom rises to 78 credits. The feature passes **216 tests** locally on both Node versions and on the Pi's private Node 26 runtime. Independent read-only review found no issue; all four Linux/macOS × Node 24/26 CI jobs passed at `27de39f` ([run 38934703130](https://github.com/bendiscz/boc/actions/runs/38934703130)). The Pi is built from that revision.

### Target-runtime verification and config switch

Using the staged official Node **26.11.1** arm64 candidate on the Pi (not the still-24 global binary), clean install, all 216 tests, build, audit (zero findings) and full sandbox/toolchain preflight passed. Sequential GPT-6.1 Sol replays of cached 2019 day 12 passed both parts on the first proposal on each provider using the final tier-aware pricing policy. Charges: **2.51428 Copilot / 1.12795 Codex**, no holds. All test allocations are now closed at actual spending. Cumulative comparison plus smoke: **35.09010 Copilot / 11.93728 Codex**, below the aggregate 300/provider allowance.

The event config was changed atomically while the service was stopped, after checking the old checksum. Only model/rate policy changed: both `gpt-6.1-sol`; Copilot cache-read 10 plus the 272000 long tier; Codex cache-read 2.5; new pricing labels. Identities, order, credentials, budgets, `low`, output 32000, alerts and sandbox are preserved. Verified minimum attempt headroom: Copilot **78**, Codex **12.6**. Private rollback/config/build checkpoints are under `var/deploy/sol61-node26-20261016/`; the Mac's ignored reference config is synced with its own reference backup. No secret contents were read/printed/copied.

A 20-second manual event run under the private Node 26 candidate passed readiness at **2026-10-16 16:52:03 UTC**, entered waiting and stopped cleanly (timeout 124); no alert delivery error was reported. Event spent/reserved remains **0/0 for both providers**, with no Node process left running. **Global `/usr/local/bin/node` still reports 24.21.0**. Candidate success is not a completed global upgrade; operator sudo installation and service restart remain pending.

## Pi maintenance sequence and operator actions

1. **Operator:** `sudo systemctl stop boc`. Agent verifies PID 0/no other BoC process before replays or other credential-using commands.
2. Run the model comparison above on Node 24 and record its results before any runtime replacement.
3. **Operator root action:** install the verified Node 26 archive into `/usr/local` (the current unit and `boc` wrapper use `/usr/local/bin/node`). Do not rerun the full `setup.sh` merely to upgrade Node: it also upgrades the OS, touches the unit and firewall, and rebuilds BoC. The staged Node 24 archive is the rollback path. A bounded installation command will be supplied after the service-stop verification; verify the staged checksum immediately before extraction.
4. Deploy the green-CI revision with `git pull --ff-only`, `npm ci --ignore-scripts`, and `npm run check` under Node 26. Run `check.sh --probe`, read-only event status, and bounded current/selected-model provider replays in fresh storage. Check readiness and alerts with the event config unchanged unless a model switch has independently passed its gates.
5. On any regression, keep the service stopped, restore the Node 24 runtime and compatible application/config revision, and retest. Never roll back rotated OAuth credentials or reset journals/held charges.
6. **Operator:** restart `boc.service`. Verify active state, start check, waiting state, credits, notification receipt and next daily check. Avoid unattended live experiments.

## Next concrete task

Global Node 26.11.1 installation is complete and independently verified. Fresh clean install, all **216 tests**, audit (zero findings), full sandbox/toolchain preflight and bounded event readiness passed on the global binary. The event entered waiting at **2026-10-16 17:07:56 UTC** and stopped cleanly after 20 seconds, with config checksum unchanged and event spent/reserved 0/0. Private logs: `var/deploy/sol61-node26-20261016/global-node26-*`. No Node process remains. **Restart verified:** active/running, PID 75927, start at **2026-10-16 18:07:47 UTC**, `start check passed` at **18:07:50 UTC**, then waiting for day 1. Global Node remains 26.11.1; event spent/reserved remains 0/0 on both providers. No startup alert delivery error was logged. Next: confirm notification receipt and observe the next daily check around 2026-10-17 18:07 UTC, without disturbing the service.
