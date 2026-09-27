/**
 * Conservative parsers for AoC HTML. Inputs are untrusted and size-bounded by the
 * client. Anything not positively recognized maps to `uncertain`, never to a
 * verdict that would allow resubmission or claim success. Phrase patterns follow
 * the site's long-standing wording; they must be revalidated against live responses
 * (milestone 6) before relying on them.
 */

export type AnswerVerdict =
  | "correct"
  | "incorrect"
  | "too-high"
  | "too-low"
  | "cooldown"
  | "uncertain";

export interface AnswerResult {
  readonly verdict: AnswerVerdict;
  /** Server-imposed wait, when known or conservatively assumed. */
  readonly waitMs: number | undefined;
  /** Machine-readable reason code for records; never raw page text. */
  readonly reason: string;
}

export interface PuzzlePage {
  readonly loggedIn: boolean;
  /** Number of puzzle description articles visible (1 or 2 normally). */
  readonly articles: number;
  /** Answers the page shows as accepted, in part order. */
  readonly acceptedAnswers: readonly string[];
  /** Level of the answer form, if one is shown. */
  readonly answerLevel: 1 | 2 | undefined;
  readonly complete: boolean;
}

/** Conservative defaults when a wait is implied but not parseable. */
export const DEFAULT_INCORRECT_WAIT_MS = 60_000;
export const DEFAULT_COOLDOWN_WAIT_MS = 300_000;
/** Added to every parsed wait to absorb rounding and clock skew. */
export const WAIT_MARGIN_MS = 2_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16) || 0xfffd);
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10) || 0xfffd);
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function mainText(html: string): string {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  return htmlToText(main?.[1] ?? html);
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

/** Parse durations like "one minute", "5 minutes", "1m 30s", "42s". */
export function parseDuration(text: string): number | undefined {
  let total = 0;
  let found = false;
  const pattern = /\b(\d{1,6}|an?|one)\s*(hours?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const [, rawCount = "", rawUnit = ""] = match;
    const count = /^\d/.test(rawCount) ? Number(rawCount) : 1;
    const unit = rawUnit.toLowerCase()[0] ?? "";
    const scale = UNIT_MS[unit];
    if (scale === undefined) continue;
    total += count * scale;
    found = true;
  }
  return found ? total : undefined;
}

export function parseAnswerResponse(html: string): AnswerResult {
  const text = mainText(html);
  const waitClause = (pattern: RegExp) => {
    const match = pattern.exec(text);
    const parsed = match?.[1] ? parseDuration(match[1]) : undefined;
    return parsed === undefined ? undefined : parsed + WAIT_MARGIN_MS;
  };
  if (/\bThat's the right answer\b/i.test(text)) {
    return { verdict: "correct", waitMs: undefined, reason: "right-answer" };
  }
  if (/\bYou gave an answer too recently\b/i.test(text)) {
    const waitMs = waitClause(/You have (.{1,60}?) left to wait/i) ?? DEFAULT_COOLDOWN_WAIT_MS;
    return { verdict: "cooldown", waitMs, reason: "answered-too-recently" };
  }
  if (/\bThat's not the right answer\b/i.test(text)) {
    const waitMs =
      waitClause(/please wait (.{1,60}?) before trying again/i) ?? DEFAULT_INCORRECT_WAIT_MS;
    if (/\byour answer is too high\b/i.test(text)) {
      return { verdict: "too-high", waitMs, reason: "too-high" };
    }
    if (/\byour answer is too low\b/i.test(text)) {
      return { verdict: "too-low", waitMs, reason: "too-low" };
    }
    return { verdict: "incorrect", waitMs, reason: "wrong-answer" };
  }
  if (/\bYou don't seem to be solving the right level\b/i.test(text)) {
    // Already solved, or not yet unlocked: reconcile from the puzzle page.
    return { verdict: "uncertain", waitMs: undefined, reason: "wrong-level" };
  }
  return { verdict: "uncertain", waitMs: undefined, reason: "unrecognized-response" };
}

export function parsePuzzlePage(html: string): PuzzlePage {
  const articles = html.match(/<article\b[^>]*class="day-desc"[^>]*>/gi)?.length ?? 0;
  const acceptedAnswers = [
    ...html.matchAll(/Your puzzle answer was\s*<code>([^<]{1,200})<\/code>/gi),
  ].map((m) => htmlToText(m[1] ?? ""));
  const level = /<input\b[^>]*name="level"[^>]*value="([12])"/i.exec(html)?.[1];
  return {
    loggedIn: /<div\b[^>]*class="user"/i.test(html),
    articles,
    acceptedAnswers,
    answerLevel: level === "1" ? 1 : level === "2" ? 2 : undefined,
    complete: /Both parts of this puzzle are complete/i.test(htmlToText(html)),
  };
}

/**
 * Puzzle description articles as plain Markdown-like text for the solver prompt.
 * Keeps code blocks, inline code, emphasis, and list structure; drops everything
 * else (forms, navigation, scripts). Untrusted content: the prompt frames it as data.
 */
export function puzzleText(html: string): string[] {
  const articles = [
    ...html.matchAll(/<article\b[^>]*class="day-desc"[^>]*>([\s\S]*?)<\/article>/gi),
  ];
  return articles.map((match) => {
    const body = (match[1] ?? "")
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
      .replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code: string) => {
        const text = decodeEntities(code.replace(/<[^>]*>/g, ""));
        return `\n\n\`\`\`\n${text.replace(/\n$/, "")}\n\`\`\`\n\n`;
      })
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, code: string) => `\`${code}\``)
      .replace(/<(em|strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) => `*${inner}*`)
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(p|h2|ul|ol|li)>/gi, "\n")
      .replace(/<h2[^>]*>/gi, "\n## ")
      .replace(/<(p|ul|ol|br)[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, "");
    return decodeOutsideFences(body)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (/^#x/i.test(entity))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16) || 0xfffd);
    if (entity.startsWith("#"))
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10) || 0xfffd);
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function decodeOutsideFences(text: string): string {
  // Code blocks were already decoded; decode the rest once.
  return text
    .split(/(```\n[\s\S]*?\n```)/)
    .map((part, index) => (index % 2 === 1 ? part : decodeEntities(part)))
    .join("");
}
