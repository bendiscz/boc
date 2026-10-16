# Dependency upgrade assessment and plan

Assessed and implementation authorized 2026-10-15. **Pi 1.3.0 is implemented and verified offline; production dependency pins and model/settings are unchanged pending supervised rollout.** Verification details are in FEASIBILITY.md (Pi 1.3.0) and PLAN.md.

## Recommendation

Upgrade the coordinated Pi family from **0.87.1 to exactly 1.3.0**, the latest npm release observed during this assessment. Keep Node.js 24 LTS, BoC's own agent loop, the existing provider identities, and the current production model/settings. Separate SDK support for new models from permission to activate them in production.

This is a moderate-risk integration upgrade, not just a vulnerability patch. An isolated experiment suggests a small initial source migration, but mock tests do not establish live compatibility or accounting correctness.

## Evidence

Baseline on Node 24.21.0: `npm ci --ignore-scripts` and `npm run check` passed all 193 offline tests, type checking, and build. Biome reports one non-blocking optional-chain warning. The default development shell uses unsupported Node 26; explicitly select Node 24 for this work.

The baseline audit reports one high-severity vulnerable transitive package, `brace-expansion`, under `pi-coding-agent`. The audit's affected range ends at 5.0.11, with a fix available. Do not blindly run `npm audit fix --force`.

During the initial assessment (before implementation), published 1.3.0 tarballs were inspected and a clean **tracked-files-only** archive of BoC was installed in a temporary directory. No private runtime files or credentials were copied. The experiment changed only Pi direct dependencies and matching overrides, and removed the obsolete `chord` override:

- Installation with `--ignore-scripts` succeeded on Node 24.21.0.
- `npm audit --json` reported **zero vulnerabilities** for that candidate tree at assessment time.
- `npm test` passed **193/193 tests**, without application source changes.
- `npm run typecheck` failed at `test/support/fake-pi.ts:136`: Pi's `Models.getAuth` now accepts `AnyModel`, while the helper accepts only chat `Model<Api>`. Fix the helper narrowly; do not suppress the error with an unchecked cast or weaken the production model allowlist.
- At that initial assessment stage, a complete candidate `npm run check`, real-provider wire tests, Docker probes, CI, and live verification had **not** been completed. Subsequent offline implementation results are recorded in FEASIBILITY.md; live verification remains pending.

Sources: npm package metadata/tarballs for `@earendil-works/pi-{ai,agent-core,coding-agent}@1.3.0`; their published declarations and provider implementation; the [Pi changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md). Version and security findings are snapshots, not promises about future releases.

## Model support and scope

The published 1.3.0 chat catalogs contain `gpt-6.1-sol` for both existing BoC providers:

| Provider | API | Catalog context / output maximum |
| --- | --- | --- |
| `github-copilot` | `openai-responses` | 1,050,000 / 128,000 tokens |
| `openai-codex` | `openai-codex-responses` | 500,000 / 128,000 tokens |

These are upstream metadata, not instructions to increase BoC's configured 32,000-token assumed output maximum. Catalog presence does not establish account entitlement, provider policy, native credit rates, or solver quality. BoC already selects exact configured model IDs from these catalogs; no new general-purpose model discovery system should be necessary.

Pi also now supports ChatGPT subscription login on its `openai` provider and calls `openai-codex` legacy. That newer OAuth flow is **not** a drop-in credential rename: its implementation requires an issued client ID and installation device ID. Keep the calibrated `openai-codex` adapter in this increment. A move to the new provider requires its own architecture decision, authorization, accounting calibration, configuration/journal compatibility strategy, and rollback plan. Never rebind an existing ledger identity to another provider.

Classifier/image models and direct OpenAI API billing are out of scope. A matching model name on another API is not interchangeable with a subscription-backed chat model.

## Upgrade sequence and gates

### 1. Freeze scope and record a baseline — complete offline

- [x] Reconfirm target availability and release notes, including all changes since 0.87.1. Use exact versions; do not chase a moving `latest` during implementation.
- [x] Record the clean Git revision, Node/npm versions, baseline checks and audit, and current CI status.
- [x] Read target SDK docs/examples and relevant source/declarations for the APIs BoC uses, especially agent lifecycle, provider auth, stream options/events, settings/resources, and model metadata.
- [x] Keep configuration/journal formats, model selection, reasoning `low`, sandbox image, and production credit allocations unchanged.

### 2. Update dependencies in small, reviewable increments

- [x] Update direct `pi-ai`, `pi-agent-core`, and `pi-coding-agent` to **1.3.0** together. Align retained family overrides, including `pi-tui`; remove the obsolete `chord` override after verifying the resolved tree. Inspect newly introduced internal packages, including telemetry.
- [x] Regenerate `package-lock.json` using Node 24 and `--ignore-scripts`; inspect `npm ls` for duplicate or mixed Pi versions. Then verify a clean `npm ci --ignore-scripts`.
- [x] Fix the `AnyModel` test-helper incompatibility while preserving explicit rejection of unsupported operations/model types.
- [x] Update Zod **4.6.5 → 4.6.7**, Biome **2.5.14 → 2.5.15**, and Node types **24.13.6 → 24.19.2** in a separate increment if checks remain green (versions observed on assessment date).
- [x] Keep TypeScript **6.0.3** initially. Version 7.0.2 is available, but a compiler major migration is unrelated to model support and should be assessed separately. Do not move Node types to 26 or upgrade the runtime/npm globally as part of this change.
- [x] Do not remove `pi-coding-agent` or redesign the test/runtime abstraction in the same upgrade; its settings/resources and admission integration tests are still used.

