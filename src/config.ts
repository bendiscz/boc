import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { CREDIT_PATTERN, parseCredits } from "./budget/credits.ts";

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
const provider = z.enum(["github-copilot", "openai-codex", "anthropic"]);
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
    aoc: z.strictObject({
      sessionCookieFile: filePath,
      /** Operator contact for the AoC User-Agent (email or URL). Required for live access. */
      contact: z
        .string()
        .regex(/^[\x21-\x7e][\x20-\x7e]{0,199}(?![\s\S])/)
        .refine((value) => !/[;()]/.test(value))
        .optional(),
    }),
    /**
     * Operator alerts (D023). Only paths to private files are configured here: the
     * ntfy topic URL (and optional access token) and the healthchecks.io ping URL.
     */
    alerts: z
      .strictObject({
        ntfy: z.strictObject({ topicUrlFile: filePath, tokenFile: filePath.optional() }).optional(),
        healthchecks: z.strictObject({ pingUrlFile: filePath }).optional(),
      })
      .optional(),
    /** Solver executor (D010). Required for solving; not needed to validate budgets. */
    sandbox: z
      .strictObject({
        image: z
          .string()
          .regex(
            /^(sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]{0,199}@sha256:[a-f0-9]{64})(?![\s\S])/,
          ),
        /**
         * Longest single program run the solver may request, in seconds (default 60).
         * Raise it on slower hosts (RPI.md); at most 540, inside the 10-minute attempt deadline.
         */
        maxRunSeconds: z.number().int().min(1).max(540).optional(),
      })
      .optional(),
    creditPools: z
      .array(
        z.strictObject({
          id: identifier,
          provider,
          unit: identifier,
          limits,
          /**
           * Best-effort enforcement (D016): total unacknowledged charge above
           * estimates tolerated before admission blocks. Default 5% of the event limit.
           */
          overshootTolerance: amount.optional(),
          /** Whether a provider-side spending cap backs this pool; "none" warns. */
          providerCap: z.enum(["configured", "none"]).optional(),
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
          /** Per-call estimation (D016). Required before the subscription can run. */
          /**
           * Reasoning effort requested from the model (D031). Unset: no reasoning
           * parameter is sent, and the provider's default applies.
           */
          reasoning: z.enum(["low", "medium", "high", "xhigh"]).optional(),
          estimate: z
            .strictObject({
              /** Pricing source label, e.g. "github-2026-09". */
              pricing: identifier,
              /** Native credits per million tokens. */
              rates: z.strictObject({
                input: amount,
                output: amount,
                cacheRead: amount,
                cacheWrite: amount,
              }),
              safetyFactor: z
                .string()
                .regex(/^[1-9](\.[0-9]{1,6})?(?![\s\S])/)
                .optional(),
              assumedMaxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
            })
            .optional(),
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
  if (config.alerts?.ntfy) {
    config.alerts.ntfy.topicUrlFile = resolve(base, config.alerts.ntfy.topicUrlFile);
    if (config.alerts.ntfy.tokenFile) {
      config.alerts.ntfy.tokenFile = resolve(base, config.alerts.ntfy.tokenFile);
    }
  }
  if (config.alerts?.healthchecks) {
    config.alerts.healthchecks.pingUrlFile = resolve(base, config.alerts.healthchecks.pingUrlFile);
  }
  // Catch equivalent relative credential paths after resolution. Do not open secrets here.
  return parseConfig(config);
}
