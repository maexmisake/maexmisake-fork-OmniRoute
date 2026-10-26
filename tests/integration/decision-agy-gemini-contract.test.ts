import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  createProviderConnection,
  updateProviderConnection,
  resetConnectionBackoff,
} from "../../src/lib/db/providers.ts";
import { createCombo, updateCombo, getComboByName } from "../../src/lib/db/combos.ts";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  BOUNDED_AGY_MODEL,
  BOUNDED_AGY_STREAM_URL,
} from "../../open-sse/executors/antigravity/bounded.ts";
import type { DecisionPolicyEditorValue } from "../../src/shared/decisionPolicy/configuration.ts";
type FixtureConfig = { decisionPolicy: DecisionPolicyEditorValue };
type FixtureWire = {
  model: string;
  project: string;
  userAgent?: string;
  requestType?: string;
  enabledCreditTypes?: string[];
  request: {
    generationConfig: {
      maxOutputTokens: number;
      temperature?: number;
      thinkingConfig: { thinkingLevel: string };
    };
  };
};
process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let connectionId: string;
let selectorId: string;
let alternateId: string;
let comboId: string;
let savedConfig: FixtureConfig;
let decisionCalls = 0;
let upstreamStatus = 200;
let omitThoughts = false;
let providerText = "Synthetic OK";
let calls = 0;
let unexpected = 0;
const originalFetch = globalThis.fetch;
const model = "synthetic-agy-high-contract";
const accessToken = "synthetic-agy-contract-access";
const projectId = "synthetic-agy-contract-project";
let wire: FixtureWire;
before(async () => {
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://opencode.ai/inference/systemone/v1/systemone" && init.method === "POST") {
      decisionCalls++;
      const sent = JSON.parse(String(init.body));
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer synthetic-agy-free-selector"
      );
      const options = Object.keys(sent.questions.route.criteria);
      assert.deepEqual(options.sort(), ["alternate", "chosen"]);
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: "chosen",
            probabilities: { chosen: 0.8, alternate: 0.2 },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 7, output_tokens: 2, cost: 0 },
      });
    }
    if (url !== BOUNDED_AGY_STREAM_URL || init.method !== "POST") {
      unexpected++;
      throw new Error("Closed synthetic AGY fixture unexpected dispatch");
    }
    calls++;
    wire = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
    assert.equal(headers.get("user-agent"), "OmniRoute-Antigravity/1.0");
    return new Response(
      `data: ${JSON.stringify({
        response: {
          candidates: [
            { content: { role: "model", parts: [{ text: providerText }] }, finishReason: "STOP" },
          ],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 1,
            ...(omitThoughts ? {} : { thoughtsTokenCount: 0 }),
            totalTokenCount: 3,
          },
        },
      })}\n\n`,
      { status: upstreamStatus, headers: { "content-type": "text/event-stream" } }
    );
  };
  ({ POST } = await import("../../src/app/api/v1/chat/completions/route.ts"));
  await updateSettings({
    semanticCacheEnabled: false,
    memoryEnabled: false,
    compressionEnabled: false,
    globalFallbackModel: "openai/gpt-5.4",
    streamDefaultMode: "json",
  });
  connectionId = String(
    (
      await createProviderConnection({
        provider: "agy",
        authType: "oauth",
        name: "synthetic-agy-contract",
        accessToken,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: { projectId },
      })
    ).id
  );
  selectorId = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-agy-free-selector",
        apiKey: "synthetic-agy-free-selector",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  alternateId = String(
    (
      await createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "synthetic-agy-alternate",
        apiKey: "synthetic-agy-alternate",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    ).id
  );
  key = await createApiKey("synthetic-agy-contract-client", "synthetic-machine");
  const combo = await createCombo({
    name: model,
    strategy: "priority",
    models: [`agy/${BOUNDED_AGY_MODEL}`],
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        selection: {
          mode: "native",
          provider: "opencode-zen",
          model: "jev-1.13-free",
          connectionId: selectorId,
          timeoutMs: 1000,
        },
        connections: { chosen: connectionId },
        policy: {
          version: 1,
          candidates: [
            {
              id: "chosen",
              provider: "agy",
              model: BOUNDED_AGY_MODEL,
              endpointKind: "direct",
              evidence: "Synthetic contract fixture, not live availability or measured quality",
              capabilities: {
                text: true,
                images: false,
                tools: false,
                reasoning: true,
                contextTokens: 100000,
              },
              effort: {
                mode: "set",
                value: "high",
                supported: ["high"],
                evidence: "Synthetic exact-pair fixture",
              },
            },
          ],
          taskOrder: { explanation: ["chosen"] },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: 1,
          maxExecutionAttempts: 1,
          timeoutMs: 5000,
        },
      },
    },
  });
  comboId = String(combo.id);
  savedConfig = (await getComboByName(model))!.config as FixtureConfig;
});
beforeEach(async () => {
  calls = 0;
  decisionCalls = 0;
  upstreamStatus = 200;
  omitThoughts = false;
  providerText = "Synthetic OK";
  key = await createApiKey("synthetic-agy-contract-independent", "synthetic-machine");
  await updateCombo(comboId, { config: structuredClone(savedConfig) });
  await updateProviderConnection(connectionId, {
    accessToken,
    apiKey: null,
    authType: "oauth",
    isActive: true,
    testStatus: "active",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    providerSpecificData: { projectId },
    lastError: null,
    lastErrorType: null,
  });
  await resetConnectionBackoff(connectionId);
  const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
  clearAllModelLockouts();
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
});
after(async () => {
  globalThis.fetch = originalFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(
    unexpected,
    0,
    "no bootstrap, model discovery, refresh, credit, version or fallback call"
  );
});
test("actual POST sole-eligible Gemini High streams through its exact guarded account once", async () => {
  const response = await POST(request());
  const text = await response.text();
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? text);
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "sole-eligible");
  assert.match(text, /Synthetic OK/);
  assert.match(text, /\[DONE\]/);
  assert.equal(calls, 1);
  assert.equal(wire.model, BOUNDED_AGY_MODEL);
  assert.equal(wire.project, projectId);
  assert.equal(wire.request.generationConfig.maxOutputTokens, 16);
  assert.equal(wire.request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(wire.userAgent, undefined);
  assert.equal(wire.requestType, undefined);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.lane, "execution");
  assert.equal(row.provider, "agy");
  assert.equal(row.model, BOUNDED_AGY_MODEL);
  assert.equal(row.connection_id, connectionId);
  assert.equal(row.effort, "high");
  assert.equal(row.state, "completed");
  assert.equal(row.application_status, 200);
  assert.equal(row.input_tokens, 2);
  assert.equal(row.output_tokens, 1);
  assert.equal(row.reasoning_tokens, 0);
  assert.equal(row.cost_usd, null);
});

