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
- **Re-proposing a rejected answer wastes an attempt.** Found with luna and seen again in the rerun. Not yet fixed; see PLAN.md.
