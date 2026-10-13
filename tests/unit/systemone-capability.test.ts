/**
 * Decision capability semantics.
 *
 * A System One model is a non-chat capability: it must not be offered as a chat
 * model in `/v1/models`, must not be selectable by a chat/combo path, and a
 * model that genuinely serves both chat and decisions must stay chat-selectable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  declaresOnlyNonChatEndpoints,
  filterChatSelectableModels,
  getModelEndpointDecision,
  isChatSelectableModel,
} from "../../open-sse/services/modelEndpointPolicy.ts";
import {
  MODEL_SUPPORTED_ENDPOINT_VALUES,
  normalizeModelSupportedEndpoints,
} from "../../src/shared/constants/modelSupportedEndpoints.ts";
import { isUnifiedChatSourceModelSelectable } from "../../src/app/api/v1/models/catalogModelPolicy.ts";
import { decisionOnlyChatRejection } from "../../src/lib/providerModels/decisionOnlyChatGuard.ts";

test("`systemone` is a persistable supported-endpoint value", () => {
  assert.ok(MODEL_SUPPORTED_ENDPOINT_VALUES.includes("systemone"));
});

test("the `decision` / `decisions` spellings normalize onto `systemone`", () => {
  assert.deepEqual(normalizeModelSupportedEndpoints(["decision"]), ["systemone"]);
  assert.deepEqual(normalizeModelSupportedEndpoints(["decisions"]), ["systemone"]);
  assert.deepEqual(normalizeModelSupportedEndpoints(["systemone", "decision"]), ["systemone"]);
  assert.deepEqual(normalizeModelSupportedEndpoints(["chat", "decision"]), ["chat", "systemone"]);
  // Unrelated endpoints are untouched.
  assert.deepEqual(normalizeModelSupportedEndpoints(["embeddings"]), ["embeddings"]);
});

test("a decision-only model is classified as a non-chat decision capability", () => {
  const decision = getModelEndpointDecision("openrouter", "typesafe/jev-1.13", ["systemone"]);
  assert.equal(decision.kind, "decision");
  assert.equal(decision.chatSelectable, false);
  assert.equal(decision.reason, "explicit-endpoints");
  assert.equal(
    getModelEndpointDecision("opencode-zen", "jev-1.13", ["decision"]).kind,
    "decision",
    "the `decision` spelling classifies the same way"
  );
});

test("a model that serves both chat and decisions stays chat-selectable", () => {
  const mixed = getModelEndpointDecision("openrouter", "some/multimodal", ["chat", "systemone"]);
  assert.equal(mixed.kind, "chat");
  assert.equal(mixed.chatSelectable, true);
  assert.equal(
    isChatSelectableModel("openrouter", { id: "x", supportedEndpoints: ["chat", "systemone"] }),
    true
  );
});

test("decision-only rows are dropped from chat model projections", () => {
  const models = [
    { id: "typesafe/jev-1.13", supportedEndpoints: ["systemone"] },
    { id: "anthropic/claude-4", supportedEndpoints: ["chat"] },
    { id: "both/model", supportedEndpoints: ["chat", "systemone"] },
  ];
  assert.deepEqual(
    filterChatSelectableModels("openrouter", models).map((model) => model.id),
    ["anthropic/claude-4", "both/model"]
  );
  assert.equal(declaresOnlyNonChatEndpoints(["systemone"]), true);
  assert.equal(declaresOnlyNonChatEndpoints(["chat", "systemone"]), false);
});

test("the unified /v1/models catalog does not expose a decision-only model as chat", () => {
  assert.equal(
    isUnifiedChatSourceModelSelectable("openrouter", {
      id: "typesafe/jev-1.13",
      supportedEndpoints: ["systemone"],
    }),
    false
  );
  assert.equal(
    isUnifiedChatSourceModelSelectable("openrouter", {
      id: "anthropic/claude-4",
      supportedEndpoints: ["chat"],
    }),
    true
  );
  assert.equal(
    isUnifiedChatSourceModelSelectable("openrouter", {
      id: "both/model",
      supportedEndpoints: ["chat", "systemone"],
    }),
    true,
    "a mixed chat+decision model is still a chat model"
  );
});

test("a chat request for a decision-only model is rejected before any upstream call", async () => {
  const rejection = await decisionOnlyChatRejection({
    provider: "openrouter",
    model: "typesafe/jev-1.13",
    supportedEndpoints: ["systemone"],
  });
  assert.ok(rejection, "a decision-only model must not reach a chat executor");
  assert.equal(rejection.status, 400);
  const body = (await rejection.json()) as { error: { message: string } };
  // The sanitizer redacts slash-paths, so the guidance names the endpoint in prose.
  assert.match(body.error.message, /System One endpoint/);
  assert.match(body.error.message, /systemone/);
});

test("the chat guard leaves chat and mixed models alone", async () => {
  assert.equal(
    await decisionOnlyChatRejection({
      provider: "openrouter",
      model: "anthropic/claude-4",
      supportedEndpoints: ["chat"],
    }),
    null
  );
  assert.equal(
    await decisionOnlyChatRejection({
      provider: "openrouter",
      model: "both/model",
      supportedEndpoints: ["chat", "systemone"],
    }),
    null
  );
  // A provider that serves no decision model at all is never consulted.
  assert.equal(await decisionOnlyChatRejection({ provider: "anthropic", model: "claude-4" }), null);
});

test("the chat guard consults the connection's synced rows when no metadata is passed", async () => {
  const rejection = await decisionOnlyChatRejection(
    { provider: "opencode-zen", model: "jev-1.13" },
    async () => [
      { id: "jev-1.13", supportedEndpoints: ["systemone"] },
      { id: "big-pickle", supportedEndpoints: ["chat"] },
    ]
  );
  assert.ok(rejection);
  assert.equal(rejection.status, 400);

  assert.equal(
    await decisionOnlyChatRejection({ provider: "opencode-zen", model: "big-pickle" }, async () => [
      { id: "big-pickle", supportedEndpoints: ["chat"] },
    ]),
    null
  );
});

test("an unknown model on a decision-capable provider is not blocked from chat", async () => {
  // No endpoint evidence at all: the chat path stays open (fail-open is correct
  // here — the decision routes are what fail closed).
  assert.equal(
    await decisionOnlyChatRejection(
      { provider: "openrouter", model: "mystery/model" },
      async () => []
    ),
    null
  );
});