function request(
  patch: Record<string, unknown> = {},
  token: string | null = key.key,
  signal?: AbortSignal
) {
  return new Request("http://synthetic.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Explain a synthetic lamp." }],
      max_tokens: 16,
      reasoning_effort: "high",
      stream: true,
      stream_options: { include_usage: true },
      ...patch,
    }),
  });
}
test("actual native free Jev selection can choose the exact eligible AGY High pair", async () => {
  const config = structuredClone(savedConfig);
  const alternate = {
    ...structuredClone(config.decisionPolicy.policy.candidates[0]),
    id: "alternate",
    provider: "openai",
    model: "gpt-5.4",
  };
  config.decisionPolicy.policy.candidates.push(alternate);
  config.decisionPolicy.connections.alternate = alternateId;
  config.decisionPolicy.policy.taskOrder.explanation.push("alternate");
  await updateCombo(comboId, { config });
  const response = await POST(request());
  const text = await response.text();
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? text);
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "native");
  assert.match(text, /Synthetic OK/);
  assert.equal(decisionCalls, 1);
  assert.equal(calls, 1);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.filter((row) => row.lane === "decision").length, 1);
  assert.equal(rows.filter((row) => row.lane === "execution").length, 1);
  assert.equal(rows.find((row) => row.lane === "execution")!.model, BOUNDED_AGY_MODEL);
});
test("missing thought usage remains unknown rather than inferred from total", async () => {
  omitThoughts = true;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const row = readDecisionAttempts(key.id)[0];
  assert.equal(row.input_tokens, 2);
  assert.equal(row.output_tokens, null);
  assert.equal(row.reasoning_tokens, null);
  assert.equal(row.cost_usd, null);
});
for (const status of [401, 403, 404, 429, 503])
  test(`actual AGY HTTP${status} is terminal after one execution`, async () => {
    upstreamStatus = status;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, status);
    assert.equal(calls, 1);
    assert.equal(decisionCalls, 0);
    assert.equal(readDecisionAttempts(key.id).filter((row) => row.lane === "execution").length, 1);
  });
