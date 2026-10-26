import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createApiKey, updateApiKeyPermissions } from "../../src/lib/db/apiKeys.ts";
import { createCombo, updateCombo } from "../../src/lib/db/combos.ts";
import { createProviderConnection, updateProviderConnection } from "../../src/lib/db/providers.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { normalizeDecisionTextRequest } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
const originalFetch = globalThis.fetch;
let executionId: string, selectorId: string, comboId: string;
let key: Awaited<ReturnType<typeof createApiKey>>;
let decisionCalls = 0,
  executionCalls = 0,
  unexpected = 0;
let lastExecution: Record<string, unknown> | undefined;
const name = "synthetic-independent-text-contract";
const candidate = (id: string, value: string) => ({
  id,
  provider: "openai",
  model: "gpt-5.4",
  endpointKind: "direct",
  evidence: "Synthetic review profile, not model-quality evidence",
  capabilities: { text: true, images: false, tools: false, reasoning: true, contextTokens: 100000 },
  effort: {
    mode: "set",
    value,
    supported: ["medium", "high"],
    evidence: "Synthetic supported effort fixture",
  },
});
function config() {
  return {
    decisionPolicy: {
      enabled: true,
      applicationMode: "bounded-v1",
      selection: {
        mode: "native",
        provider: "opencode-zen",
        model: "jev-1.13-free",
        connectionId: selectorId,
        timeoutMs: 2000,
      },
      connections: { light: executionId, deep: executionId },
      policy: {
        version: 1,
        candidates: [candidate("light", "medium"), candidate("deep", "high")],
        taskOrder: { explanation: ["light", "deep"], reasoning: ["deep", "light"] },
        unknownQuota: "allow",
        decisionFailure: "stop",
        maxDecisionAttempts: 1,
        maxExecutionAttempts: 1,
        timeoutMs: 10000,
      },
    },
  };
}
function body(patch: Record<string, unknown> = {}) {
  return {
    model: name,
    stream: false,
    max_tokens: 64,
    messages: [{ role: "user", content: "Explain this synthetic fixture." }],
    ...patch,
  };
}
function request(value: Record<string, unknown>, signal?: AbortSignal) {
  return new Request("http://synthetic.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
    body: JSON.stringify(value),
  });
}
before(async () => {
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers);
    const sent = JSON.parse(String(init.body));
    assert.equal(init.method, "POST");
    if (url === "https://opencode.ai/inference/systemone/v1/systemone") {
      decisionCalls++;
      assert.equal(headers.get("authorization"), "Bearer synthetic-review-selector");
      assert.equal(sent.model, "jev-1.13-free");
      assert.equal(headers.get("user-agent"), "OmniRoute-SystemOne/1.0");
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: "light",
            probabilities: { light: 0.8, deep: 0.2 },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 7, output_tokens: 2, cost: 0.001 },
      });
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      executionCalls++;
      lastExecution = sent;
      assert.equal(headers.get("authorization"), "Bearer synthetic-review-execution");
      assert.equal(sent.model, "gpt-5.4");
      return Response.json({
        id: "synthetic-review-result",
        model: sent.model,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Synthetic result" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.007 },
      });
    }
    unexpected++;
    throw new Error("Independent fixture rejects unexpected fetch");
  };
  await updateSettings({
    memoryEnabled: false,
    semanticCacheEnabled: false,
    compressionEnabled: false,
    autoWebSearchEnabled: false,
    webSearchEnabled: false,
    streamDefaultMode: "json",
    globalFallbackModel: "openai/gpt-5.4",
  });
  executionId = String(
    (
      await createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "synthetic-review-execution",
        apiKey: "synthetic-review-execution",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    ).id
  );
  selectorId = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-review-selector",
        apiKey: "synthetic-review-selector",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  comboId = String(
    (
      await createCombo({
        name,
        models: ["openai/gpt-5.4"],
        strategy: "priority",
        config: config(),
      })
    ).id
  );
});
beforeEach(async () => {
  lastExecution = undefined;
  key = await createApiKey("synthetic-independent-text-" + randomUUID(), "synthetic");
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  await updateProviderConnection(executionId, { maxConcurrent: null });
  await updateCombo(comboId, { config: config() });
});
after(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  globalThis.fetch = originalFetch;
  resetDbInstance();
  assert.equal(unexpected, 0);
});
test("independent POST preserves equal output and effort aliases, no-decision accounting and exact chosen identity", async () => {
  const d = decisionCalls,
    e = executionCalls;
  const response = await POST(
    request(
      body({ max_completion_tokens: 64, reasoning_effort: "high", reasoning: { effort: "high" } })
    )
  );
  assert.equal(response.status, 200, await response.text());
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "sole-eligible");
  assert.equal(response.headers.get("x-omniroute-decision-status"), "no-decision");
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e + 1);
  assert.equal(
    lastExecution?.reasoning_effort ??
      (lastExecution?.reasoning as Record<string, unknown>)?.effort,
    "high"
  );
  assert.equal(lastExecution?.max_completion_tokens ?? lastExecution?.max_tokens, 64);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lane, "execution");
  assert.equal(rows[0].connection_id, executionId);
  assert.ok(String(rows[0].selection_trace).includes("sole_eligible_no_decision"));
  const cost = JSON.parse(response.headers.get("x-omniroute-routing-cost")!);
  assert.equal(cost.totalUsd, 0.007);
  assert.equal(cost.unknownStages, 0);
  assert.equal(response.headers.has("x-omniroute-decision-confidence"), false);
  const { handleChat } = await import("../../src/sse/handlers/chat.ts");
  const multipart = body({
    reasoning: { effort: "high" },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Explain this synthetic immutable multipart fixture" }],
      },
    ],
  });
  const original = JSON.stringify(multipart);
  const parts = multipart.messages as Array<{
    role: string;
    content: Array<{ type: string; text: string }>;
  }>;
  Object.freeze(parts[0].content[0]);
  Object.freeze(parts[0].content);
  Object.freeze(parts[0]);
  Object.freeze(parts);
  Object.freeze(multipart.reasoning);
  Object.freeze(multipart);
  const frozenResult = await handleChat(request(multipart), null, multipart);
  assert.equal(frozenResult.status, 200, await frozenResult.text());
  assert.equal(JSON.stringify(multipart), original);
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e + 2);
});
test("independent POST rejects raw contradictions and unknown nested controls before every synthetic send", async () => {
  const d = decisionCalls,
    e = executionCalls;
  for (const patch of [
    { reasoning_effort: "high", reasoning: { effort: "high", enabled: false } },
    { reasoning_effort: "high", reasoning: { effort: "high", unrecognized: false } },
    { reasoning_effort: "high", reasoning: { effort: "medium" } },
    { reasoning: { effort: "high", enabled: true } },
    { max_completion_tokens: 65 },
    { max_tokens: null },
    { max_tokens: 1000001 },
    { max_tokens: 64, temperature: 0 },
  ]) {
    const response = await POST(request(body(patch)));
    await response.text();
    assert.ok(response.status >= 400);
  }
  // SOURCE-DERIVED synthetic Hermes custom-chat shapes, pinned to official
  // NousResearch/hermes-agent 749cb638ff43f9ce5333c186a1e4f67d473aa4f2.
  // These are not captured client payloads or evidence of live compatibility.
  const normalCustom = body({
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: "high",
    tools: [
      {
        type: "function",
        function: { name: "synthetic_tool", parameters: { type: "object", properties: {} } },
      },
    ],
  });
  const { max_tokens: _configuredCap, ...withoutCap } = body({ reasoning_effort: "high" });
  for (const sourceDerived of [normalCustom, withoutCap]) {
    const rejected = await POST(request(sourceDerived));
    await rejected.text();
    assert.equal(rejected.status, 409);
  }
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e);
  assert.equal(readDecisionAttempts(key.id).length, 0);
});
test("independent POST retains the native two-option path and zero-eligible remains zero calls", async () => {
  const d = decisionCalls,
    e = executionCalls;
  const selected = await POST(request(body()));
  assert.equal(selected.status, 200, await selected.text());
  assert.equal(selected.headers.get("x-omniroute-selection-mode"), "native");
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e + 1);
  const next = config();
  for (const row of next.decisionPolicy.policy.candidates) row.capabilities.text = false;
  await updateCombo(comboId, { config: next });
  const rejected = await POST(request(body({ reasoning_effort: "high" })));
  await rejected.text();
  assert.equal(rejected.status, 409);
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e + 1);
});
test("independent singleton final guard rechecks queued authorization and caller cancellation", async () => {
  const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
  await updateProviderConnection(executionId, { maxConcurrent: 1 });
  const semaphore = `openai:${executionId}`,
    release = await acquire(semaphore, { maxConcurrency: 1 });
  const d = decisionCalls,
    e = executionCalls;
  const pending = POST(request(body({ reasoning_effort: "high" })));
  try {
    for (let i = 0; i < 300 && !getStats()[semaphore]?.queued; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(getStats()[semaphore]?.queued, 1);
    await updateApiKeyPermissions(key.id, { allowedConnections: [selectorId] });
    release();
    const response = await pending;
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls, d);
    assert.equal(executionCalls, e);
    assert.equal(readDecisionAttempts(key.id)[0].state, "cancelled");
  } finally {
    release();
    await Promise.allSettled([pending]);
  }
  const cancel = new AbortController();
  cancel.abort();
  const response = await POST(request(body({ reasoning_effort: "high" }), cancel.signal));
  await response.text();
  assert.ok(response.status >= 400);
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e);
});
test("independent normalizer rejects bounds and nested getters without mutating input", () => {
  let reads = 0;
  const malformed = body({
    reasoning: Object.defineProperty({}, "effort", {
      get() {
        reads++;
        return "high";
      },
      enumerable: true,
    }),
  });
  assert.equal(normalizeDecisionTextRequest(malformed), null);
  assert.equal(reads, 0);
  assert.equal(
    normalizeDecisionTextRequest(
      body({ messages: [{ role: "user", content: "x".repeat(262145) }] })
    ),
    null
  );
  const original = body({ reasoning: { effort: "high" } }),
    before = JSON.stringify(original);
  const normalized = normalizeDecisionTextRequest(original)!;
  normalized.messages[0].content = "changed synthetic copy";
  assert.equal(JSON.stringify(original), before);
  const multipart = body({
    messages: [{ role: "user", content: [{ type: "text", text: "Synthetic original part" }] }],
  });
  const multipartBefore = JSON.stringify(multipart);
  const normalizedParts = normalizeDecisionTextRequest(multipart)!;
  (normalizedParts.messages[0].content as Array<{ type: string; text: string }>)[0].text =
    "Changed normalized copy";
  assert.equal(JSON.stringify(multipart), multipartBefore);
});

