# Operator guide

This guide covers installing, configuring, running, and recovering BoC. **No provider adapter exists yet.** GitHub Copilot is being implemented first (D016), so `boc run` currently refuses to start. Everything else described here works offline today.

## Prerequisites

- Node.js 24 LTS (24.21.0 or newer within the 24 line) and npm.
- Docker Engine on Linux, or Docker Desktop. The solver runs generated code only in networkless containers; see [SANDBOX.md](SANDBOX.md).
- A dedicated AoC account for BoC, and provider subscriptions whose use by BoC is permitted.

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

## Solver image

Build the toolchain image once per event on a trusted host, then record its ID:

```sh
docker build --build-arg UV_VERSION=<pinned> -t boc-solver:dev sandbox
# Behind a TLS-intercepting proxy, add: --secret id=extra_ca,src=/path/to/ca.pem
docker image inspect boc-solver:dev --format '{{.Id}}'
npm run test:executor -- <image-id> --toolchains   # verify isolation and toolchains
```

Put the ID in the configuration as `sandbox.image`.

## Private files

Keep credentials in ignored `.secrets/` or outside the repository. Keep runtime data in ignored `var/` or outside the repository. Never paste secrets into chat, issues, or Git.

- **AoC session cookie:** one line, the value of the `session` cookie for the dedicated account. The file must be a regular file owned by you with mode `0600`:

  ```sh
  install -m 600 /dev/null .secrets/aoc-session && $EDITOR .secrets/aoc-session
  ```

  Session cookies expire. An auth error in a run means the file needs a new value.
- **`aoc.contact`:** your email or URL. It is sent in the `User-Agent` of every AoC request, as the site asks.
- **Storage directory:** created with `0700`. It holds puzzle text, inputs, transcripts, answers, and journals. **Do not publish any of it.**

## Budgets

Budgets are AI credits in each provider's native unit; see [CONFIGURATION.md](CONFIGURATION.md). Every subscription and every pool has an event limit and a per-puzzle limit, and each call's padded estimate must fit within all four. **Limits are best effort (D016).** A limit can be exceeded by up to one call's excess over its estimate, plus the pool's `overshootTolerance`. Configure a provider-side spending cap where the provider offers one, set `providerCap: "configured"`, and keep each subscription's `estimate.rates` in line with the provider's current price list. Zero means nothing is admitted. Lowering limits mid-event is allowed; renaming or rebinding subscriptions or pools is refused so that history cannot be reset.

```sh
node dist/main.js check-config boc.config.json
```

## Running

```sh
node dist/main.js run boc.config.json                 # day 1 upward, waiting for releases
node dist/main.js run boc.config.json --days 3,4      # specific (e.g. past) days
node dist/main.js run boc.config.json --tui           # live dashboard
```

- BoC sleeps until each release (midnight EST) and never polls. Right after release it fetches the page and input, then submits answers without artificial delays. It honours every server-reported wait.
- **Ctrl-C** stops after the current step, with exit code 130. Running again resumes from the recorded state. A second Ctrl-C forces exit; the journals stay consistent regardless.
- A part also ends on exhausted credits, the attempt limit, or a submission whose outcome is uncertain. The run then continues with the next day, and a later run resolves the uncertain submission by reading the puzzle page.
- A provider fault (a charge that cannot be settled) stops the whole run until you reconcile it.

## Monitoring

- `node dist/main.js status boc.config.json` shows read-only state and credits. It is safe while BoC runs.
- `node dist/main.js views boc.config.json` regenerates `INDEX.md`, `runs/<year>/SUMMARY.md`, and the per-puzzle `README.md` files.
- `runs/<year>/events.log` is the timestamped run log.
- `puzzles/<year>/day-NN/part-P/attempt-NNN/` holds each attempt: `work/` (the generated files) and `transcript.json`.

## Recovery

Stop BoC before any command that changes state. They all take the same locks.

| Situation | What to do |
| --- | --- |
| "locked by another process" after a crash | `node dist/main.js ledger break-lock boc.config.json` (only for a dead process on this host). For the run-state lock, remove `runs/<year>/journal.lock` after confirming no BoC process is running. |
| Held / orphaned / uncertain reservations | Find the actual charge in the provider's usage records, then `ledger settle boc.config.json <id> <amount> operator:<receipt-ref>`. Held credits stay counted until settled. |
| Unacknowledged overrun (admission blocked) | Investigate, then `ledger acknowledge boc.config.json <id> <note>`. The spent amount stays recorded. |
| Uncertain submission | The next run reads the puzzle page to resolve it. If AoC provably never judged it (for example, an auth rejection), use `submission not-judged boc.config.json <day> <part> <n> <note>`. A new attempt may then propose the answer again; nothing is resubmitted automatically. |
| Expired AoC session | Replace the cookie file content, then run again. |
| Corrupt journal | BoC refuses to open it. Keep a copy, and do not delete or edit it without understanding the damage: the journals are the record of credits spent and answers submitted. |

## Before each event

- Recheck the AoC About/FAQ and automation guidance ([AOC.md](AOC.md)), provider policies, and credit semantics ([FEASIBILITY.md](FEASIBILITY.md)).
- Rebuild or verify the solver image, and run `npm run check`.
- Check that the cookie is valid (a manual past-puzzle run with a small budget), then check the budgets and `status`.
