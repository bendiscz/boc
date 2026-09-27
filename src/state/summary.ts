import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatCredits } from "../budget/credits.ts";
import type { LedgerStatus } from "../budget/ledger.ts";
import type { PuzzleId } from "./ids.ts";
import { type Layout, writeFileAtomic } from "./layout.ts";
import type { PartState, PuzzleState, RunState } from "./run-state.ts";

/** Readable, derived Markdown views. Journals remain authoritative. */

function cell(value: string): string {
  return value.replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`);
}

function partCell(part: PartState): string {
  const detail =
    part.status === "solved"
      ? ` (${cell(part.solvedAnswer ?? "")})`
      : part.status === "gave-up"
        ? ` (${cell(part.gaveUpReason ?? "")})`
        : "";
  return `${part.status}${detail}, ${part.attempts} attempts, ${part.submissions.length} submissions`;
}

function puzzles(state: RunState): PuzzleState[] {
  return Object.values(state.puzzles).sort((a, b) => a.puzzle.localeCompare(b.puzzle));
}

export function renderEventSummary(state: RunState, ledger?: LedgerStatus): string {
  const lines = [`# BoC run summary — ${state.eventYear}`, ""];
  lines.push("Derived from the run-state and ledger journals; private — do not publish.", "");
  lines.push("Run log: [events.log](events.log)", "");
  if (state.submitNotBefore)
    lines.push(`Submissions embargoed until ${state.submitNotBefore}.`, "");
  lines.push("## Puzzles", "");
  const all = puzzles(state);
  if (all.length === 0) {
    lines.push("No puzzles recorded yet.");
  } else {
    lines.push("| Puzzle | Part 1 | Part 2 |", "| --- | --- | --- |");
    for (const p of all) {
      lines.push(
        `| [${p.puzzle}](../../puzzles/${state.eventYear}/${p.puzzle}/README.md) | ${partCell(p.parts[1])} | ${partCell(p.parts[2])} |`,
      );
    }
  }
  if (ledger) lines.push("", ...renderCredits(ledger));
  return `${lines.join("\n")}\n`;
}

export function renderCredits(ledger: LedgerStatus, period?: PuzzleId): string[] {
  const lines = ["## Credits", ""];
  if (ledger.fault) lines.push(`**Ledger faulted:** ${ledger.fault}. Admission is blocked.`, "");
  lines.push(
    "Limits are best effort (D016): charges are estimated before each call and can exceed a limit by up to one call's excess plus the pool's overshoot tolerance.",
    "",
  );
  if (ledger.pendingOverruns.length > 0) {
    lines.push(`**Unacknowledged overruns:** ${ledger.pendingOverruns.map(cell).join(", ")}.`, "");
  }
  for (const o of ledger.overshoot) {
    if (o.excess > 0n) {
      lines.push(
        `**Pool ${o.pool} overshoot:** ${formatCredits(o.excess)} of tolerance ${formatCredits(o.tolerance)}${o.blocking ? " — admission blocked until acknowledged" : ""}.`,
        "",
      );
    }
  }
  lines.push(
    "Native units per pool; units from different pools are never summed.",
    "",
    "| Scope | ID | Period | Unit | Limit | Spent | Reserved | Remaining |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const c of ledger.counters) {
    if (period && c.period !== period && c.period !== "event") continue;
    lines.push(
      `| ${c.scope} | ${c.id} | ${c.period} | ${c.unit} | ${formatCredits(c.limit)} | ${formatCredits(c.spent)} | ${formatCredits(c.reserved)} | ${formatCredits(c.remaining)}${c.exceeded ? " (exceeded)" : ""} |`,
    );
  }
  if (ledger.held.length > 0) {
    lines.push("", "Held reservations (released only by an authoritative charge):", "");
    for (const h of ledger.held) {
      const notes = [h.orphaned ? "orphaned" : "", h.uncertain ?? ""].filter(Boolean).join(", ");
      lines.push(
        `- ${cell(h.id)}: ${formatCredits(h.amount)} on ${h.subscription}/${h.pool}, ${h.puzzle}${notes ? ` (${notes})` : ""}`,
      );
    }
  }
  return lines;
}

export function renderPuzzleReadme(state: RunState, puzzle: PuzzleState): string {
  const lines = [`# ${state.eventYear} ${puzzle.puzzle}`, ""];
  lines.push(`Input: ${puzzle.inputSha256 ? "[input.txt](input.txt)" : "not fetched"}`, "");
  for (const partNumber of [1, 2] as const) {
    const part = puzzle.parts[partNumber];
    lines.push(`## Part ${partNumber}`, "");
    lines.push(`Status: ${partCell(part)}`, "");
    if (part.statementSha256)
      lines.push(`Statement: [part-${partNumber}.html](part-${partNumber}.html)`, "");
    for (let attempt = 1; attempt <= part.attempts; attempt++) {
      const key = `attempt-${String(attempt).padStart(3, "0")}`;
      lines.push(`- [${key}](part-${partNumber}/${key}/)`);
    }
    if (part.attempts > 0) lines.push("");
    if (part.submissions.length > 0) {
      lines.push("| # | Attempt | Answer | Verdict |", "| --- | --- | --- | --- |");
      for (const s of part.submissions) {
        lines.push(`| ${s.submission} | ${s.attempt} | ${cell(s.answer)} | ${s.verdict} |`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderIndex(years: readonly number[]): string {
  const lines = ["# BoC private artifacts", "", "Private runtime data — do not publish.", ""];
  for (const year of [...years].sort()) {
    lines.push(`- [${year}](runs/${year}/SUMMARY.md)`);
  }
  return `${lines.join("\n")}\n`;
}

/** Regenerate all derived views for one event (atomic per file). */
export async function writeViews(paths: Layout, state: RunState, ledger?: LedgerStatus) {
  await writeFileAtomic(paths.summary, renderEventSummary(state, ledger));
  for (const puzzle of puzzles(state)) {
    await writeFileAtomic(paths.puzzleReadme(puzzle.puzzle), renderPuzzleReadme(state, puzzle));
  }
  const entries = await readdir(join(paths.root, "runs"), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const years = entries
    .filter((entry) => entry.isDirectory() && /^[0-9]{4}$/.test(entry.name))
    .map((entry) => Number(entry.name));
  await writeFileAtomic(paths.index, renderIndex(years));
}
