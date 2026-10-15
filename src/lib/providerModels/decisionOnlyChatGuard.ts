import { isSystemOneProvider } from "@omniroute/open-sse/config/systemOneRegistry.ts";
import { getModelEndpointDecision } from "@omniroute/open-sse/services/modelEndpointPolicy.ts";
import { createErrorResult } from "@omniroute/open-sse/utils/error.ts";

type ModelInfoLike = {
  provider?: string | null;
  model?: string | null;
  /** Endpoints from the model resolution the caller already performed. */
  supportedEndpoints?: readonly string[] | null;
};

type EndpointAwareRow = { id: string; supportedEndpoints?: readonly string[] | null };

/**
 * Reject a chat/combo request for a decision-only model before a connection is
 * selected or any upstream call is made.
 *
 * Only providers that can serve System One are consulted, and only with endpoint
 * evidence: the metadata the caller already resolved, or — when it passed none —
 * the provider's synced model rows through `readModels`. With no evidence the
 * chat path stays open; the decision routes are the ones that fail closed.
 */
export async function decisionOnlyChatRejection(
  info: ModelInfoLike,
  readModels?: (provider: string) => Promise<EndpointAwareRow[]>
): Promise<ReturnType<typeof createErrorResult> | null> {
  const provider = info.provider || "";
  const model = info.model || "";
  if (!model || !isSystemOneProvider(provider)) return null;

  let endpoints = info.supportedEndpoints ?? undefined;
  if (!endpoints?.length && readModels) {
    const row = (await readModels(provider)).find((candidate) => candidate.id === model);
    endpoints = row?.supportedEndpoints ?? undefined;
  }
  if (getModelEndpointDecision(provider, model, endpoints ?? undefined).kind !== "decision") {
    return null;
  }
  return createErrorResult(
    400,
    // Phrased without a slash-path: the error sanitizer redacts those to `<path>`.
    `Model ${provider}/${model} is a decision-only model; use the System One endpoint (POST v1 systemone) instead of chat completions`
  );
}
