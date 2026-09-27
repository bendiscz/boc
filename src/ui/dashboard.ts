import { formatCredits } from "../budget/credits.ts";
import type { CounterStatus, LedgerStatus } from "../budget/ledger.ts";
import type { PuzzleId } from "../state/ids.ts";
import type { PartState, RunState } from "../state/run-state.ts";

/**
 * Plain-text dashboard for the terminal view. Pure rendering from journal-backed
 * state, so it shows exactly what recovery would see; never secrets (answers and
 * puzzle IDs only, which already live in private storage and the local terminal).
 */

export interface DashboardInput {
  readonly state: RunState;
  readonly ledger: LedgerStatus;
  readonly current: PuzzleId | undefined;
  readonly events: readonly string[];
  readonly now: Date;
}

const PHASE: Record<PartState["status"], string> = {
  locked: "waiting",
  ready: "ready",
  solving: "solving",
  proposed: "answer proposed",
  submitting: "submitting",
  uncertain: "UNCERTAIN (needs reconciliation)",
  solved: "solved",
  "gave-up": "gave up",
};

function part(p: PartState): string {
  const detail =
    p.status === "solved"
      ? ` ${p.solvedAnswer ?? ""}`
      : p.status === "gave-up"
        ? ` (${p.gaveUpReason ?? ""})`
        : p.status === "solving"
          ? ` #${p.activeAttempt ?? "?"}${p.lastSubscription ? ` via ${p.lastSubscription}` : ""}`
          : "";
  return `${PHASE[p.status]}${detail}`;
}

function credits(c: CounterStatus): string {
  const flag = c.exceeded ? " EXCEEDED" : "";
  return `${formatCredits(c.spent)} spent, ${formatCredits(c.reserved)} held, ${formatCredits(c.remaining)} left of ${formatCredits(c.limit)}${flag}`;
}

function clip(line: string, width: number): string {
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

export function renderDashboard(input: DashboardInput, width = 100, recent = 8): string {
  const lines: string[] = [];
  lines.push(`Bot of Code — ${input.state.eventYear}    ${input.now.toISOString().slice(0, 19)}Z`);
  lines.push("");
  const current = input.current ? input.state.puzzles[input.current] : undefined;
  if (input.current) {
    lines.push(
      current
        ? `Now: ${input.current}  part 1: ${part(current.parts[1])}  |  part 2: ${part(current.parts[2])}`
        : `Now: ${input.current}  waiting for release`,
    );
  } else {
    lines.push("Now: idle");
  }
  if (
    input.state.submitNotBefore &&
    Date.parse(input.state.submitNotBefore) > input.now.getTime()
  ) {
    lines.push(`Answer cooldown until ${input.state.submitNotBefore}`);
  }
  if (input.ledger.fault) lines.push(`LEDGER FAULTED (${input.ledger.fault}): admission blocked`);
  if (input.ledger.pendingOverruns.length > 0) {
    lines.push(`UNACKNOWLEDGED OVERRUNS: ${input.ledger.pendingOverruns.join(", ")}`);
  }
  lines.push("", "Credits (native units per pool; never summed across pools)");
  for (const scope of ["pool", "subscription"] as const) {
    const ids = [
      ...new Set(input.ledger.counters.filter((c) => c.scope === scope).map((c) => c.id)),
    ];
    for (const id of ids) {
      const counters = input.ledger.counters.filter((c) => c.scope === scope && c.id === id);
      const event = counters.find((c) => c.period === "event");
      const puzzle = input.current ? counters.find((c) => c.period === input.current) : undefined;
      if (!event) continue;
      lines.push(`  ${scope} ${id} [${event.unit}]`);
      lines.push(`    event:  ${credits(event)}`);
      if (puzzle) lines.push(`    ${puzzle.period}: ${credits(puzzle)}`);
    }
  }
  if (input.ledger.held.length > 0) {
    const orphaned = input.ledger.held.filter((h) => h.orphaned || h.uncertain).length;
    lines.push(
      `  held reservations: ${input.ledger.held.length}${orphaned ? ` (${orphaned} need reconciliation)` : ""}`,
    );
  }
  const puzzles = Object.values(input.state.puzzles).sort((a, b) =>
    a.puzzle.localeCompare(b.puzzle),
  );
  if (puzzles.length > 0) {
    lines.push("", "Results");
    for (const p of puzzles) {
      lines.push(`  ${p.puzzle}  1: ${part(p.parts[1])}  |  2: ${part(p.parts[2])}`);
    }
  }
  lines.push("", "Recent");
  const tail = input.events.slice(-recent);
  if (tail.length === 0) lines.push("  (none)");
  for (const event of tail) lines.push(`  ${event}`);
  return `${lines.map((l) => clip(l, width)).join("\n")}\n`;
}

/**
 * Throttled full-screen redraw on the terminal's alternate screen. `close()`
 * restores the normal screen and cursor and prints the final frame there; the
 * terminal is also restored if the process exits abruptly.
 */
export function createTerminalView(output: NodeJS.WriteStream, intervalMs = 250) {
  let pending: DashboardInput | undefined;
  let timer: NodeJS.Timeout | undefined;
  let last = 0;
  let open = true;
  const restore = () => {
    if (open) output.write("\x1b[?25h\x1b[?1049l");
    open = false;
  };
  process.once("exit", restore);
  output.write("\x1b[?1049h\x1b[?25l");
  const draw = () => {
    timer = undefined;
    if (!pending || !open) return;
    last = Date.now();
    output.write(`\x1b[H\x1b[2J${renderDashboard(pending, output.columns || 100)}`);
  };
  return {
    update(input: DashboardInput) {
      pending = input;
      if (timer || !open) return;
      timer = setTimeout(draw, Math.max(0, intervalMs - (Date.now() - last)));
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      restore();
      process.removeListener("exit", restore);
      if (pending) output.write(renderDashboard(pending, output.columns || 100));
    },
  };
}
