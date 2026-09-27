# Foundation feasibility spike

Inspected on **2026-09-27**. This is a documentation/source review plus offline tests, not authenticated provider validation. No credentials were accessed and no live model or AoC requests were made by BoC. Rates and policies must be rechecked before enabling an adapter.

## Decision (updated by D016): best-effort adapters after calibration

**Status 2026-09-27:** GitHub Copilot passed calibration and is enabled (see "Copilot calibration result"). Codex and Anthropic have no adapter yet.

The hard-credit contract below was the original gate. Neither subscription met it. On 2026-09-27 the operator relaxed it to best-effort limits (D016): a padded estimate is reserved before each call, actual charges are recorded with their source, runaway responses are cut off, and the overshoot tolerance is bounded. An adapter becomes eligible once it exists and passes a supervised calibration run; see "Calibration protocol" below. No adapter exists yet, so `src/providers/readiness.ts` still reports every provider as ineligible. The evidence below explains why the limits are best effort and not guaranteed.

| Provider | Established by current official documentation | Missing for BoC admission |
| --- | --- | --- |
| GitHub Enterprise Copilot | Native AI credits, model/token pricing, pooled enterprise credits, subscription authentication, SDK usage events/metrics | Exact Pi-route debit attribution and rounding, pricing validity, enforceable request bound, all retries/auxiliary calls covered, account-specific policy |
| ChatGPT Business / Codex | ChatGPT subscription authentication separate from API billing, native credit rates, token telemetry, workspace usage controls | Included-usage versus credit-debit semantics for the actual account, authoritative per-call receipts, enforced output/total-charge bound on the subscription endpoint, finality and outside shared usage |

A conservative upper bound need not predict cost precisely: it may over-reserve. But published average message costs, dashboard percentages, API-dollar estimates, and abort-after-response logic are not bounds. Empirical tests alone cannot establish a universal endpoint guarantee.

### Key official evidence

