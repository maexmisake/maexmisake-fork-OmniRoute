import {
  getDeclaredModelEndpoints,
  getModelEndpointDecision,
} from "@omniroute/open-sse/services/modelEndpointPolicy";
import { isModelSelectable } from "@omniroute/open-sse/services/modelLifecycle";

type CatalogModelPolicyInput = {
  id: string;
  supportedEndpoints?: readonly string[];
};

export function isUnifiedChatSourceModelSelectable(
  provider: string,
  model: CatalogModelPolicyInput
): boolean {
  const decision = getModelEndpointDecision(
    provider,
    model.id,
    getDeclaredModelEndpoints(model, provider)
  );
  return (
    isModelSelectable(provider, model.id) &&
    decision.reason !== "provider-policy" &&
    // A typed decision model answers noul/choice/score questions, never chat
    // completions: listing it in the unified chat catalog would advertise a
    // model that every chat client would fail against. It is listed by
    // `GET /v1/systemone/models` instead. A model that declares chat as well is
    // classified `chat` and stays here.
    decision.kind !== "decision"
  );
}
