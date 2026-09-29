# Historical evaluation

Private per-puzzle notes (answers, logs, transcripts) stay in `var/`. This file holds only aggregate, puzzle-free findings.

## AoC 2025, days 5–12 (2026-09-28)

A supervised live rehearsal, run by the agent with the operator's explicit go-ahead, within the 300-per-event / 100-per-puzzle allowance of each calibration config. Days 1–4 were solved during calibration.

- **Split:** Copilot on days 5–8, Codex on days 9–12, run one after the other, headless.
- **Correctness:** 16 of 16 parts correct, each on its first attempt and first submission. There were no wrong answers, cooldowns, retries, or provider faults. With days 1–4, the account holds all 24 stars for 2025.
- **Final day:** day 12's part 2 button was pressed without a model call. The response was not a recognized verdict, so it went to `uncertain`, and one page read reconciled it as correct, as designed (AOC.md).
- **Credits (native units):**
  - Copilot: 10.52 for days 5–8, 1.65–4.32 per day.
  - Codex: 5.09 for days 9–12, 0.66–2.10 per day.
  - Every call settled; there were no held or uncertain reservations.
- **Reservation padding:** reservations were far above actual charges. The largest actual/estimate ratio was 0.076 for Copilot and 0.058 for Codex; the Copilot total was estimated at about 1240 against 15 charged. This comes from the assumed maximum output (`assumedMaxOutputTokens`). It did not block anything, but one reservation takes a large share of the 100-credit per-puzzle limit, which caps how many turns can be in flight near the limit. Tuning remains open.
- **Latency:** about 18–24 s of solving per day with Copilot and 39–49 s with Codex, from first attempt to part 2 verdict.
- **AoC traffic:** about five requests per day (puzzle, input, answer, puzzle, answer).

### Defects found

- **Silent bug-brake stalls.** The AoC client's sliding-window brake (10 requests per 10 minutes) stalled for about 8–9 minutes after every two back-to-back past days, and also before day 12's reconciliation read. Nothing was logged. The brake behaved as specified, and the operator's pacing decision is unchanged. However, a silent stall looks like a hang, and the wait was not abortable. Fixed: every brake wait is now logged through `onBrake`, and in `boc run` the wait is abortable. A regression test is in `test/aoc.test.ts`.

### Output cap tuning (2026-09-28, offline)

- **Measured output:** across all 92 settled calls of the 2025 calibration and rehearsal, output was at most 572 tokens for Copilot and 920 for Codex. The medians were 28 and 37, and the 90th percentiles 361 and 386. Input, including cached tokens, was at most about 8.5k tokens.
- **New setting:** the private calibration configs now use `assumedMaxOutputTokens: 8000`, down from 16000. That is still about 9× the largest observed response, and enough for a long program in one tool call. The per-call reservation drops from about 25–28 to about 14–15 Copilot credits, and from about 6.2–6.6 to about 3.5 Codex credits. Every reservation is still an upper bound: Copilot enforces the cap as `max_tokens`, and the guard cuts off Codex responses at the reservation.
- **Not changed:** the code default stays at 32000 for unmeasured models.
- **Evidence for later runs:** responses stopped by the provider's length limit or by the guard cutoff are now counted per attempt and logged (`N response(s) hit the output cap`). A harder evaluation can show whether 8000 is too tight.

## AoC 2024, days 13–25 (2026-09-28)

A supervised live evaluation of harder, later days, run by the agent with the operator's explicit go-ahead. The private configs were for event 2024, with 300 credits per event and 100 per puzzle each.

- **Split:** Copilot on days 13–19, then Codex on days 20–25, run one after the other. The Codex run started only after 10 minutes had passed since the Copilot run's last AoC request, because the bug brake is per process.
- **Correctness:** 25 of 25 solvable parts were correct, each on its first attempt and first submission. Answers included comma-separated lists and strings as well as integers.
- **Day 25 part 2:** it returned `needs-stars` without any spend, because 2024 days 1–12 are unsolved on the account.
- **Credits (native units):**
  - Copilot: 20.43, 2.13–4.95 per day.
  - Codex: 10.91, 0.38–6.24 per day; the most expensive was day 24.
  - Every call settled; there were no held or uncertain reservations.
- **Latency:** most parts took 8–30 s from attempt start to proposal. The longest, day 24 part 2 (Codex), took about 90 s.
- **Output cap at 8000:** no response hit the cap. The largest output was 762 tokens for Copilot and 787 for Codex, the median was about 30, and the 90th percentile about 450–510.
- **Reservations:** about 13–18 Copilot credits and 3.2–4.2 Codex credits per call. Across all calls in a run, estimates totalled 38× the actual charge for Copilot and 17× for Codex, down from about 80× and 43×. The largest per-call actual/estimate ratio was 0.082 for Copilot and 0.156 for Codex.
- **Brake:** as expected, it paused for about 8–9 minutes after every two days. Every wait was logged. No defects were found.