test("independent singleton keeps account-exclusive and requested-combo quota guards", async () => {
  const { acquireExclusiveConnectionLease, releaseExclusiveConnectionLease } =
    await import("../../src/lib/db/exclusiveConnectionLeases.ts");
  const holder = await createApiKey("synthetic-text-exclusive-holder", "synthetic");
  const owner = `vlo_${"r".repeat(43)}`;
  const acquired = acquireExclusiveConnectionLease({
    leaseOwnerId: owner,
    apiKeyId: holder.id,
    provider: "openai",
    connectionId: executionId,
  });
  assert.ok("lease" in acquired && acquired.kind === "ACQUIRED");
  const d = decisionCalls,
    e = executionCalls;
  try {
    const blocked = await POST(request(body({ reasoning_effort: "high" })));
    await blocked.text();
    assert.equal(blocked.status, 409);
    assert.equal(decisionCalls, d);
    assert.equal(executionCalls, e);
    assert.equal(readDecisionAttempts(key.id).length, 0);
  } finally {
    releaseExclusiveConnectionLease({
      leaseOwnerId: owner,
      apiKeyId: holder.id,
      generation: acquired.lease.generation,
    });
  }
  const { upsertTokenLimit } = await import("../../src/lib/db/tokenLimits.ts");
  upsertTokenLimit({ apiKeyId: key.id, scopeType: "model", scopeValue: name, tokenLimit: 1000 });
  const capped = await POST(request(body({ reasoning_effort: "high" })));
  await capped.text();
  assert.equal(capped.status, 409);
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e);
  assert.equal(readDecisionAttempts(key.id).length, 0);
});

