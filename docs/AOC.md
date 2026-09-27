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
  - Requests are serialized with a minimum spacing, time out after 30 s, and have bounded responses. Redirects are never followed and there are no retries.
- `src/aoc/service.ts`:
  - Inputs and statements are cached in private storage and recorded by hash. A recorded input that disappears is not silently re-downloaded.
  - Submissions are write-ahead and send at most one request per proposal. Unknown outcomes become `uncertain` and are reconciled only by *reading* the puzzle page.
  - Server waits become an event-wide embargo with a margin.
- `src/aoc/calendar.ts` waits by sleeping, not polling. The retry delays for a just-released puzzle that is still reported unavailable are 15 s, 30 s, 60 s, and then 900 s.
- Response phrase matching (`src/aoc/parse.ts`) reproduces the site's long-standing wording from memory. It is **not** validated against live responses. Unrecognized text is always `uncertain`.

## Open question for the operator (before live use)

The request-rate guidance's scope is ambiguous for a racing bot. Read literally, "no more than once every 15 minutes" for *all* requests would allow roughly one action per quarter hour. Downloading the puzzle, downloading the input, and submitting are at least three requests per part. Current behaviour is event-driven, with no polling and a 5-second minimum spacing between discrete actions. This matches common tooling but is **an interpretation, not confirmed**. Before live submissions (milestone 6), the operator should confirm the acceptable rate, or BoC should adopt the literal 900-second spacing at the cost of speed. The spacing is a client option (`minIntervalMs`).

## Not yet handled

- The final day's special part 2 (it has no normal answer form).
- The event calendar page, used to discover how many days an event has.
- Exact AoC wording for every response variant.
- Mapping of logged-out puzzle pages beyond the `class="user"` marker.
- Reconciliation marks an answer `not-correct` when the page shows the part still unsolved at the same level. An answer the server never judged (for example, one rejected with an auth error) is then also blocked from resubmission. This errs toward never duplicating. Operator override tooling does not exist yet.