### 3. Revalidate safety and compatibility offline

- [x] Run full `npm run check`, clean-install audit, credential-free CLI/config checks, and CI. Resolve the known lint warning if desired without unrelated cleanup.
- [x] Add offline catalog tests for `gpt-6.1-sol` on both supported providers, alongside the existing `gpt-6-sol` regression tests. Verify chat type, API, reasoning mapping and limits without network or credentials.
- [x] Add/extend synthetic tests through the **actual new Pi provider implementations**, not only injected fake providers: intercept HTTP locally and verify SSE-only operation, `maxRetries: 0`, actual request count under transient errors, cancellation, output-limit serialization, tool-call round trips, usage/cache/reasoning fields, and terminal errors. No external model calls.
- [x] Reconfirm Copilot's enforced output cap and Codex's currently assumed/non-enforced cap from target source and wire evidence; adjust estimates only if proven behavior changes.
- [x] Exercise admission-before-dispatch, settlement-before-tool execution, malformed/incomplete streams, retained unknown charges, streaming/time cutoffs, failover classification, exact model/API/endpoint pinning, and rejection of request-rewriting hooks/new alternate execution paths.
- [x] Verify no ambient auth/resource discovery, telemetry, built-in tools, MCP, automatic compaction, cache warming, or unaccounted retries become enabled. Check the new awaited agent-listener semantics against shutdown and proposal termination.
- [x] Confirm read-only status and restart replay against synthetic pre-upgrade journals. No journal migration is expected; unexpected incompatibility blocks deployment.
- [x] Verify current Docker isolation/toolchain probes where available. An SDK-only host upgrade should not require rebuilding the solver image; investigate rather than silently changing it.

### 4. Validate new-model accounting before activation

- [ ] Establish provider-specific entitlement and current native credit semantics for each candidate model. Preserve explicit pricing versions and separate native pools; SDK catalog costs are not authoritative subscription-credit prices.
- [ ] Check cache rates, hidden reasoning/output accounting and long-context price tiers. BoC currently uses flat configured rates, so either use conservative worst-case rates or enforce a validated context boundary; do not silently underprice a larger catalog context window.
- [ ] Ensure conservative reservations fit the existing per-puzzle/event limits and output assumptions. Unknown pricing blocks model activation.
- [ ] Prepare private, separate-storage replay/calibration configs. First compare the old model on the upgraded SDK; then compare candidate models on representative easy/hard and OCR/tool-heavy cases. Include correctness/first proposals, latency, turns, native credits, reservation overruns and retained charges.
- [ ] Obtain explicit operator approval for the selected models, bounded native-credit allowance, and maintenance window **before** live tests. Replays spend credits even though they do not contact AoC.
- [ ] Reconcile observed charges with provider billing under D016. Existing adapter calibration is historical evidence, not proof for a new model or materially changed transport. Keep current production model if a candidate is unverified, unavailable, worse, or unaffordable.

### 5. Deploy and monitor with rollback ready

- [x] Commit/push tested increments, record decisions/evidence in FEASIBILITY.md and PLAN.md, and obtain green CI before deployment (Linux/macOS at `39ba549`; final test-hardening CI is checked again before handoff).
- [ ] The operator stops `boc.service` on the Pi. Verify it is stopped before any other BoC process or state-changing command; never use the Mac's old credentials.
- [ ] Record deployed revision/build, image ID and private config backup on the Pi. Preserve journals and credential files in place; do not print or copy their contents to development artifacts.
- [ ] Deploy with `git pull --ff-only`, `npm ci --ignore-scripts`, and build on Node 24. Run offline config/probe checks, then the approved supervised provider checks/replays on the Pi.
- [ ] Restart through the operator. Confirm `start check passed`, waiting state, truthful spent/reserved credits, alert delivery and the next daily readiness check. Keep an observation window before considering the rollout complete.
- [ ] On failure, stop the service and return to the recorded application revision/lockfile/build and compatible config, without resetting journals or budgets. **Do not restore stale OAuth tokens:** refresh-token rotation must survive rollback. An incompatible credential format requires operator reauthorization, not reuse of invalidated credentials. Retain/reconcile unknown charges.

## Acceptance and next action

Done means reproducible pinned installation on Node 24, green offline checks/CI, no known audit findings (or explicitly documented exceptions), preserved safety/recovery behavior, catalog support for the selected new chat models, and separately authorized live evidence before changing production models. Deployment and new-model activation are distinct gates.

**Next concrete task:** arrange the operator-controlled Pi maintenance window for phase 4–5. The offline SDK/patch increments are complete, with 211 passing tests, zero audit findings, Docker probes and cross-version journal verification. CI passed on Linux/macOS at `39ba549`. Final review found and fixed swallowed assertions in network-blocking test callbacks: teardown now independently checks every fetch and WebSocket attempt. Negative controls with deliberately swallowed forbidden calls fail for both providers. Do not change production or start live runs while the service is running; new-model selection/rates and a bounded test allowance must be explicit.
