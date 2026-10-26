import { z } from "zod";
import { errorResponse } from "../../utils/error.ts";

const disabledPolicy = z.object({ enabled: z.literal(false) }).passthrough();
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** A stored opt-in must never execute through ordinary legacy combo routing. */
export function decisionPolicyOptedIn(combo: unknown): boolean {
  if (!record(combo) || !record(combo.config) || !Object.hasOwn(combo.config, "decisionPolicy"))
    return false;
  return !disabledPolicy.safeParse(combo.config.decisionPolicy).success;
}
export function unavailableDecisionPolicy(): Response {
  return errorResponse(
    409,
    "Decision combo application admission and durable accounting are not implemented",
    { code: "decision_policy_application_unvalidated" }
  );
}

/** Recognition only: complete policy/permission validation belongs to application admission. */
export function boundedDecisionEnabled(combo: unknown): boolean {
  return (
    record(combo) &&
    record(combo.config) &&
    record(combo.config.decisionPolicy) &&
    combo.config.decisionPolicy.enabled === true &&
    ["bounded-v1", "provider-native-output-v1"].includes(
      String(combo.config.decisionPolicy.applicationMode)
    )
  );
}