1. [GitHub session limits](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-limits): “Usage is checked after model calls return, so one response can exceed the configured value before the runtime blocks the next model call.” `maxAiCredits` is explicitly a **soft cap**. This is evidence about the official Copilot SDK/CLI, not a claim that Pi invokes that SDK.
2. [GitHub enterprise billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing) and [model prices](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing): AI credits are the billing unit; 1 credit is $0.01 at this snapshot. Enterprise credits are pooled. Model/cache/long-context rates and applicable policy multipliers must be accounted for. Included pool consumption is still consumption, not automatically free.
3. [GitHub SDK usage and billing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing): per-model-call `assistant.usage` and aggregate native-unit metrics exist. Some older fields describe premium-request multipliers, not native credit debits. Nano-unit conversion and applicability to Pi need explicit verification.
4. [GitHub budgets](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets): user-level budgets promise a hard stop; other spend caps require enforcement to be enabled. This does not document BoC's per-puzzle allocation or atomic reservation of in-flight work. Do not infer either guaranteed overshoot or guaranteed reservation from this page.
5. [Codex pricing](https://developers.openai.com/codex/pricing): “If you reach your usage limits during an active turn, the agent will be able to continue working on that turn, subject to fair use limits.” The page also states “Credit prices alone don't determine included subscription usage.” Published token credit rates therefore are not sufficient to reconstruct every subscription's included allowance or final debit. No fixed maximum turn continuation was established.
6. [Codex authentication](https://developers.openai.com/codex/auth/) distinguishes ChatGPT sign-in from separately billed API keys. [Non-interactive operation](https://developers.openai.com/codex/noninteractive) documents automation and turn usage, not an authoritative per-call credit receipt for Pi. Its ChatGPT-managed CI/CD restrictions must be checked before adopting that specific workflow; BoC's CI currently uses no provider authentication.
7. [Codex usage and cost](https://developers.openai.com/codex/enterprise/chatgpt-work-usage-and-cost) and [usage-limit scope](https://developers.openai.com/codex/enterprise/usage-limits) describe shared usage and reporting limitations. Account/plan applicability must be verified; Enterprise-specific statements must not silently be applied to Business.

Directly fetched GitHub session limits, GitHub enterprise billing, and Codex pricing were checked again during parent synthesis. A delegated researcher inspected the other linked official sources. Some Business Help Center pages returned HTTP 403; this is an evidence gap, not proof of missing functionality. No production rate table is embedded in code.

### Calibration protocol (D016)

1. The operator provides a credential file for a small explicit allocation, preferably with a provider-side cap (for example, a GitHub user-level budget with usage stopping enabled).
2. Configure the pool, the subscription `estimate` (current official per-token rates and the pricing label), and small limits.
3. Run a few past puzzles with `boc run --days …` under supervision.
4. Compare BoC's ledger (`boc status`, and the settle sources in the journal) with the provider's billing or usage report for the same period.
5. The adapter passes if no single charge exceeded its estimate by more than the safety factor and the totals agree within 10 %. Record the result, rates, dates, and discrepancies here. Recheck before each event.

### Original hard-ceiling evidence requirements (superseded by D016, kept for reference)

- Authorized account/workspace and endpoint, permitted third-party use, current native-unit rate contract, and precise billed principal/pool.
- Enforced upper bound covering input, output/reasoning, caches, model/tier selection, and any hidden billable work. Provider-side allocation can help only if its enforcement semantics meet the bound.
- A tested pre-dispatch path with atomic durable reservations for all four configured counters, including concurrent workers.
- Debit finality/rounding, error/cancellation/retry settlement, and reconciliation of unknown outcomes without releasing their reservations prematurely.
- Exclusive allocation or appropriate provider-side controls for externally shared usage. BoC cannot control other applications on the same account.

Do not request a live experiment merely to discover whether overshoot occurs. Establish a safe test allocation and enforceable bounding mechanism first.

## Pi 0.87.1 integration boundary

Runtime is Node.js 24 LTS (minimum/tested patch 24.21.0); Pi coding-agent, AI, agent-core, TUI, and chord packages are pinned to 0.87.1. The repository lockfile records the resolved dependency graph. TypeScript 6.0.3 compiles ESM; Node's native type stripping runs tests. Package lifecycle scripts are disabled.

Read the SDK, settings, model/provider, security, and containerization docs, plus the full-control and credential examples. Relevant source paths below are relative to `node_modules/@earendil-works/pi-coding-agent/`; its AI package is bundled under `node_modules/@earendil-works/pi-ai/`.

- `dist/core/sdk.js`, around lines 176–245: ordinary agent calls route through `ModelRuntime.streamSimple`; it also constructs a cache warmer. `before_provider_request` transforms payloads but is not, by itself, evidence that every transport attempt is admitted.
- `dist/core/agent-session.js`, around lines 1844, 2938, and 3181: compaction and branch-summary work use `agent.streamFunction`. Guarding only an outer `session.prompt()` is insufficient for multiple calls.
- `dist/core/cache-warmer.js`, around lines 236–249: cache warming calls `modelRuntime.streamSimple` directly, bypassing a wrapper installed only on `agent.streamFunction`.
- `dist/core/model-runtime.js`, around lines 452–470: both `stream` and `streamSimple` are dispatch paths; completion helpers use them. A future adapter must control both paths and forbid unguarded alternatives.
- `pi-ai/dist/api/openai-codex-responses.js`, `buildRequestBody` around lines 373–432: the pinned Codex request builder does **not** send a `max_output_tokens`/`max_tokens` field from `maxTokens`. Do not assume the generic option bounds Codex subscription output. A documented model-wide bound might eventually support a conservative reservation, but has not been validated here.
- The same Codex transport has retries and WebSocket/SSE fallback. A single stream invocation can otherwise conceal multiple HTTP attempts. Setting provider retries to zero and selecting SSE narrows the path; it does not prove safe credit accounting.

`src/pi/settings.ts` supplies only an in-memory settings profile: compaction/retries/cache warming off, SSE selected, no built-in tools, no install telemetry or analytics. `src/pi/resources.ts` supplies explicit resources with no discovery. The dispatch admission gate is described below; no production session factory exists yet. Defaults, stock resource discovery, personal extensions, ambient credential fallbacks, and direct provider calls must remain excluded from future sessions.

### Dispatch admission proof (fake providers only)

`src/pi/guarded-streams.ts` wraps a trusted adapter's `stream` and `streamSimple` in one admission path. Each dispatch attempt must obtain a reservation first; the model/provider/API/endpoint must equal the allowlisted model; retries, deferred requests, and non-SSE transports are rejected. Request options are rebuilt from an explicit allowlist: callbacks and fields that could rewrite the approved request (`onPayload`, `fetch`, `env`, `transformHeaders`, `samplingParams`, `metadata`, unknown keys) are dropped. Model, context, and options are snapshotted synchronously and deeply frozen, and admission receives exactly the snapshot the transport will receive. `apiKey` and `headers` come from Pi's auth resolution and are trusted; a live adapter must additionally pin its header set.

Terminal success (and therefore tool execution) is published only after `settle()` succeeds; known provider errors are settled and sanitized. After a reservation exists, any uncertain outcome — settlement failure, missing terminal event, protocol violation, transport throw, abort (during admission or mid-stream), or an aborted/deferred/pending terminal — is never settled, keeps the reservation held, and permanently faults that guard instance. Denials before a reservation (budget denial, disallowed model or options, early abort) hold nothing and leave the guard usable.

`test/pi-session.test.ts` runs a real `createAgentSession` with explicit empty resources, the restrictive settings, no built-in tools, and a fake provider. Verified: one admission per normal turn; one per tool-loop generation (exhaustion stops the loop before the next generation); a denied dispatch is attempted once and not retried; a retryable-looking provider error is not retried (note: the guard's sanitized message also hides retryable text from Pi's classifier, so this does not independently prove `retry.enabled=false`); explicit `compact()` reserves for its summary call and is blocked by an exhausted admission; no cache-warming call after a turn; a forged same-provider model can be *selected* via `setModel` (Pi checks only provider auth) but the guard rejects it before admission.

**Known SDK limitation:** Pi 0.87.1's `createAgentSession` accepts only the concrete `ModelRuntime` class, whose factory always installs built-in providers with ambient credential discovery; there is no supported way to inject only an explicit `Models` collection. The test fixture (`test/support/fake-pi.ts`) therefore uses a fail-closed proxy facade cast to `ModelRuntime`. **This cast is test-only and must not ship as the live integration.** Resolved by D015: the solver bypasses `AgentSession` and uses a BoC-owned loop over `pi-agent-core`'s `Agent` with the guarded streams as its only `streamFn`. Also hide `navigateTree` summaries, `summarizeForBugReport`, deferred APIs, provider registration, and refresh from any BoC-facing wrapper.

When the guard gives up after admission without settling, it calls the optional `Reservation.abandon` with `not-dispatched` or `outcome-uncertain`; this is an annotation only and never releases the reservation. `test/ledger-admission.test.ts` runs the same guard and a fake-provider session against the durable ledger (D012) with a synthetic meter.

These tests prove the dispatch boundary with fakes only. They do not prove a real provider's internal retries/fallbacks are bounded, nor provide pricing or authoritative credit receipts.

## Solver isolation decision

Use a **separate networkless Linux container for generated code**, with Pi/orchestration and secrets outside. Docker Engine on Linux or Docker Desktop's Linux VM is the initial supported backend. The development host already has Docker; an operator without it needs this additional prerequisite. No unrestricted host-execution fallback is permitted.

Required executor properties:

- Trusted, digest-pinned image with the allowed Python/uv, Node.js, Go, and Rust toolchains; installed host binaries are not automatically available inside it.
- No network interface except loopback, no Docker socket, no host HOME/repository/credential mounts, no inherited environment secrets.
- Non-root UID, read-only root, dropped capabilities, no-new-privileges, memory/CPU/PID limits, bounded writable scratch, and explicit deadline/cleanup ownership.
- Only puzzle input, generated files, and approved libraries transferred into a per-attempt workspace. Export artifacts without following symlinks into host paths; bound output and sanitize terminal controls.
- Resolve dependencies separately through a trusted acquisition step using approved package sources and pinned versions/checksums. Do not grant arbitrary solver URLs, network access, or package-install hooks access to host credentials. Full dependency-acquisition policy and implementation are outstanding.

Containers rely on a trusted host/daemon/kernel and image. This is a practical isolation boundary, not protection against every kernel escape. Use a dedicated VM/host if a stronger threat model is required.

### Local isolation probe

`npm run test:sandbox -- <existing-local-image-sha256-id>` runs only a synthetic Node.js probe. It never pulls an image or starts solver/model/AoC work. For example, after an operator has provisioned a trusted local Node.js image:

```sh
npm run test:sandbox -- "$(docker image inspect node:24-trixie-slim --format '{{.Id}}')"
```

Passed locally with Docker Engine 29.8.0 and the existing Node image: UID 65534, no external interface, no inherited synthetic canary, no Docker socket, read-only root, zero effective capabilities, no-new-privileges, and writable scratch. The read-only-root check inspects `/proc/self/mountinfo`, not merely non-root write denial; a negative-control run with `--read-only` removed correctly failed. It did **not** validate all toolchains, dependency acquisition, artifact transfer, production container cleanup, or kernel-escape resistance. The probe is opt-in and not part of the default test suite/CI; the production executor is still to be implemented.

## GitHub Copilot adapter findings (2026-09-27, pi-ai 0.87.1)

The adapter is implemented (`src/providers/github-copilot.ts`) and tested offline with a fake provider. It has **not** made a live request yet.

- **Auth.** Pi's Copilot OAuth uses the GitHub device flow: the GitHub access token (`refresh`) is exchanged for a short-lived Copilot token (`access`, with `expires`). The API base URL comes from the token's `proxy-ep`, for example `api.business.githubcopilot.com` for organization seats.
  - `boc login <config> <subscription>` runs this flow and writes the credential only to the subscription's `credentialFile` (`0600`). The adapter refreshes the token when it is within 2 minutes of expiry and persists the rotated token atomically.
  - Pi's login also enables account models whose policy is "unconfigured", as VS Code does. Models disabled by policy stay disabled.
  - The flow identifies itself with Copilot/VS Code client headers taken from Pi's model catalog.
- **APIs and caps.** Copilot models use `anthropic-messages`, `openai-completions`, or `openai-responses`. All three create SDK clients with `maxRetries: 0`, retry only through `options.maxRetries` (the guard forces 0), and send the output cap (`max_tokens`, `max_completion_tokens`, or `max_output_tokens`) when `maxTokens` is set. The guard applies `outputCap` (`assumedMaxOutputTokens`, bounded by the model maximum), so the adapter uses `enforcesMaxTokens: true`.
- **Charges.** No per-call AI-credit figure is exposed on this path. Charges are `derived` from reported token usage at the configured rates, or `estimated` when usage is missing or the response was cut off.
- **Official rates.** [Models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), fetched 2026-09-27: 1 AI credit = $0.01, prices per 1M tokens. Configured `estimate.rates` are **credits per 1M tokens = USD × 100**. For example, Claude Sonnet 4.6 gives input 300, cacheRead 30, cacheWrite 375, output 1500. GPT-5.4 mini gives input 75, cacheRead 7.5, cacheWrite 0, output 450. Some models have higher long-context tiers above 200K–272K input tokens; BoC's contexts stay far below those thresholds, but configure the higher tier if in doubt.
- **Included allowances.** Copilot Business and Enterprise include per-user AI-credit allowances pooled at the billing entity. BoC counts all usage against its own limits whether or not it falls within the included allowance.
- **TLS.** On a host behind a TLS-intercepting proxy, run BoC with `NODE_EXTRA_CA_CERTS=<ca-bundle>` so that `github.com` and `*.githubcopilot.com` validate.
- **Status.** Calibrated (see below) and registered in `PRODUCTION_ADAPTERS` on 2026-09-27.

### Copilot calibration result (2026-09-27): passed

- **Setup.** Operator-supervised `boc run --calibrate --days 1,2` on AoC 2025 (past event), on the operator's GitHub Enterprise Copilot seat.
  - Model: `gpt-6-sol`, through the `openai-responses` API.
  - Rates: input 200, cacheRead 20, cacheWrite 250, output 1000 credits per 1M tokens (official price list, default tier).
  - Safety factor 1.5, output cap 16000 tokens, limits 300 per event and 100 per puzzle, no provider-side cap.
  - Run on this host behind the TLS-intercepting proxy with `NODE_EXTRA_CA_CERTS`.
- **Outcome.** Both parts of both days were solved with correct answers on the first submissions. No errors or uncertain outcomes.
- **`boc calibration-report`.** 15 calls, all settled, none held or uncertain. Estimated 392.58225 credits; charged 4.54678, all `derived` from reported token usage. Largest actual/estimate ratio: 0.026.
- **GitHub's reported AI-credit usage for the same window:** 4.55. The difference is 0.0032 credits (0.07 %), within display rounding.
- **Against the D016 criteria.** No call exceeded its estimate (max 0.026, limit 1.5×), and the totals agree well within 10 %. **Passed.**
- **Observation.** The estimates are very conservative, about 86× the actual in total, because the 16000-token output cap dominates each reservation (roughly 26 credits per call). The limits are therefore not exceeded, but near a limit BoC may stop with up to one reservation of headroom unused. If that matters, a lower `assumedMaxOutputTokens` narrows the gap, at the risk of truncating reasoning-heavy answers.
- **Recheck** rates, the model catalog, and a small calibration before each event.

## Anthropic authentication findings (2026-09-27)

The operator asked for the same login Pi uses for Anthropic: a Claude.ai subscription OAuth credential (`sk-ant-oat…`/`sk-ant-ort…`) on an Enterprise plan. This path is **not used**. It conflicts with Anthropic's published policy.

- **Official policy.** [Claude Code legal and compliance, "Authentication and credential use"](https://code.claude.com/docs/en/legal-and-compliance), fetched 2026-09-27:
  - OAuth authentication "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications".
  - Developers building products "should use API key authentication through Claude Console or a supported cloud provider".
  - Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow".
  - The policy explicitly permits an end user "signing in to the unmodified Claude Code binary with their own Claude subscription".
  - The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says the same for SDK-built agents unless previously approved.
- **What Pi does.** pi-ai 0.87.1's Anthropic OAuth path (`auth/oauth/anthropic.js`, `api/anthropic-messages.js`) uses Claude Code's OAuth client ID. With an OAuth token it sends `user-agent: claude-cli/…`, `x-app: cli`, and the `claude-code-20250219` beta, and renames tools to Claude Code names. BoC would thereby present itself as Claude Code while storing and using subscription tokens. That is the pattern the policy excludes, and it would also violate BoC's own rule against evading provider policy.
- **Compliant options:**
  1. **Anthropic API key** from Claude Console, for example an organization or workspace under the company's agreement. Usage is billed per token to the key owner. Console workspace spend limits can serve as the provider-side cap. pi-ai's `anthropic-messages` API always sends `max_tokens` and reports usage, so estimates and `derived` charges should be accurate. This is the recommended path.
  2. **A supported cloud provider** (Amazon Bedrock or Google Vertex AI) with the organization's own cloud credentials.
  3. **Driving the unmodified Claude Code binary** signed in with the operator's own subscription. This is permitted for an end user, but it does not fit BoC's architecture: Claude Code runs its own tool loop and web tools on the host, outside BoC's guard, ledger, and container isolation, and the policy frames subscription limits around "ordinary, individual usage". Not recommended.

## ChatGPT Business / Codex adapter findings (2026-09-27, pi-ai 0.87.1)

The adapter is implemented (`src/providers/openai-codex.ts`, sharing `oauth-adapter.ts` with Copilot) and tested offline. It is registered in `CALIBRATION_ADAPTERS` only.

- **Policy.** The official [Codex authentication page](https://developers.openai.com/codex/auth), fetched 2026-09-27, describes "Sign in with ChatGPT" for the ChatGPT desktop app, the Codex CLI, and the IDE extension. It recommends API keys "for programmatic Codex CLI workflows, such as CI/CD jobs", and Codex access tokens for trusted automation in ChatGPT Enterprise workspaces.
  - Unlike Anthropic, no official statement found **prohibits** third-party clients from using the operator's own ChatGPT sign-in. None documents a contract for it either.
  - The Help Center "Using Codex with your ChatGPT plan" page returned HTTP 403; this is an evidence gap.
  - The operator uses their own Business seat, attended, through a client that identifies itself honestly: pi-ai sends `originator: pi` and Pi's User-Agent, while using the Codex OAuth client ID.
  - Recheck before events. Stop if OpenAI publishes a restriction or the workspace admin disallows it.
- **Auth.** ChatGPT OAuth. `boc login` defaults to the device-code flow. The operator's workspace has device codes disabled, so `--browser` selects pi-ai's browser flow instead: PKCE, a `localhost:1455` callback server, and a manual-paste fallback. The credential holds `refresh`, `access`, `expires`, and `accountId` (sent as `chatgpt-account-id`). The file-only storage, refresh, and redaction rules match Copilot.
- **Transport.** The endpoint is `https://chatgpt.com/backend-api` (responses). The guard forces SSE, so the WebSocket path and its fallbacks are skipped. HTTP retries come only from `options.maxRetries`, forced to 0. Request bodies may be zstd-compressed.
- **No output cap.** The Codex request body carries no output-token limit, even when `maxTokens` is set. The adapter therefore uses `enforcesMaxTokens: false`: estimates use `assumedMaxOutputTokens`, and the guard's streaming cutoff bounds runaway responses.
- **Credits.** The [Codex pricing page](https://developers.openai.com/codex/pricing), fetched 2026-09-27, gives standard-speed credit rates per 1M tokens. GPT-6 Sol costs 50 input, 5 cached input, and 250 output. There is no cache-write charge, and fast mode costs 2.5×.
  - "Credit prices alone don't determine included subscription usage", and "If you reach your usage limits during an active turn, the agent will be able to continue working on that turn".
  - BoC charges all usage at credit rates (`derived`), whether it falls within included usage or is paid from credits. Comparing against the ChatGPT usage dashboard may therefore be approximate while usage stays inside the included allowance.
- **Early errors.** A provider error before any output (for example a usage-limit 429) is now settled at zero (`estimated`, `error-before-output`) instead of at the full reservation. This applies to all adapters.
