import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { CREDIT_PATTERN, parseCredits } from "./budget/credits.ts";

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
const provider = z.enum(["github-copilot", "openai-codex"]);
const amount = z.string().regex(CREDIT_PATTERN);
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value))
  .refine((value) => !value.startsWith("~") && !value.startsWith("!") && !value.includes("${"));

const limits = z
  .strictObject({ event: amount, perPuzzle: amount })
  .refine(
    (value) =>
      !CREDIT_PATTERN.test(value.event) ||
      !CREDIT_PATTERN.test(value.perPuzzle) ||
      parseCredits(value.perPuzzle) <= parseCredits(value.event),
    { message: "Per-puzzle credits cannot exceed event credits." },
  );

const configSchema = z
  .strictObject({
    version: z.literal(1),
    event: z.strictObject({ year: z.number().int().min(2015).max(9999) }),
    storageDir: filePath,
    aoc: z.strictObject({ sessionCookieFile: filePath }),
    creditPools: z
      .array(
        z.strictObject({
          id: identifier,
          provider,
          unit: identifier,
          limits,
        }),
      )
      .min(1)
      .max(64),
    subscriptions: z
      .array(
        z.strictObject({
          id: identifier,
          provider,
          credentialFile: filePath,
          model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}(?![\s\S])/),
          creditPool: identifier,
          limits,
        }),
      )
      .min(1)
      .max(64),
  })
  .superRefine((config, context) => {
    const poolIds = new Set<string>();
    for (const pool of config.creditPools) {
      if (poolIds.has(pool.id)) context.addIssue({ code: "custom", message: "Duplicate pool." });
      poolIds.add(pool.id);
    }
    const subscriptionIds = new Set<string>();
    const credentialFiles = new Set<string>();
    for (const subscription of config.subscriptions) {
      if (subscriptionIds.has(subscription.id)) {
        context.addIssue({ code: "custom", message: "Duplicate subscription." });
      }
      subscriptionIds.add(subscription.id);
      if (credentialFiles.has(subscription.credentialFile)) {
        context.addIssue({ code: "custom", message: "Duplicate credential file." });
      }
      credentialFiles.add(subscription.credentialFile);
      const pool = config.creditPools.find((candidate) => candidate.id === subscription.creditPool);
      if (!pool || pool.provider !== subscription.provider) {
        context.addIssue({ code: "custom", message: "Missing or incompatible credit pool." });
      }
    }
    for (const pool of config.creditPools) {
      if (!config.subscriptions.some((subscription) => subscription.creditPool === pool.id)) {
        context.addIssue({ code: "custom", message: "Unused credit pool." });
      }
    }
  });

export type BocConfig = z.infer<typeof configSchema>;
export type Provider = BocConfig["subscriptions"][number]["provider"];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(input: unknown): BocConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    // Do not surface raw Zod issues: unknown keys or supplied values may be secrets.
    throw new ConfigError("Invalid configuration. Check the version 1 configuration reference.");
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<BocConfig> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // JSON syntax and filesystem error messages can disclose values and private paths.
    throw new ConfigError("Cannot read configuration as JSON.");
  }
  const config = parseConfig(input);
  const base = dirname(resolve(path));
  config.storageDir = resolve(base, config.storageDir);
  config.aoc.sessionCookieFile = resolve(base, config.aoc.sessionCookieFile);
  for (const subscription of config.subscriptions) {
    subscription.credentialFile = resolve(base, subscription.credentialFile);
  }
  // Catch equivalent relative credential paths after resolution. Do not open secrets here.
  return parseConfig(config);
}
