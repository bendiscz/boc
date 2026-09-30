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

### Rerun after D026 (2026-09-29)

- **A2b** (2024 day 3): `kill -9` 50 ms after the `submitting` log line. The kill again landed before AoC recorded the answer. The rerun removed both stale locks, reconciled the answer as `not-correct` (the level was still open), and started attempt 2. That attempt re-derived the same answer and proposed it (the prompt now calls its outcome unknown). The one allowed resubmission was judged correct, and part 2 followed on its first submission. Eight AoC requests; the brake never engaged.
- Credits for all live AoC drills: Copilot 11.82492, Codex 0.

## AoC 2024, days 2 and 4–12 (2026-09-29)

A supervised live run by the agent with the operator's go-ahead: `boc run` with a copy of the event config (failover Copilot → Codex, D021–D026), event 2024, storage `var/bench/finish-2024`, alerts off. It used a single process with headless output.

- **Correctness:** 20 of 20 parts correct, each on its first attempt and first submission. Day 2 part 1 gave the same answer that drill A2 had re-derived three times without being allowed to propose it. That confirms AoC had never judged that interrupted submission (defect G).
- **Credits:** Copilot 24.74 (the failover never triggered), Codex 0.
- **Brake:** as expected, it paused for about 9 minutes after every two days.
- **Host sleep:** one unexplained 12-minute gap before day 7 matched idle sleep on the development Mac (`pmset` log). The rest of the run was kept awake with `caffeinate`. This is not a BoC defect, but it is one more reason for a dedicated host that never sleeps.
- **Account state:** AoC 2024 days 1–24 are now fully solved on the account, and day 25 part 1 is solved. Day 25 part 2, the final-day button, now has every other star and can be pressed.

## AoC 2019, all days (2026-09-29)

A supervised live run by the agent with the operator's go-ahead: `boc run --days 1..25` with a copy of the event config (Copilot first, Codex failover, both `gpt-6-sol`, 300/100 limits), storage `var/bench/eval-2019`, alerts off, kept awake with `caffeinate`. 2019 is a demanding benchmark: 12 days build on the Intcode computer (days 2, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25). They include interactive programs (a breakout game, a maze-exploring robot, a network of 50 machines, a text adventure), and each attempt starts from a fresh workspace, so the solver rebuilt the interpreter every time.

- **Correctness:** 48 of 50 parts solved, 47 of them on the first submission.
  - Day 11 part 2 gave up after 4 wrong answers.
  - Day 25 part 2 (the button) is `needs-stars` because of day 11.
  - Day 25 part 1, the Intcode text adventure, was solved in one attempt of 46 s.
- **Extra attempts:**
  - Day 8 part 1: the first attempt ended with a response cut off at the output cap or time limit; the retry was correct.
  - Day 14 part 1: a real Copilot outage (below).
  - Day 11 part 2: see the defect below.
- **Real Copilot outages:** two, on day 11 part 2 and day 14 part 1. Both were classified as `outage` and handled as D024 intends. Day 11 failed over to Codex; day 14 was retried on Copilot after the backoff, while Codex took over no other part. Neither counted as an attempt.
- **Credits:** Copilot 105.63 and Codex 3.02, with every reservation settled. The costliest days were day 8 (16.01, including the cut-off response, which D016 charges conservatively), day 18 (7.56, the key maze), and day 17 (6.18). Every other day cost under 5.4.
- **Latency:** the median from the first attempt to the correct verdict was 32 s over 48 parts. Several part 1 times of 344 s are the bug brake holding the answer submission during back-to-back past days, not solving time.

### Defect found

- **H. Letters drawn as ASCII art are misread.** Day 11 part 2's program printed eight capital letters in the 4×6 block font of past AoC events. Codex (after the Copilot outage) proposed four different readings within 3 minutes, all wrong. The private transcript shows that the rendered text was clean and unambiguous, and it was read by eye one glyph at a time. Day 8 part 2 used the same font and was read correctly (Copilot), so the failure is intermittent. Each wrong reading also costs a submission and a wait, which works against "never guess".
  - Possible remedies, for the operator to decide:
    - (a) Prompt guidance: decode letter art programmatically, compare glyphs, and never propose a reading that is not certain.
    - (b) A general-purpose OCR library for this font, preinstalled in the solver image. This counts as a freely available library, not a puzzle solution (D004, D010).
    - (c) Refuse, within an attempt, a new reading that differs from a rejected one in only one or two characters.

### Fix and rerun (D028, 2026-09-29)

