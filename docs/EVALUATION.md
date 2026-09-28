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

## Model benchmark: `gpt-6-luna` vs `gpt-6-sol` on Codex (2026-09-28, in progress)

Method: `boc replay` (src/bench/replay.ts) reruns the normal solve loop on days BoC already solved. Statements and inputs come from the source run's private cache, and proposals are judged against the answer AoC accepted. It never contacts AoC and never reads the cookie. The solver sees only what a live run would see. A wrong answer's embargo is simulated rather than slept, and feedback is a plain "wrong" with no too-high or too-low hints. Model calls are real and ledger-admitted in separate bench storage (300/100 per config). Each part is one sample, so this is indicative, not statistically strong.

Codex rates are from the [Codex pricing page](https://developers.openai.com/codex/pricing), fetched 2026-09-28. Luna costs 2.5 input, 0.25 cached input, and 12.5 output credits per 1M tokens, 1/20 of sol's.

| Run | Scored parts | Correct | First submission correct | Median / mean s per solved part | Codex credits |
| --- | --- | --- | --- | --- | --- |
| luna, 2025 days 1–12 | 23 | 23 | 23 | 19.4 / 24.0 | 1.14 |
| luna, 2024 days 13–25 | 25 | 23 | 23 | 20.4 / 32.1 | 3.41 |
| sol, 2025 days 1–10 part 1 (valid part of the run) | 19 | 19 | 19 | 14.0 / 14.7 | 7.96 (incl. zero-cost refusals) |

- **Luna failures:** both were on harder 2024 part 2s (days 15 and 24). They used all four attempts with two wrong submissions each.
  - Twice, luna re-proposed an answer that had already been rejected. The orchestrator refused to resubmit it, but the attempt was spent.
  - On day 24 part 2, luna proposed answers with `??` placeholders, which is guessing.
- **Latency:** on the easy 2025 days, luna was not faster than sol; it was slower per solved part.
- **Sol run interrupted:** from 2025 day 10 part 2 onward, every sol request failed before any output, at zero charge. The private diagnostics show that the Codex OAuth token was invalidated server-side. This is not a model result, and those parts are excluded.

### Defects found

- **Provider refusals burned attempts.** A rejected credential or a usage limit made every attempt fail within milliseconds, so BoC gave up on every remaining part. In a live event this would forfeit the day. Fixed:
  - The guard reduces provider errors to safe categories (usage limit, with reset minutes when given; rejected credential; other).
  - A refusal ends the part as `provider-unavailable` after one attempt, and the run stops with a clear message.
  - The raw provider error goes only into a private `provider-error.txt` beside the attempt transcript.
- **Re-proposing a rejected answer wastes an attempt.** Found with luna; not yet fixed, so the sol baseline runs under identical conditions. See PLAN.md.
