import { z } from "zod";

export const DECISION_TASK_CONTEXT_HEADER = "x-omniroute-decision-context";

/** Operator consent never substitutes for each requesting client's consent. */
export const decisionTaskContextSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local-summary") }).strict(),
  z
    .object({
      mode: z.literal("task-text"),
      acknowledgeExternalTransmission: z.literal(true),
      maxChars: z.number().int().min(1).max(2048),
    })
    .strict(),
]);