for (const [name, patch] of Object.entries({
  project: { providerSpecificData: {} },
  expiry: { expiresAt: new Date(0).toISOString() },
  apiKey: { apiKey: "synthetic-wrong-key" },
  metadata: { providerSpecificData: { projectId, baseUrl: "https://synthetic.invalid" } },
}))
  test(`actual unsupported AGY ${name} sends nothing`, async () => {
    await updateProviderConnection(connectionId, patch);
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(calls, 0);
    assert.equal(decisionCalls, 0);
  });
for (const [name, patch] of Object.entries({
  nonstream: { stream: false, stream_options: undefined },
  tools: {
    tools: [{ type: "function", function: { name: "synthetic", parameters: { type: "object" } } }],
  },
  sampling: { temperature: 1 },
  effort: { reasoning_effort: "medium" },
}))
  test(`actual unsupported AGY request ${name} sends nothing`, async () => {
    const response = await POST(request(patch));
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(calls, 0);
    assert.equal(decisionCalls, 0);
  });
test("unauthenticated AGY combo request has zero dispatch", async () => {
  const response = await POST(request({}, null));
  await response.text();
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
  assert.equal(decisionCalls, 0);
});
test("cancelled AGY request has zero dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await POST(request({}, key.key, controller.signal));
  await response.text();
  assert.notEqual(response.status, 200);
  assert.equal(calls, 0);
  assert.equal(decisionCalls, 0);
});
for (const mutation of ["model", "project", "effort", "cap", "sampling", "credits"]) {
  test(`actual AGY final formatter ${mutation} mutation sends nothing`, async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
    const original = AntigravityExecutor.prototype.transformRequest;
    AntigravityExecutor.prototype.transformRequest = async function (...args) {
      const transformed = await original.apply(this, args);
      assert.ok(!(transformed instanceof Response));
      const value = transformed as unknown as FixtureWire;
      if (mutation === "model") value.model = "gemini-3.8-flash";
      if (mutation === "project") value.project = "synthetic-other-project";
      if (mutation === "effort")
        value.request.generationConfig.thinkingConfig.thinkingLevel = "low";
      if (mutation === "cap") value.request.generationConfig.maxOutputTokens = 17;
      if (mutation === "sampling") value.request.generationConfig.temperature = 1;
      if (mutation === "credits") value.enabledCreditTypes = ["GOOGLE_ONE_AI"];
      return transformed;
    };
    try {
      const response = await POST(request());
      await response.text();
      assert.equal(response.status, 409);
      assert.equal(calls, 0);
      assert.equal(decisionCalls, 0);
    } finally {
      AntigravityExecutor.prototype.transformRequest = original;
    }
  });
}
test("queued AGY account change cannot dispatch under stale prepared authority", async () => {
  const { acquire } = await import("../../open-sse/services/accountSemaphore.ts");
  await updateProviderConnection(connectionId, { maxConcurrent: 1 });
  const release = await acquire(`agy:${connectionId}`, { maxConcurrency: 1 });
  const pending = POST(request());
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await updateProviderConnection(connectionId, {
      providerSpecificData: { projectId: "synthetic-changed-project" },
    });
    release();
    const response = await pending;
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(calls, 0);
    assert.equal(decisionCalls, 0);
  } finally {
    release();
    await updateProviderConnection(connectionId, { maxConcurrent: null });
  }
});
for (const header of ["User-Agent", "Authorization"]) {
  test(`actual AGY late ${header} mutation sends nothing`, async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
    const original = AntigravityExecutor.prototype.buildHeaders;
    AntigravityExecutor.prototype.buildHeaders = function (...args) {
      return { ...original.apply(this, args), [header]: "synthetic-disallowed-header-value" };
    };
    try {
      const response = await POST(request());
      await response.text();
      assert.equal(response.status, 409);
      assert.equal(calls, 0);
      assert.equal(decisionCalls, 0);
    } finally {
      AntigravityExecutor.prototype.buildHeaders = original;
    }
  });
}

