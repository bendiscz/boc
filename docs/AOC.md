# AoC access and site conduct

Rechecked on **2026-09-27** from documentation only. No puzzle pages, inputs, or solutions were fetched, and BoC made no AoC requests. Recheck before live use and before each event.

## Sources and findings

1. [AoC About/FAQ](https://adventofcode.com/about), fetched directly:
   - Puzzles unlock at **midnight EST/UTC-5**. They start on December 1, "Day 1 = Dec 1", and "puzzles come out every day (ending mid-December)". The number of days per event changed and is not hardcoded (`src/aoc/calendar.ts`).
   - "Should I use AI to solve Advent of Code puzzles? No." Private leaderboard expectations are set by their organizers. The operator's leaderboard permits AI/bots (D005). BoC must not present itself as human participation.
   - "Please don't" copy or redistribute puzzle text or inputs. These stay in private storage (D005).
   - The global leaderboard was removed. Do not use leaderboard data to create one; BoC has no leaderboard feature.
2. Automation guidance from the site author's r/adventofcode posts, seen through search-result excerpts. The posts could not be rendered directly, so treat this as secondary evidence. The subreddit wiki "Automation" page could not be fetched.
   - "[Reminder: Please throttle your AoC traffic](https://www.reddit.com/r/adventofcode/comments/1pa472d/reminder_please_throttle_your_aoc_traffic/)": "Please don't make frequent automated requests - avoid sending requests more often than once every 15 minutes (`900` seconds)." The sender is responsible for throttling, "even if your code misbehaves because it has a bug". The post asks for contact info in the `User-Agent`.
   - "[Please include your contact info in the User-Agent header](https://www.reddit.com/r/adventofcode/comments/z9dhtd/please_include_your_contact_info_in_the_useragent/)": contact info of the maintainer of the code sending requests belongs in every request's `User-Agent`.
   - Community automation rules as commonly quoted: cache inputs after the initial download, throttle outbound requests, and set the `User-Agent` header.

## Implemented conduct (offline, fake transport only)

- `src/aoc/client.ts` is trusted-orchestrator only:
  - It is pinned to `https://adventofcode.com`, with paths built from validated integers.
  - The cookie is read from an owner-only regular file owned by the current user. It is never included in errors or return values.
  - The `User-Agent` is `BotOfCode/<version> (+https://github.com/bendiscz/boc; contact: <aoc.contact>)`, and a contact is required.
  - Requests are serialized without artificial spacing, capped by the sliding-window bug brake. They time out after 30 s and have bounded responses. Redirects are never followed and there are no retries.
- `src/aoc/service.ts`:
  - Inputs and statements are cached in private storage and recorded by hash. A recorded input that disappears is not silently re-downloaded.
  - Submissions are write-ahead and send at most one request per proposal. Unknown outcomes become `uncertain` and are reconciled only by *reading* the puzzle page.
  - Server waits become an event-wide embargo with a margin.
- `src/aoc/calendar.ts` waits by sleeping, not polling. The retry delays for a just-released puzzle that is still reported unavailable are 15 s, 30 s, 60 s, and then 900 s.
- Response phrase matching (`src/aoc/parse.ts`) reproduces the site's long-standing wording from memory. It is **not** validated against live responses. Unrecognized text is always `uncertain`.

## Operator decision: request pacing (2026-09-27)

The operator decided that BoC must **not** wait between the puzzle page, input, and answer requests when solving a newly released puzzle. That burst is no different from real users right after release. BoC must not send requests *needlessly*. It applies the 15-minute guidance to repeated or automated traffic that has no new purpose, and implements it as follows:

- **Waiting for a release:** sleep until the release time plus 1 s, with no polling. At release, the puzzle page and the input are requested together (D030). If a just-released puzzle is still reported unavailable (clock skew), make a few bounded retries: 1 s, 2 s, 5 s, 15 s, 30 s, 60 s, then 900 s.
- **Further answer attempts:** obey the wait AoC reports after a wrong or too-recent answer. The embargo is event-wide and includes a margin. A conservative default applies when the wait cannot be parsed. Never resubmit a judged answer or an answer with an unknown outcome.
- **Repeated downloads:** none. Statements and inputs are cached; reconciliation reads the puzzle page once per explicit call.
- **AoC errors (D025):** AoC answers an unknown or expired session cookie with HTTP 500 (observed live on 2026-09-29), not with a redirect. The session check tells this apart from an outage with a cookie-less read of `/about`. Page reads retry transient failures after 15 s, 30 s, 60 s, then every 15 minutes, and wait for a replaced cookie when the session is rejected, both until 6 hours after release. Answers are never retried.
- **Session check (D022, D029):** one authenticated read of `/settings` at start, daily while waiting for a release more than a day away, and 30 minutes before each unreleased day, plus one recheck at T−5 only after a failure. It catches an expired cookie before the release. Verified live on 2026-09-28 with a valid session (HTTP 200 with the logged-in marker, one request); the operator confirmed that without a valid session it redirects to `/2025`, which BoC classifies as `logged-out`.
- **Bug brake:** the client caps request starts in a sliding window, by default 10 per 10 minutes (`rateCap`). A single day's burst (about five requests) stays below this cap, but back-to-back past days reach it after two days, so a multi-day past run pauses for several minutes. Each wait is logged and abortable. A runaway loop is slowed rather than allowed to hammer the site. This is not pacing: normal bursts go out immediately. Session checks and their `/about` probe have their own window with the same cap, so they never delay puzzle requests (D026).

## Final day's part 2

The final day's part 2 has no puzzle. Once every other star is earned, the page shows a button whose form posts a hidden, fixed `answer`. From memory of past events; validated live on 2025 day 12 (2026-09-28, EVALUATION.md):

- **Before the model runs:** for every part 2, BoC reads the answer form from the cached statement.
- **Hidden answer (the button):** the orchestrator records a model-free attempt (`subscription: orchestrator`) that proposes the hidden value. The normal submission path then applies: write-ahead record, embargo, and duplicate refusal. The response is not the usual "right answer" text, so it becomes `uncertain`. One page read then reconciles it: a complete page with no part-2 answer counts as correct.
- **No form (stars missing):** BoC spends nothing and returns `needs-stars`. A cached page without a form is refetched once per run, because stars earned on other days change it.
- **Button already pressed without success:** a judged earlier submission of the hidden value makes BoC give up the part (`fixed-answer-rejected`) instead of looping.

## Not yet handled

- The event calendar page, used to discover how many days an event has.
- Exact AoC wording for every response variant.
- Mapping of logged-out puzzle pages beyond the `class="user"` marker.
- Reconciliation marks an answer `not-correct` when the page shows the part still unsolved at the same level. The live drill A2 (EVALUATION.md, defect G) showed the consequence: the part then gives up, and the override cannot revive it. The operator chose one automatic resubmission in this case (D026). An answer the server never judged (for example, one rejected with an auth error) is then also blocked from resubmission. This errs toward never duplicating. An operator with evidence can run `boc submission not-judged <config> <day> <part> <n> <note>`. It unblocks the answer and returns an uncertain part to `ready`; it never submits anything by itself.
