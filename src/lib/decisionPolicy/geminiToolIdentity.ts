import { canonicalToolId } from "../../../open-sse/services/decisionPolicy/toolContract.ts";

function fail(): never {
  throw new Error("decision_gemini_tool_identity_invalid");
}
/** Correlation syntax only; source-attempt ownership is authenticated elsewhere. */
export function validateGeminiCorrelationNamespace(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) fail();
}
/** Only a trusted canonical execution-attempt UUID may select a new namespace. */
export function createGeminiCorrelationNamespace(attemptId: string): string {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId)
  )
    fail();
  return attemptId.replaceAll("-", "");
}
/** Client correlation only: never write a generated identifier into native Parts. */
export function resolveGeminiClientCallId(
  nativeId: string | null,
  correlationNamespace: string | undefined,
  ordinal: number
): string {
  try {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 32) fail();
    if (correlationNamespace !== undefined)
      validateGeminiCorrelationNamespace(correlationNamespace);
    if (nativeId !== null) return canonicalToolId(nativeId);
    validateGeminiCorrelationNamespace(correlationNamespace);
    return canonicalToolId(`gmc_${correlationNamespace}_${ordinal}`);
  } catch {
    return fail();
  }
}
