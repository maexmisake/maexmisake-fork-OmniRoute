import { z } from "zod";

export const DECISION_TASK_CONTEXT_HEADER = "x-omniroute-decision-context";

export const guidanceDisclosureSchema = z
  .object({
    acknowledgeExternalTransmission: z.literal(true),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    connectionId: z.string().min(1),
  })
  .strict();

/** Consent belongs to this exact decision destination; a changed binding cannot inherit it. */
export function guidanceDisclosureMatches(
  destination: { provider?: string; model: string; connectionId?: string },
  disclosure: unknown
): boolean {
  const parsed = guidanceDisclosureSchema.safeParse(disclosure);
  return (
    parsed.success &&
    parsed.data.provider === destination.provider &&
    parsed.data.model === destination.model &&
    parsed.data.connectionId === destination.connectionId
  );
}

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
