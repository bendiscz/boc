// Fixed-point values are internal only. JSON stores exact decimal strings.
// Units belong to a credit pool; do not add values from different pools.
const SCALE = 10n ** 18n;
// Unlike $, this end assertion also rejects a trailing line terminator.
export const CREDIT_PATTERN = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?(?![\s\S])/;

declare const creditBrand: unique symbol;
export type Credits = bigint & { readonly [creditBrand]: true };

export function parseCredits(value: string): Credits {
  if (!CREDIT_PATTERN.test(value)) {
    throw new Error("Credits must be a non-negative decimal string (up to 18 digits per part).");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return (BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, "0"))) as Credits;
}

export function formatCredits(value: Credits): string {
  if (value < 0n) throw new Error("Credits cannot be negative.");
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Largest value representable by the persisted decimal format (18 integer digits). */
export const MAX_CREDITS = (10n ** 18n * SCALE - 1n) as Credits;
export const ZERO_CREDITS = 0n as Credits;

export function isCredits(value: unknown): value is Credits {
  return typeof value === "bigint" && value >= 0n && value <= MAX_CREDITS;
}

/** Exact addition; overflow beyond the persisted format fails rather than wraps or rounds. */
export function addCredits(...values: Credits[]): Credits {
  let total = 0n;
  for (const value of values) {
    if (!isCredits(value)) throw new Error("Invalid credit amount.");
    total += value;
  }
  if (total > MAX_CREDITS) throw new Error("Credit total exceeds the supported range.");
  return total as Credits;
}

/** Exact subtraction; a negative result is an accounting error, never clamped. */
export function subtractCredits(minuend: Credits, subtrahend: Credits): Credits {
  if (!isCredits(minuend) || !isCredits(subtrahend) || subtrahend > minuend) {
    throw new Error("Credit subtraction would be negative.");
  }
  return (minuend - subtrahend) as Credits;
}