## Model benchmark: `gpt-6-luna` vs `gpt-6-sol` on Codex (2026-09-28)

**Method.** `boc replay` (src/bench/replay.ts) reruns the normal solve loop on days BoC already solved: AoC 2025 days 1–12 and AoC 2024 days 13–25, 48 scored parts in all.
- **Inputs:** statements and inputs come from the source run's private cache. Proposals are judged against the answer AoC accepted.
- **Isolation:** it never contacts AoC or reads the cookie, and the solver sees only what a live run would see.
- **Simulation:** a wrong answer's embargo is simulated rather than slept. Feedback is a plain "wrong", with no too-high or too-low hints.
- **Model calls:** real and ledger-admitted, in separate bench storage (300/100 per config), both through Codex.
- **Limits:** each part is a single sample, so the results are indicative, not statistically strong.

**Rates.** From the [Codex pricing page](https://developers.openai.com/codex/pricing), fetched 2026-09-28: luna costs 2.5 input, 0.25 cached input, and 12.5 output credits per 1M tokens, 1/20 of sol's.

| | luna | sol |
| --- | --- | --- |
| Correct on the first run (48 parts) | 46 | 48 (after excluding the credential outage, below) |
| Correct on the first submission | 46 | 48 |
| Failures | 2024 day 15 part 2 and day 24 part 2: four attempts, two wrong submissions each | none |
| Median / mean seconds, on the 43 parts both solved on the first run | 20.0 / 27.3 | 15.5 / 16.6 |
| Faster on | 14 of 43 parts | 29 of 43 parts |
| Slowest parts | 162 s (2024 day 16 part 2), 92 s (2024 day 19 part 1) | 70 s (2024 day 24 part 2); 22 min on 2024 day 15 part 2 before the runaway fix |
| Codex credits spent | about 5.1 (including the rerun) | about 35.9, plus 3.39 still held from an interrupted call |

**Findings:**
- **Speed:** luna is not faster. It is slower on median and mean, and much slower on some harder parts, probably because it takes more turns.
- **Correctness:** luna is less reliable. It failed two hard parts, with wrong answers, re-proposals of rejected answers, and answers containing `??` placeholders.
  - A rerun of those two parts with the later fixes solved both: day 15 part 2 on the third attempt after another wrong answer, and day 24 part 2 first time, in 164 s against sol's 70 s.
  - Luna's failures are therefore stochastic, not systematic, but they cost lockouts in a live run.
- **Cost:** luna costs about 1/7 as much per solved part.
- **Conclusion:** stay with `gpt-6-sol` for solving. Luna's cost advantage does not matter at the current budget: sol's heaviest day was under 9 of 100 per-puzzle credits. Its lower accuracy and speed work against the goal of the correct answer as soon as possible. The parallel "agreement" idea (PLAN.md) could use luna as a cheap second opinion, but the latency data gives no speed reason to race it.
- **Sol credential outage:** the Codex OAuth token was invalidated server-side at 2025 day 10 part 2. This is not a model result. After the operator signed in again, those days were rerun in fresh storage and are counted.

### Defects found

- **Provider refusals burned attempts.** A rejected credential or a usage limit made every attempt fail within milliseconds, so BoC gave up on every remaining part. In a live event this would forfeit the day. Fixed:
  - The guard reduces provider errors to safe categories: usage limit (with reset minutes when given), rejected credential, or other.
  - A refusal ends the part as `provider-unavailable` after one attempt, and the run stops with a clear message.
  - The raw provider error goes only into a private `provider-error.txt` beside the attempt transcript.
- **Runaway responses ran for 11 minutes.** On sol's 2024 day 15 part 2, two attempts each spent about 11 minutes on a single response. Each streamed about 12.5k tokens slowly, until the credit cutoff stopped it. Codex does not enforce an output cap, so nothing else limited the response's duration. The retry received the identical prompt and failed the same way. Fixed:
  - A response is stopped after 120 s, or after 60 s with no stream data, and settled like the credit cutoff; the run does not fault. Across 529 normal turns, none took more than 37 s including the tool run.
  - Attempts have a 10-minute deadline, checked between turns.
  - The partial output of a stopped response is kept privately in `cutoff-partial.json`.
  - The retry prompt now says why the previous attempt failed.
- **A killed run left a run-state lock that no command could clear.** `boc ledger break-lock` now clears both the ledger and the run-state lock of a dead local process.
- **Re-proposing a rejected answer wasted an attempt.** Found with luna and seen again in the rerun. Fixed: `propose_answer` refuses an answer already judged wrong, or one that contradicts a too-high or too-low bound, and returns the reason to the model as a tool error. The attempt continues, and the refusal is logged.

## Live failure drills (2026-09-29)

Supervised, agent-run with the operator's go-ahead. The drills used `boc replay` on AoC 2025 days already solved (sources: the two calibration configs), so AoC was never contacted, but the provider calls were real. Each drill used its own private storage: `var/bench/drill-2025`, `drill-2025-quota`, and `drill-2025-cred`. Logs are in `var/drill/`.

| # | Drill | Method | Result |
| --- | --- | --- | --- |
| 1 | Providers unreachable at start | Run without the corporate CA, so every TLS connection fails on the client | Both start checks failed, no model call was made, and the day ended `no-subscription`. 0 credits. **Defect A.** |
| 2 | Provider outage mid-solve | A local CONNECT proxy (`NODE_USE_ENV_PROXY`) toggled to refuse with 503 about 4 s into attempt 1 | Attempts 1–4 all failed within 120 ms, and the part **gave up permanently**. There was no failover to Codex and no backoff. The failed calls settled at 0. **Defect B.** |
| 3 | Process death | `kill -9` during attempt 1's model call, then a rerun | The rerun refused with `Credit ledger: Locked by another process.` After `ledger break-lock` it resumed: attempt 1 was recorded as interrupted, its call was held as an orphaned reservation (13.02, charge unknown), and day 6 was solved with one submission per part. **Defect D.** |
| 4 | Quota exhaustion mid-attempt | Copilot per-puzzle limit 15 (one call reserves about 13) | A later reservation was denied, and the part **gave up permanently** (`budget-exhausted`) although Codex had its full 100. **Defect C.** |
| 5 | Rejected credential | Copilot pointed at a synthetic credential with fake tokens (the real files were untouched) | The start check failed, Copilot was skipped, and Codex solved day 8 on the first submission. Passed, but the message is identical to drill 1's network failure (Defect A). |

Credits: Copilot 5.21 spent (4.44 + 0.78), plus 26.09 held in `drill-2025`; Codex 1.04 spent. The held amount is two unknown-charge reservations:
- 13.02 from drill 3's killed call; its true charge is unknown;
- 13.07 from an aborted call in the first attempt at drill 2. That call never reached the provider (the proxy log shows no tunnel after the outage began), so its true charge is 0. The operator may settle it.

Duplicate submissions and an expired AoC session were not drilled live, because replay never contacts AoC; both are covered offline in `test/drills.test.ts`.

### Drill-method artifact (not a BoC defect)

The first try at drill 2 made the proxy drop refused tunnels without replying. Node 24's built-in environment proxy support (`NODE_USE_ENV_PROXY`, undici) then retried CONNECT in a tight loop, about 300,000 connections in a minute inside one `fetch`. It continued after the request was aborted, and it reproduces with a bare `fetch`. Replying `503` fails fast with one connection, so the drill proxy now does that. BoC uses no proxy in production. Do not rely on `NODE_USE_ENV_PROXY` for the event.

### Defects found

- **A. A failed readiness check cannot tell an outage from a rejected credential, and it lasts too long.** A TLS or network failure logs `token refresh failed; run boc login`, the same message as a revoked token. Either way the subscription is skipped until a later check passes, and in event mode that check is the next day's T−30. So a short network blip during the start check or the T−5 recheck makes the release run with no subscription, even if the network recovers a minute later.
- **B. A provider outage during a solve burns every attempt within milliseconds.** Network errors and 5xx responses are neither a usage limit nor a rejected credential, so each attempt ends as `failed`, counts toward the cap of 4, and the next one starts at once. The part then gives up permanently, with no failover and no retry later.
- **C. Credit exhaustion mid-attempt gives up the part instead of failing over.** Only the start of an attempt checks whether a subscription can afford it (`minimumAttemptCredits`). A denial inside an attempt ends the part as `gave-up (budget-exhausted)`, even when another subscription on a separate pool has credits.
- **D. A crash leaves a lock that blocks a restart.** The message does not say that the holder is dead or suggest `boc ledger break-lock`. With systemd `Restart=on-failure` on an unattended host, BoC would refuse to start until the operator intervenes.

### Fixes and live rerun (2026-09-29)

Defects A–D are fixed (D024) and covered by offline regression tests. The drills were rerun live in fresh storage (`var/bench/drill-2025b`, `drill-2025b-quota`), with the drill proxy now answering 503 and able to cut Copilot alone:

| # | Drill | Result |
| --- | --- | --- |
| 1b | Every provider unreachable from the start, lifted after about 4.5 minutes | Both start checks were classified as unreachable and retried after 1 minute. Attempts failed over between the subscriptions with backoff (15 s, 30 s, 60 s, 120 s); eight refusals were not counted as attempts. The first retry after recovery came 17 s later, and both parts were solved on the first submission. |
| 2b | Copilot-only outage 4 s into attempt 1 | Failed over to Codex within 10 ms. Solved on the first submission. |
| 2c | Full outage 4 s into attempt 1, lifted after 45 s | Waited with backoff. The retry came 80 ms after recovery. Solved on the first submission. |
| 3b | `kill -9` mid-call, then a plain rerun | Both stale locks were removed automatically. The run resumed and solved both parts with one submission each. The killed call's reservation (13.00) stays held as an unknown charge. |
| 4d | Copilot per-puzzle limit 15 | `attempt 1 stopped: credits exhausted on copilot`, then attempt 2 on Codex. Solved on the first submission. |

- **A real transient failure.** During the rerun, Copilot's start check once failed with no drill proxy involved. It was classified as unreachable, and three checks a minute later succeeded. Before D024 this would have read `run boc login` and skipped Copilot for the rest of the run.
- **Credits:** Copilot 7.89 spent plus 13.00 held; Codex 2.90.

## Live AoC drills (2026-09-29)

Supervised, agent-run with the operator's go-ahead, on AoC 2024. Days 1–12 of 2024 were unsolved on the dedicated account. Private configs: `var/drill-aoc-2024*.config.json`, with storage under `var/bench/drill-aoc-2024*`. Alerts were enabled, so real ntfy pushes and healthchecks.io pings were sent. Credits: Copilot 8.77, Codex 0. Before the drills, the operator had four held reservations settled at 0 (`operator:2026-09-29-operator-instruction-settle-zero`): 13.07 and 13.02 in `drill-2025`, 13.00 in `drill-2025b`, and 3.39 in `bench-sol-2024`.

| # | Drill | Result |
| --- | --- | --- |
| A1 | Expired session: a random cookie, then renewal | **First try: failed.** AoC answers an unknown session cookie with **HTTP 500** (both a 96- and a 128-character hex value), not with the redirect seen without any cookie. The session check reported "could not be verified", so the start check passed, and the puzzle read stopped the run with "Unexpected AoC HTTP status" (**defects E, F**). **After the D025 fixes: passed.** The start check reported the session rejected. The page read waited for a new cookie, with an urgent alert. After the cookie was replaced (the config's path is a symlink that was re-pointed, so the secret was never copied), BoC continued within a minute and solved day 1 on the first submission for each part. |
| A2 | `kill -9` right after the `submitting` log line | The write-ahead record left the part `submitting`, and the rerun removed both stale locks by itself. The page showed the level still open, so reconciliation marked the answer `not-correct`, blocking it. Attempts 2–4 each re-derived the same answer and, as instructed, did not propose a rejected answer; the part gave up. No answer was ever resubmitted. The answer was very probably correct and never judged (**defect G**). |
| A3 | Duplicate protection across storages: a fresh storage on the already-solved day 1 | Both parts were adopted from the answers shown on the page. Three AoC reads, no model call, no submission, 0 credits. Before this session's fix, the model would have solved the day again and BoC would have resubmitted. |

### Defects and findings

- **E. A rejected session passed the session check.** `/settings` answers an unknown cookie with 500. Fixed (D025): a 500 counts as `logged-out` when a cookie-less read of the public `/about` page succeeds.
- **F. Any 5xx on a page read stopped the whole run,** whether from an expired cookie or from AoC under load at release. Fixed (D025): page reads are retried within the day's retry window, and a rejected session waits for a replaced cookie file.
- **Adoption (fixed before the drills).** A part whose accepted answer is already on the page is recorded as solved (`part-adopted`), with no model call or submission.
- **G. A crash between the write-ahead record and AoC's response can lose the part.** Fixed by the operator's choice of one automatic resubmission (D026). Reconciliation cannot tell "never judged" from "judged wrong" when the level is still open, so it blocks the answer (AOC.md, "Not yet handled"). The model then re-derives the same answer and cannot propose it. The attempts are wasted, and the part gives up. `boc submission not-judged` cannot revive a part that has given up. The window is short, about 0.1–0.9 s per submission.
- **Brake after a session recovery.** Fixed (D026): session checks have their own brake window. In A1 the failed-session traffic plus the normal burst came to 10 requests. The per-process brake (10 per 10 minutes) then held part 2's correct answer for 7.7 minutes.
