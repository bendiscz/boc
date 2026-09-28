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
