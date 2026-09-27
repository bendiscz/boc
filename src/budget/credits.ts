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
