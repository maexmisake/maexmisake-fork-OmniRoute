/** Pure operator configuration shared by the dashboard and guarded runtime.
 * No database, transport, credential or provider-discovery imports belong here. */
import { z } from "zod";
import { policySchema } from "../../../open-sse/services/decisionPolicy/contract.ts";
import { decisionTaskContextSchema } from "../../../open-sse/services/decisionPolicy/taskContext.ts";

const nativeSelectionOptions = z
  .object({
    mode: z.literal("native"),
    connectionId: z.string().min(1),
    timeoutMs: z.number().int().min(1).max(10000),
    maxCandidates: z.number().int().min(2).max(255).default(32),
    decisionContext: decisionTaskContextSchema.optional(),
  })
  .strict();
// Exact provider/model pairs: neither aliases, catalogs nor client fields may
// widen these operator-stored bindings or relax the returned identity check.
export const nativeSelectionSchema = z.discriminatedUnion("provider", [
  nativeSelectionOptions.extend({
    provider: z.literal("opencode-zen"),
    model: z.enum(["jev-1.13", "jev-1.13-free"]),
  }),
  nativeSelectionOptions.extend({
    provider: z.literal("typesafe"),
    model: z.literal("jev-1.14.0"),
  }),
  nativeSelectionOptions.extend({
    provider: z.literal("openrouter"),
    model: z.literal("typesafe/jev-1.14-20261014"),
  }),
  nativeSelectionOptions.extend({
    provider: z.literal("vercel-ai-gateway"),
    model: z.literal("typesafe-ai/jev"),
  }),
]);
export const boundedDecisionConfigurationSchema = z
  .object({
    enabled: z.literal(true),
    applicationMode: z.enum(["bounded-v1", "provider-native-output-v1"]),
    nativeOutput: z
      .object({
        acknowledgeNoTokenCeiling: z.literal(true),
        // Context planning only; native subscription transports do not enforce this ceiling.
        contextOutputTokens: z.number().int().positive().max(1000000),
      })
      .strict()
      .optional(),
    policy: policySchema,
    selection: z
      .union([z.object({ mode: z.literal("deterministic") }).strict(), nativeSelectionSchema])
      .optional(),
    connections: z.record(z.string(), z.string().min(1)),
  })
  .strict()
  .refine(
    (value) =>
      (value.applicationMode === "provider-native-output-v1"
        ? value.nativeOutput !== undefined
        : value.nativeOutput === undefined) &&
      value.policy.maxExecutionAttempts === 1 &&
      (value.selection?.mode === "native"
        ? value.policy.maxDecisionAttempts === 1 &&
          value.policy.decisionFailure === "stop" &&
          value.selection.timeoutMs <= value.policy.timeoutMs
        : value.policy.maxDecisionAttempts === 0)
  );

/** Disabled drafts retain the same strict structure without activating routing. */
export const decisionPolicyEditorSchema = z
  .object({
    ...boundedDecisionConfigurationSchema.shape,
    enabled: z.boolean(),
  })
  .strict()
  .refine(
    (value) => boundedDecisionConfigurationSchema.safeParse({ ...value, enabled: true }).success
  );

export type DecisionPolicyEditorValue = z.infer<typeof decisionPolicyEditorSchema>;

/** Supported transport bindings, not a live catalog, account entitlement or quality ranking. */
export const NATIVE_DECISION_BINDINGS = [
  {
    provider: "opencode-zen",
    model: "jev-1.13-free",
    tier: "free",
    label: "OpenCode Zen — Jev 1.13 free",
    primitives: ["noul", "choice", "score"],
  },
  {
    provider: "opencode-zen",
    model: "jev-1.13",
    tier: "paid",
    label: "OpenCode Zen — Jev 1.13 paid",
    primitives: ["noul", "choice", "score"],
  },
  {
    provider: "typesafe",
    model: "jev-1.14.0",
    tier: "paid",
    label: "TypeSafe — Jev 1.14",
    primitives: ["noul", "choice", "score"],
  },
  {
    provider: "openrouter",
    model: "typesafe/jev-1.14-20261014",
    tier: "paid",
    label: "OpenRouter — Jev 1.14 dated binding",
    primitives: ["noul", "choice", "score"],
  },
  {
    provider: "vercel-ai-gateway",
    model: "typesafe-ai/jev",
    tier: "paid",
    label: "Vercel — Jev alias",
    primitives: ["noul", "choice", "score"],
  },
] as const;