test("text-only AGY preserves tool-looking provider text without synthesizing calls", async () => {
  providerText = "[Tool call: synthetic]\nArguments: {}";
  const response = await POST(request());
  const text = await response.text();
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? text);
  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
  const content = chunks
    .flatMap((chunk) => chunk.choices ?? [])
    .map((choice) => choice.delta?.content ?? "")
    .join("");
  assert.equal(content, providerText);
  assert.match(text, /\[DONE\]/);
  assert.ok(
    chunks.flatMap((chunk) => chunk.choices ?? []).some((choice) => choice.finish_reason === "stop")
  );
  const { readToolContinuations } = await import("../../src/lib/db/decisionContinuations.ts");
  assert.deepEqual(readToolContinuations(key.id, comboId), []);
  for (const chunk of chunks)
    for (const choice of chunk.choices ?? []) {
      assert.equal(choice.delta?.tool_calls, undefined);
      assert.equal(choice.delta?.function_call, undefined);
    }
  assert.equal(calls, 1);
  assert.equal(decisionCalls, 0);
  assert.equal(readDecisionAttempts(key.id).filter((row) => row.lane === "execution").length, 1);
});
test("actual native free Jev selects historical fixed High AGY without rewriting its mode", async () => {
  const config = structuredClone(savedConfig);
  config.decisionPolicy.policy.candidates[0].effort.mode = "fixed";
  const alternate = {
    ...structuredClone(config.decisionPolicy.policy.candidates[0]),
    id: "alternate",
    provider: "openai",
    model: "gpt-5.4",
    effort: { ...config.decisionPolicy.policy.candidates[0].effort, mode: "set" as const },
  };
  config.decisionPolicy.policy.candidates.push(alternate);
  config.decisionPolicy.connections.alternate = alternateId;
  config.decisionPolicy.policy.taskOrder.explanation.push("alternate");
  await updateCombo(comboId, { config });
  const response = await POST(request());
  const text = await response.text();
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? text);
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "native");
  assert.match(text, /Synthetic OK/);
  assert.equal(decisionCalls, 1);
  assert.equal(calls, 1);
  assert.equal(wire.model, BOUNDED_AGY_MODEL);
  assert.equal(wire.request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(wire.request.generationConfig.maxOutputTokens, 16);
  const stored = (await getComboByName(model))!.config as FixtureConfig;
  assert.equal(stored.decisionPolicy.policy.candidates[0].effort.mode, "fixed");
  assert.equal(stored.decisionPolicy.policy.candidates[0].effort.value, "high");
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.filter((row) => row.lane === "decision").length, 1);
  const executions = rows.filter((row) => row.lane === "execution");
  assert.equal(executions.length, 1);
  assert.equal(executions[0].provider, "agy");
  assert.equal(executions[0].connection_id, connectionId);
  assert.equal(executions[0].model, BOUNDED_AGY_MODEL);
  assert.equal(executions[0].effort, "high");
});