test("independent annotation failures preserve committed native and sole-eligible responses without replay", async () => {
  const db = getDbInstance(),
    originalPrepare = db.prepare;
  const d = decisionCalls,
    e = executionCalls;
  db.prepare = function (sql: string) {
    if (/SELECT cost_usd FROM decision_application_attempts WHERE request_id=/i.test(sql))
      throw new Error("Synthetic annotation read failure");
    return originalPrepare.call(db, sql);
  };
  try {
    for (const patch of [{}, { reasoning_effort: "high" }]) {
      const response = await POST(request(body(patch)));
      assert.equal(response.status, 200, await response.text());
      assert.equal(response.headers.get("x-omniroute-routing-cost-status"), "unknown");
      assert.equal(response.headers.has("x-omniroute-routing-cost"), false);
    }
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e + 2);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.state === "completed" && row.cost_usd !== null));
  assert.equal(rows.filter((row) => row.lane === "execution").length, 2);
});

test("independent final wire rejects a formatter-introduced conflicting secondary effort", async (context) => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const executor = await getExecutor("openai"),
    original = executor.transformRequest;
  const d = decisionCalls,
    e = executionCalls;
  executor.transformRequest = async function (...args: Parameters<typeof original>) {
    const wire = await original.apply(this, args);
    assert.ok(wire && typeof wire === "object" && !Array.isArray(wire));
    return { ...wire, reasoning: { effort: "medium" } };
  };
  try {
    const response = await POST(request(body({ reasoning_effort: "high" })));
    await response.text();
    context.diagnostic(
      JSON.stringify({
        synthetic: true,
        status: response.status,
        decisions: decisionCalls - d,
        executions: executionCalls - e,
        primaryEffort: lastExecution?.reasoning_effort,
        secondaryEffort: (lastExecution?.reasoning as Record<string, unknown> | undefined)?.effort,
      })
    );
    assert.equal(response.status, 409);
    assert.equal(decisionCalls, d);
    assert.equal(executionCalls, e);
  } finally {
    executor.transformRequest = original;
  }
});
