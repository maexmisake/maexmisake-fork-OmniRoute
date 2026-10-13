import {
  isKnownSystemOneDecisionModel,
  isSystemOneProvider,
} from "@omniroute/open-sse/config/systemOneRegistry.ts";
import { getModelEndpointDecision } from "@omniroute/open-sse/services/modelEndpointPolicy.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";

type ModelInfoLike = {
  provider?: string | null;
  model?: string | null;
  /** Endpoints from the model resolution the caller already performed. */
  supportedEndpoints?: readonly string[] | null;
};

type EndpointAwareRow = { id: string; supportedEndpoints?: readonly string[] | null };

type ReadModels = (provider: string) => Promise<EndpointAwareRow[]>;

/** Synced catalogs change on a sync, not per request; this bounds the staleness. */
const ROWS_TTL_MS = 5_000;

const rowsCache = new Map<string, { at: number; endpoints: Map<string, string[]> }>();

export function resetDecisionOnlyChatGuardCache(): void {
  rowsCache.clear();
}

/**
 * Endpoints per model id for one provider, unioned across its synced rows.
 * Cached per provider, and a read that throws (a malformed persisted row) is
 * cached as "no evidence" rather than failing the request: this runs before
 * every chat call to a System One-capable provider.
 */
async function syncedEndpoints(
  provider: string,
  readModels: ReadModels
): Promise<Map<string, string[]>> {
  const cached = rowsCache.get(provider);
  if (cached && Date.now() - cached.at < ROWS_TTL_MS) return cached.endpoints;

  const endpoints = new Map<string, string[]>();
  try {
    for (const row of await readModels(provider)) {
      if (!row?.id || !Array.isArray(row.supportedEndpoints)) continue;
      const known = endpoints.get(row.id) ?? [];
      endpoints.set(row.id, [...known, ...row.supportedEndpoints]);
    }
  } catch {
    // No evidence: the known-model rule below still applies.
  }
  rowsCache.set(provider, { at: Date.now(), endpoints });
  return endpoints;
}

/**
 * Reject a chat/combo request for a decision-only model before a connection is
 * selected or any upstream call is made.
 *
 * Only providers that can serve System One are consulted. A model is
 * decision-only when its endpoints name a decision endpoint without a chat one,
 * or when it is one of the backend's known decision models and does not declare
 * both: generic model discovery stores no System One tag (and older rows carry a
 * synthetic `["chat"]` default), so the registry is the evidence of last resort.
 * A model that explicitly declares both a chat and a decision endpoint is mixed
 * and stays chat-selectable.
 */
export async function decisionOnlyChatRejection(
  info: ModelInfoLike,
  readModels?: ReadModels
): Promise<Response | null> {
  const provider = info.provider || "";
  const model = info.model || "";
  if (!model || !isSystemOneProvider(provider)) return null;

  const known = isKnownSystemOneDecisionModel(provider, model);
  let endpoints: readonly string[] | undefined = info.supportedEndpoints ?? undefined;
  if (!endpoints?.length && readModels) {
    endpoints = (await syncedEndpoints(provider, readModels)).get(model);
  }

  const kind = getModelEndpointDecision(provider, model, endpoints).kind;
  const mixed = kind === "chat" && endpoints?.some((e) => /^(?:\/?v1\/)?\/?(systemone|decisions?)$/i.test(e.trim()));
  if (mixed) return null;
  if (kind !== "decision" && !known) return null;

  return errorResponse(
    400,
    // Phrased without a slash-path: the error sanitizer redacts those to `<path>`.
    `Model ${provider}/${model} is a decision-only model; use the System One endpoint (POST v1 systemone) instead of chat completions`
  );
}