- **The fix:** remedies (a) and (b): prompt guidance plus the preinstalled `advent_of_code_ocr` library. The solver image was rebuilt as `sha256:7e4e65ecaffd…`.
- **Fresh storage `var/bench/eval-2019b`, days 11 and 25:**
  - Day 11 part 1 and day 25 part 1 were adopted from the page.
  - **Day 11 part 2 was solved on the first attempt and first submission** (Copilot, 2.12 credits). The program decoded the letters with `convert_6`.
  - The day 25 button then failed with `Invalid run-state transition: input missing`: an adopted part 1 never downloads the input, but the model-free button attempt required it. This is fixed (the orchestrator's button attempt no longer needs an input), with a regression test. The rerun pressed the button: `uncertain`, then reconciled as correct.
  - **AoC 2019 is complete on the account (50 stars).**
- **Codex replay** (`var/bench/ocr-2019a`, source `eval-2019`): day 8 part 2 was solved on the first submission, using `convert_6` (1.23843 Codex credits for the day).
  - Day 11 could not be replayed, because the replay's leak guard refuses a cached part 1 page that shows its answer. Codex on day 11 therefore remains untested.

## Raspberry Pi 5 replay benchmark (2026-09-30)

A replay on the Pi (`boc@boc.local`, while `boc.service` was stopped by the operator), with the operator's go-ahead. It used the event subscriptions (Copilot first), config `var/bench-pi-2019.config.json`, and the source `var/bench/eval-2019`, copied from the Mac. The days were 2019 days 12, 16, 18, 20, 22, and 24, among the more compute-heavy on the Mac.

- **Correctness:** 12 of 12 parts correct, each on its first attempt and first submission. Copilot 26.54 credits; Codex 0. Wall time 3 min 11 s, and 8–31 s per part from attempt start to verdict.
- **Program runs:** no run timed out. The longest program took 4.9 s (day 16 part 2), and a trivial run took 0.4–1.1 s including container start-up (0.1–0.2 s on the Mac).
- **CPU speed:** the same pure-Python workload in the same solver image (`--cpus=2`) took 3.59 s on the Pi against 0.75 s on the Mac, so the Pi is about **4.8× slower** per core.
- **Headroom against the 60-second run cap:** across all 397 program runs BoC has made on the Mac (every evaluation and benchmark storage), the 99th percentile was 3.3 s, and only one run exceeded 10 s. That was 12.3 s, by `gpt-6-luna`, which is not the solving model. At 4.8×, that run would take about 59 s on the Pi. Typical programs keep a large margin; a rare heavy one could hit the cap on the Pi where it would not on the Mac.

## Faster solving (D030): Pi replay (2026-09-30)

The same replay as the Pi benchmark above (2019 days 12, 16, 18, 20, 22, and 24; the event subscriptions; Copilot first), rerun after D030 in fresh storage `var/bench/pi-2019-fast`, with `boc.service` stopped by the operator.

| | Before (`pi-2019`) | After (`pi-2019-fast`) |
| --- | --- | --- |
| Correct on the first submission | 12/12 | 12/12 |
| Model turns per attempt (mean) | 4.17 | **2.25** |
| Attempts that read `input.txt` | 11 of 12 | 0 |
| Attempts proposed from a run | 0 | 12 of 12 |
| Time per part, attempt start to verdict (median / total) | 13.8 s / 188 s | **12.0 s / 174 s** |
| Copilot credits | 26.54 | 23.91 |

- **Turns:** as intended, the reading and copying turns are gone. Most attempts are now `write_file`, then `run(proposeOnSuccess)`.
- **Time:** the gain is only 8% in total (13% on the median). The remaining turns take longer, about 6.4 s against 3.8 s, because the program-writing turn now also writes the checks against the examples. Each part is a single sample, and per-part times vary by run (day 18 part 1 took 26 s before and 37 s after). The warm container and the concurrent release reads are not visible in a replay, which reads from the cache.
- **Credits:** about 10% fewer, because there are fewer turns that resend the context.
- **Conclusion:** accuracy was unchanged, and time and credits were modestly lower. Almost all of the remaining time is the model's own generation, so further gains would have to come from the model side (for example its reasoning setting), measured the same way.

## Reasoning effort (D031): Pi replay (2026-09-30)

The same six 2019 days on the Pi with Copilot (`gpt-6-sol`), on the D030 code, one run per level in fresh storage (`var/bench/pi-2019-r-*`). The reasoning configs set `assumedMaxOutputTokens` to 32000. The baseline is the provider-default run `pi-2019-fast`.

| Effort | Correct (first submission) | Total / median time per part | Model turns per attempt | Output / reasoning tokens | Copilot credits |
| --- | --- | --- | --- | --- | --- |
| default (unset) | 12/12 | 174 s / 12.0 s | 2.25 | 10660 / 1457 | 23.91 |
| **low** | 12/12 | **130 s / 11.1 s** | 2.08 | 8084 / 508 | **20.23** |
| medium | 12/12 | 158 s / 11.0 s | 2.58 | 10944 / 1795 | 24.54 |
| high | 12/12 | 200 s / 14.3 s | 2.33 | 12810 / 2643 | 26.61 |

- **The parameter takes effect:** reasoning tokens rise with the effort, and the default sits between `low` and `medium`.
- **Time and cost:** `low` was the fastest (25% below the default in total) and the cheapest (15% fewer credits). `high` was the slowest. The spread comes mostly from a few parts (day 18 part 1: 15 s at `low`, 36 s at `medium` and `high`).
- **Accuracy:** no difference, because every level solved all 12 parts. **These days are not hard enough to show what reasoning buys**: any accuracy gain from more effort would appear on the hardest parts, where BoC has needed several attempts or long responses. With one sample per part, per-part times are noisy.
- **Suggested before adopting `low`:** a replay of the hardest parts BoC has seen, at `low` against the default, on accuracy and time. Examples are AoC 2024 day 15 part 2 and day 24 part 2 (sol's longest), AoC 2019 day 18, and the 2019 letter-art parts. Codex has not been measured.

### Hardest past parts: `low` against the default (2026-09-30)

The follow-up suggested above: the parts that took BoC the most attempts or time in earlier runs. The sets were AoC 2024 days 12, 15, 16, 20, 21, and 24 (12 parts; the sources `finish-2024`, `eval-2024-copilot`, and `eval-2024-codex` were copied to the Pi), and AoC 2019 days 8, 14, 17, and 25 (7 scored parts; day 25 part 2 is the button). Both levels used `assumedMaxOutputTokens` 32000, so the reasoning setting was the only difference. The runs were on the Pi with Copilot, one sample per part, in storage `var/bench/hard-{2024,2019}-{default,low}`.

| Set | Effort | Correct (first submission) | Total time | Copilot credits |
| --- | --- | --- | --- | --- |
| 2024 | default | 12/12 | 174 s | 25.55 |
| 2024 | low | 12/12 | 164 s | 21.66 |
| 2019 | default | 7/7 | 201 s | 21.52 |
| 2019 | low | 7/7 | 97 s | 11.40 |

- **Accuracy:** equal. All 19 parts were solved on the first submission at both levels, including the parts where sol and luna had needed several attempts before (2024 day 15 part 2 and day 24 part 2) and the letter-art part (2019 day 8 part 2).
- **Time:** `low` was 30% faster over the 19 parts (262 s against 375 s). The largest difference was the 2019 day 25 text adventure, 107 s against 30 s. The 2024 set differed little (−6%).
- **Credits:** `low` used 30% fewer (33.06 against 47.07).
- **Overall:** with the six easier days above, `low` matched the default on all 31 parts, and was faster and cheaper in every set. This is still one sample per part, and it covers Copilot only; Codex, the failover, is unmeasured.

### Codex: `low` against the default (2026-09-30)

A short replay with Codex alone (`gpt-6-sol`), on the Pi with the service stopped. It covered the 2019 hard set (days 8, 14, 17, and 25; 7 scored parts) and 2024 days 15, 21, and 24 (6 parts), with `assumedMaxOutputTokens` 32000 at both levels and one sample per part, in storage `var/bench/codex-{2019,2024}-{default,low}`.

| Set | Effort | Correct | First submission | Total time | Codex credits |
| --- | --- | --- | --- | --- | --- |
| 2019 | default | 7/7 | 7/7 | 549 s | 7.71 |
| 2019 | low | 7/7 | 6/7 | 370 s | 4.95 |
| 2024 | default | 6/6 | 6/6 | 502 s | 19.31 |
| 2024 | low | 6/6 | 6/6 | 297 s | 5.27 |

- **Accuracy:** every part was solved at both levels.
  - At `low`, 2019 day 14 part 2 was first answered off by one. The program printed an `ANSWER` line for an example and one for the input, and the model proposed the input's value by hand, not through `proposeOnSuccess`. The next attempt was correct. In a live event this costs one wrong answer and its wait, about a minute.
  - At the default, 2024 day 15 part 2 had a response stopped at the output cap or time limit, and needed a second attempt: 240 s against 33 s at `low`.
- **Time and credits:** `low` was 37% faster over the 13 parts (667 s against 1051 s) and used 62% fewer credits (10.22 against 27.03).
- **Codex is much slower than Copilot on the same parts at either level:** for example 2019 day 25 part 1 took 116–298 s against 30–107 s. As the failover, it runs only when Copilot refuses.

