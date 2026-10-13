import test from "node:test";
import assert from "node:assert/strict";
import { isUnifiedChatSourceModelSelectable } from "../../src/app/api/v1/models/catalogModelPolicy.ts";
import { getModelEndpointDecision } from "../../open-sse/services/modelEndpointPolicy.ts";
import { decisionOnlyChatRejection, resetDecisionOnlyChatGuardCache } from "../../src/lib/providerModels/decisionOnlyChatGuard.ts";
import { isDecisionCatalogRow, toDecisionCatalogModel } from "../../open-sse/handlers/systemOneCatalog.ts";
import { parseSystemOneAnswers, validateSystemOneBackendBody } from "../../open-sse/services/typesafe/systemOneAnswers.ts";
import { normalizeDiscoveredModels } from "../../src/lib/providerModels/modelDiscovery.ts";
import { resolveSystemOneCandidates } from "../../open-sse/config/systemOneRegistry.ts";

test("generic discovery persists decision capabilities from provider metadata and known Jev IDs", () => {
  const [known] = normalizeDiscoveredModels([{ id: "jev-1.13" }], "opencode-zen");
  assert.deepEqual(known.supportedEndpoints, ["systemone"]);
  const [decision] = normalizeDiscoveredModels([{ id: "vendor/new-decision", architecture: { output_modalities: ["decisions"] } }], "openrouter");
  assert.deepEqual(decision.supportedEndpoints, ["systemone"]);
  const [mixed] = normalizeDiscoveredModels([{ id: "vendor/mixed", architecture: { output_modalities: ["text", "decisions"] } }], "openrouter");
  assert.deepEqual(mixed.supportedEndpoints, ["chat", "systemone"]);
});

test("real untagged Jev IDs are decision-only in generic discovery and chat catalog", () => {
  for (const [provider, id] of [["opencode-zen", "jev-1.13"], ["opencode-zen", "jev-1.13-free"], ["openrouter", "typesafe/jev-1.13"], ["vercel-ai-gateway", "typesafe-ai/jev"]]) {
    assert.equal(getModelEndpointDecision(provider, id).kind, "decision");
    assert.equal(isUnifiedChatSourceModelSelectable(provider, { id, supportedEndpoints: ["chat"] }), false);
    assert.equal(getModelEndpointDecision(provider, id, ["chat", "systemone"]).chatSelectable, true);
  }
});

test("runtime chat guard rejects known untagged decisions and tolerates damaged metadata", async () => {
  resetDecisionOnlyChatGuardCache();
  const rejection = await decisionOnlyChatRejection({ provider: "opencode-zen", model: "jev-1.13" }, async () => { throw new Error("malformed persisted catalog"); });
  assert.equal(rejection?.status, 400);
  assert.equal(await decisionOnlyChatRejection({ provider: "opencode-zen", model: "ordinary-chat-model" }, async () => { throw new Error("malformed persisted catalog"); }), null);
});

test("runtime guard caches provider rows instead of reading them for every chat call", async () => {
  resetDecisionOnlyChatGuardCache();
  let reads = 0;
  const reader = async () => { reads++; return [{ id: "new-decision-model", supportedEndpoints: ["systemone"] }]; };
  for (let i = 0; i < 3; i++) assert.equal((await decisionOnlyChatRejection({ provider: "openrouter", model: "new-decision-model" }, reader))?.status, 400);
  assert.equal(reads, 1);
});

test("Vercel dedicated decision catalog accepts named non-Jev models, not unsafe IDs", () => {
  const row = { name: "liquid/d1", description: "Dedicated TypeSafe catalog entry" };
  assert.equal(isDecisionCatalogRow("vercel-ai-gateway", row), true);
  assert.equal(toDecisionCatalogModel("vercel-ai-gateway", row)?.id, "vercel-ai-gateway/liquid/d1");
  assert.equal(isDecisionCatalogRow("opencode-zen", { id: "ordinary-chat-model" }), false);
  assert.equal(toDecisionCatalogModel("vercel-ai-gateway", { name: "../unsafe" }), null);
});

test("OpenRouter aliases round-trip exactly from catalog through candidate resolution", () => {
  const projected = toDecisionCatalogModel("openrouter", { id: "~typesafe/jev-latest", architecture: { output_modalities: ["decisions"] } });
  assert.equal(projected?.root, "~typesafe/jev-latest");
  assert.equal(resolveSystemOneCandidates(projected!.id)[0].model, "~typesafe/jev-latest");
});

test("OpenRouter instructions requirement is backend-specific", () => {
  const body = { model: "typesafe/jev-1.13", state: "Synthetic state", questions: { color: { type: "choice", criteria: { blue: "Blue", red: "Red" } } } };
  assert.equal(validateSystemOneBackendBody("openrouter", body).ok, false);
  assert.equal(validateSystemOneBackendBody("opencode-zen", body).ok, true);
  assert.equal(validateSystemOneBackendBody("openrouter", { ...body, questions: { color: { ...body.questions.color, instructions: "Select the color" } } }).ok, true);
});

test("upstream answers must cover the requested questions with matching types", () => {
  const request = { questions: { wanted: { type: "noul" } } };
  assert.equal(parseSystemOneAnswers({ answers: { unrelated: { type: "noul", noul: 0.5 } } }, request).ok, false);
  assert.equal(parseSystemOneAnswers({ answers: { wanted: { type: "score", score: 1 } } }, request).ok, false);
  assert.equal(parseSystemOneAnswers({ answers: { wanted: { type: "noul", noul: 0.5 } } }, request).ok, true);
});

test("a choice must belong to requested options and probability values cannot exceed one", () => {
  const request = { questions: { wanted: { type: "choice", criteria: { blue: "Blue", red: "Red" } } } };
  assert.equal(parseSystemOneAnswers({ answers: { wanted: { type: "choice", choice: "unoffered" } } }, request).ok, false);
  assert.equal(parseSystemOneAnswers({ answers: { wanted: { type: "choice", choice: "blue", probabilities: { blue: 2 } } } }, request).ok, false);
  assert.equal(parseSystemOneAnswers({ answers: { wanted: { type: "choice", choice: "blue", probabilities: { blue: 0.7, red: 0.3 } } } }, request).ok, true);
});
