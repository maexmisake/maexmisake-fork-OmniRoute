import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createCombo, updateCombo } from "../../src/lib/db/combos.ts";
import { createProviderConnection, updateProviderConnection } from "../../src/lib/db/providers.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { readToolContinuations } from "../../src/lib/db/decisionContinuations.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import {
  BOUNDED_AGY_MODEL,
  BOUNDED_AGY_STREAM_URL,
} from "../../open-sse/executors/antigravity/bounded.ts";

// Closed synthetic protocol fixture. Signatures below are opaque test strings,
// not cryptographically validated provider signatures or live entitlement proof.
type Json = Record<string, unknown>;
type Call = { id: string; type: "function"; function: { name: string; arguments: string } };
type Wire = {
  model: string;
  project: string;
  request: {
    contents: Array<{ role: string; parts: Json[] }>;
    generationConfig: { maxOutputTokens: number; thinkingConfig: { thinkingLevel: string } };
  };
};
const MODEL = "synthetic-agy-tools-contract";
const SELECTOR = "https://opencode.ai/inference/systemone/v1/systemone";
const TOKEN = "synthetic-agy-tools-oauth";
const PROJECT = "synthetic-agy-tools-project";
const TOOL = {
  type: "function",
  function: {
    name: "synthetic_lookup",
    parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  },
};
const user = { role: "user", content: "Inspect a synthetic lamp." };
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let ownerKeyId: string;
let agyId: string, claudeId: string, selectorId: string, comboId: string;
let decisions = 0,
  executions = 0,
  unexpected = 0,
  parallel = false;
let responseFault = "",
  executionStatus = 200,
  holdOpen = false;
let wireFault: ((wire: Wire) => void) | undefined;
let afterDecision: (() => Promise<void>) | undefined;
let beforeEOF: (() => Promise<void>) | undefined;
let restoreFormatter: (() => void) | undefined;
const wires: Wire[] = [];
const traces: Json[] = [];

function candidate(provider: "agy" | "claude") {
  return {
    id: provider + "-high",
    provider,
    model: provider === "agy" ? BOUNDED_AGY_MODEL : "claude-sonnet-5-5",
    endpointKind: "direct",
    evidence: "Synthetic tool contract fixture, not live availability or measured quality",
    capabilities: {
      text: true,
      images: false,
      tools: true,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: { mode: "set", value: "high", supported: ["high"], evidence: "Synthetic exact pair" },
  };
}
function config(sole = false) {
  const ids = sole ? ["agy-high"] : ["agy-high", "claude-high"];
  return {
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
      connections: { "agy-high": agyId, "claude-high": claudeId },
      policy: {
        version: 1,
        candidates: sole ? [candidate("agy")] : [candidate("agy"), candidate("claude")],
        taskOrder: { tools: ids, continuation: ids },
        unknownQuota: "allow",
        decisionFailure: "stop",
        maxDecisionAttempts: 1,
        maxExecutionAttempts: 1,
        timeoutMs: 5000,
      },
    },
  };
}
function body(messages: Json[] = [user]): Json {
  return {
    model: MODEL,
    messages,
    max_tokens: 64,
    reasoning_effort: "high",
    stream: true,
    stream_options: { include_usage: true },
    tools: [structuredClone(TOOL)],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}
function request(value: Json, token: string | null = key.key, signal?: AbortSignal) {
  return new Request("https://synthetic.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value),
  });
}
function originalParts(): Json[] {
  return [
    {
      functionCall: {
        id: "fixture-call-one",
        name: "synthetic_lookup",
        args: { item: "synthetic lamp" },
      },
      thoughtSignature: "synthetic-opaque-agy-signature-not-cryptographic-proof",
    },
    ...(parallel
      ? [
          {
            functionCall: {
              id: "fixture-call-two",
              name: "synthetic_lookup",
              args: { item: "synthetic switch" },
            },
          },
        ]
      : []),
  ];
}
function providerResponse() {
  if (executionStatus !== 200)
    return Response.json(
      { error: { message: "Synthetic terminal access denial" } },
      { status: executionStatus, headers: executionStatus === 429 ? { "retry-after": "17" } : {} }
    );
  if (responseFault === "raw-error")
    return new Response('data: {"error":{"message":"Synthetic raw error"}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  const parts =
    responseFault === "no-call-safety"
      ? [{ text: "Synthetic safety refusal" }]
      : executions === 1
        ? originalParts()
        : [{ text: "Synthetic continuation OK" }];
  if (responseFault === "missing-signature") delete parts[0].thoughtSignature;
  if (responseFault === "malformed") (parts[0].functionCall as Json).args = "not-an-object";
  const payload = {
    response: {
      ...(responseFault === "prompt-refusal"
        ? { promptFeedback: { blockReason: "SAFETY" } }
        : {
            candidates: [
              {
                index: 0,
                content: { role: "model", parts },
                ...(responseFault === "partial" || holdOpen
                  ? {}
                  : {
                      finishReason: ["refused", "no-call-safety"].includes(responseFault)
                        ? "SAFETY"
                        : "STOP",
                    }),
              },
            ],
          }),
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 1,
        totalTokenCount: 6,
      },
    },
  };
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          if (!holdOpen && !beforeEOF) controller.close();
        },
        async pull(controller) {
          if (!beforeEOF) return;
          const callback = beforeEOF;
          beforeEOF = undefined;
          await callback();
          controller.close();
        },
      },
      { highWaterMark: 0 }
    ),
    { headers: { "content-type": "text/event-stream" } }
  );
}
before(async () => {
  process.env.REQUIRE_API_KEY = "true";
  process.env.APP_LOG_TO_FILE = "false";
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init.method !== "POST" || ![SELECTOR, BOUNDED_AGY_STREAM_URL].includes(url)) {
      unexpected++;
      throw new Error("Closed AGY tools fixture rejected unintended dispatch");
    }
    const sent = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    if (url === SELECTOR) {
      decisions++;
      assert.equal(headers.get("authorization"), "Bearer synthetic-agy-tools-selector");
      assert.deepEqual(Object.keys(sent.questions.route.criteria).sort(), [
        "agy-high",
        "claude-high",
      ]);
      for (const value of ["synthetic lamp", "Synthetic result", "synthetic-opaque-agy-signature"])
        assert.ok(!JSON.stringify(sent).includes(value));
      await afterDecision?.();
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: "agy-high",
            probabilities: { "agy-high": 0.8, "claude-high": 0.2 },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 7, output_tokens: 1, cost: 0 },
      });
    }
    executions++;
    wires.push(sent);
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(headers.get("user-agent"), "OmniRoute-Antigravity/1.0");
    assert.equal(sent.model, BOUNDED_AGY_MODEL);
    assert.equal(sent.project, PROJECT);
    assert.equal(sent.request.generationConfig.maxOutputTokens, 64);
    assert.equal(sent.request.generationConfig.thinkingConfig.thinkingLevel, "high");
    return providerResponse();
  };
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
  const original = AntigravityExecutor.prototype.transformRequest;
  AntigravityExecutor.prototype.transformRequest = async function (...args) {
    const result = await original.apply(this, args);
    if (!(result instanceof Response)) wireFault?.(result as unknown as Wire);
    return result;
  };
  restoreFormatter = () => {
    AntigravityExecutor.prototype.transformRequest = original;
  };
  const closed = globalThis.fetch;
  ({ POST } = await import("../../src/app/api/v1/chat/completions/route.ts"));
  assert.equal(globalThis.fetch, closed);
  await updateSettings({
    memoryEnabled: false,
    semanticCacheEnabled: false,
    compressionEnabled: false,
    autoWebSearchEnabled: false,
    webSearchEnabled: false,
    globalFallbackModel: "openai/gpt-5.4",
    streamDefaultMode: "json",
  });
  selectorId = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-agy-tools-selector",
        apiKey: "synthetic-agy-tools-selector",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  comboId = String(
    (
      await createCombo({
        name: MODEL,
        strategy: "priority",
        models: [`agy/${BOUNDED_AGY_MODEL}`],
        config: {},
      })
    ).id
  );
});
beforeEach(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  key = await createApiKey("synthetic-agy-tools-" + randomUUID(), "synthetic");
  ownerKeyId = key.id;
  agyId = String(
    (
      await createProviderConnection({
        provider: "agy",
        authType: "oauth",
        name: "synthetic-agy-tools-" + randomUUID(),
        accessToken: TOKEN,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: { projectId: PROJECT },
      })
    ).id
  );
  claudeId = String(
    (
      await createProviderConnection({
        provider: "claude",
        authType: "oauth",
        name: "synthetic-agy-tools-claude-" + randomUUID(),
        accessToken: "synthetic-agy-tools-claude",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    ).id
  );
  await updateCombo(comboId, { config: config() });
  decisions = 0;
  executions = 0;
  wires.length = 0;
  parallel = false;
  responseFault = "";
  executionStatus = 200;
  holdOpen = false;
  wireFault = undefined;
  afterDecision = undefined;
  beforeEOF = undefined;
});
afterEach((context) => {
  traces.push({
    case: context.name,
    decisions,
    executions,
    unexpected,
    wires: wires.map((wire) => ({
      model: wire.model,
      projectMatches: wire.project === PROJECT,
      outputCap: wire.request.generationConfig.maxOutputTokens,
      effort: wire.request.generationConfig.thinkingConfig.thinkingLevel,
    })),
    receipts: readDecisionAttempts(ownerKeyId).map((row) => ({
      lane: row.lane,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      state: row.state,
      httpStatus: row.http_status,
      applicationStatus: row.application_status,
      input: row.input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      costUsd: row.cost_usd,
    })),
  });
});
after(async () => {
  if (process.env.DECISION_AGY_TOOLS_TRACE_FILE)
    writeFileSync(
      process.env.DECISION_AGY_TOOLS_TRACE_FILE,
      JSON.stringify(traces, null, 2) + "\n"
    );
  restoreFormatter?.();
  globalThis.fetch = originalFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(
    unexpected,
    0,
    "no Claude, paid fallback, refresh, discovery, bootstrap or credit calls"
  );
});
async function consume(response: Response) {
  return response.text();
}
function callsFrom(text: string): Call[] {
  const calls = new Map<number, Call>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const payload = JSON.parse(line.slice(6));
    for (const next of payload.choices?.[0]?.delta?.tool_calls ?? []) {
      const old = calls.get(next.index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (next.id) old.id = next.id;
      if (next.function?.name) old.function.name = next.function.name;
      old.function.arguments += next.function?.arguments ?? "";
      calls.set(next.index, old);
    }
  }
  return [...calls.values()];
}
async function begin() {
  const response = await POST(request(body()));
  let text: string;
  try {
    text = await consume(response);
  } catch (error) {
    throw new Error(
      JSON.stringify({
        stage: "initial-tool-response",
        status: response.status,
        reason: response.headers.get("x-omniroute-decision-reason"),
        decisions,
        executions,
        receipts: readDecisionAttempts(key.id).map((row) => ({
          lane: row.lane,
          state: row.state,
          httpStatus: row.http_status,
          applicationStatus: row.application_status,
        })),
      }),
      { cause: error }
    );
  }
  assert.equal(
    response.status,
    200,
    JSON.stringify({
      reason: response.headers.get("x-omniroute-decision-reason"),
      decisions,
      executions,
    })
  );
  assert.match(text, /data: \[DONE\]/);
  const calls = callsFrom(text);
  assert.equal(calls.length, parallel ? 2 : 1);
  assert.deepEqual(
    calls.map((call) => call.id),
    originalParts().map((part) => (part.functionCall as Json).id)
  );
  assert.equal(readToolContinuations(key.id, comboId).length, 1);
  const history: Json[] = [
    structuredClone(user),
    { role: "assistant", content: null, tool_calls: calls },
    ...[...calls].reverse().map((call) => ({
      role: "tool",
      tool_call_id: call.id,
      content: "Synthetic result " + call.id,
    })),
  ];
  return body(history);
}
test("sole AGY native tool contract reaches its exact mock instead of no-route", async () => {
  await updateCombo(comboId, { config: config(true) });
  await begin();
  assert.equal(decisions, 0);
  assert.equal(executions, 1);
});
for (const count of [1, 2])
  test(`native free Jev selects AGY High and ${count} signed native calls continue without redecision`, async () => {
    parallel = count === 2;
    const continuation = await begin();
    const response = await POST(request(continuation));
    assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? "");
    assert.match(await consume(response), /Synthetic continuation OK/);
    assert.equal(response.headers.get("x-omniroute-selection-mode"), "continuation-pin");
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
    const parts = wires[1].request.contents.flatMap((row) => row.parts);
    assert.deepEqual(
      parts.filter((part) => part.functionCall),
      originalParts()
    );
    assert.deepEqual(
      parts.filter((part) => part.functionResponse),
      originalParts().map((part) => ({
        functionResponse: {
          id: (part.functionCall as Json).id,
          name: "synthetic_lookup",
          response: { output: "Synthetic result " + (part.functionCall as Json).id },
        },
      })),
      "parallel client results are restored in native call order after all call parts"
    );
    assert.ok(
      parts.findIndex((part) => part.functionResponse) >
        parts.findLastIndex((part) => part.functionCall)
    );
    assert.ok(!JSON.stringify(wires[1]).includes("skip_thought_signature_validator"));
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.filter((row) => row.lane === "decision").length, 1);
    const attempts = rows.filter((row) => row.lane === "execution");
    assert.equal(attempts.length, 2);
    assert.equal(new Set(attempts.map((row) => row.id)).size, 2);
    for (const row of attempts) {
      assert.equal(row.connection_id, agyId);
      assert.equal(row.provider, "agy");
      assert.equal(row.model, BOUNDED_AGY_MODEL);
      assert.equal(row.effort, "high");
      assert.equal(row.application_status, 200);
      assert.equal(row.state, "completed");
      assert.equal(row.input_tokens, 2);
      assert.equal(row.output_tokens, 4);
      assert.equal(row.reasoning_tokens, 1);
      assert.equal(row.cost_usd, null);
    }
    assert.equal(rows.find((row) => row.lane === "decision")?.cost_usd, 0);
    assert.ok(
      !JSON.stringify(rows).includes("synthetic-opaque-agy-signature"),
      "public receipt/trace projections contain no raw signature"
    );
    const rpm = getDbInstance()
      .prepare(
        "SELECT SUM(consumed) AS used FROM api_key_quota_counters WHERE api_key_id=? AND dimension_key='key-quota:rpm'"
      )
      .get(key.id) as { used: number };
    assert.equal(rpm.used, 2, "initial and continuation are separately admitted logical requests");
  });

for (const mutation of ["cross-key", "account", "model", "prefix", "tools", "foreign-id"])
  test(`AGY continuation rejects ${mutation} before another physical call`, async () => {
    const continuation = await begin();
    if (mutation === "cross-key")
      key = await createApiKey("synthetic-foreign-agy-" + randomUUID(), "synthetic");
    if (mutation === "account") await updateProviderConnection(agyId, { isActive: false });
    if (mutation === "model") {
      const changed = config();
      changed.decisionPolicy.policy.candidates[0].model = "claude-opus-4-6-thinking";
      await updateCombo(comboId, { config: changed });
    }
    if (mutation === "prefix")
      (continuation.messages as Json[])[0].content = "Changed synthetic task";
    if (mutation === "tools")
      (
        continuation.tools as Array<{ function: { parameters: Json } }>
      )[0].function.parameters.description = "Changed declared schema";
    if (mutation === "foreign-id")
      (continuation.messages as Json[]).at(-1)!.tool_call_id = "foreign-call";
    const response = await POST(request(continuation));
    await consume(response);
    assert.ok(response.status >= 400);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  });
test("missing private AGY replay fails closed rather than using the ordinary ID cache", async () => {
  const continuation = await begin();
  const path = "../../src/lib/decisionPolicy/geminiToolReplay.ts";
  const replay = await import(path);
  assert.equal(typeof replay.__clearGeminiToolReplayForTests, "function");
  replay.__clearGeminiToolReplayForTests();
  const response = await POST(request(continuation));
  await consume(response);
  assert.ok(response.status >= 400);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
});
test("a consumed AGY continuation cannot claim another physical attempt", async () => {
  const continuation = await begin();
  const accepted = await POST(request(continuation));
  assert.equal(accepted.status, 200);
  await consume(accepted);
  const repeated = await POST(request(continuation));
  await consume(repeated);
  assert.ok(repeated.status >= 400);
  assert.equal(decisions, 1);
  assert.equal(executions, 2);
});
for (const fault of ["missing-signature", "malformed", "partial", "refused", "raw-error"])
  test(`AGY ${fault} response cannot publish continuation authority`, async () => {
    responseFault = fault;
    const response = await POST(request(body()));
    let text = "";
    try {
      text = await consume(response);
    } catch (error) {
      assert.match(String(error), /decision_stream_rejected|stream|abort/i);
    }
    assert.ok(response.status >= 400 || !text.includes("data: [DONE]"));
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    const execution = readDecisionAttempts(key.id).find((row) => row.lane === "execution")!;
    assert.ok(Number(execution.application_status) >= 400);
    assert.equal(execution.cost_usd, null, "no exact AGY USD receipt is invented");
  });
for (const status of [401, 403, 429])
  test(`AGY tool HTTP${status} is terminal with unknown usage and no retry`, async () => {
    executionStatus = status;
    const response = await POST(request(body()));
    await consume(response);
    assert.equal(response.status, status);
    if (status === 429) assert.equal(response.headers.get("retry-after"), "17");
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    const row = readDecisionAttempts(key.id).find((item) => item.lane === "execution")!;
    assert.equal(row.http_status, status);
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cost_usd, null);
  });
for (const change of ["cap", "high", "signature"])
  test(`late AGY continuation ${change} mutation is fenced before dispatch`, async () => {
    const continuation = await begin();
    wireFault = (wire) => {
      if (change === "cap") wire.request.generationConfig.maxOutputTokens = 65;
      if (change === "high") wire.request.generationConfig.thinkingConfig.thinkingLevel = "low";
      if (change === "signature") {
        const part = wire.request.contents
          .flatMap((row) => row.parts)
          .find((row) => row.functionCall)!;
        assert.ok(part);
        part.thoughtSignature = "skip_thought_signature_validator";
      }
    };
    const response = await POST(request(continuation));
    await consume(response);
    assert.ok(response.status >= 400);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  });
test("unauthenticated AGY tool request dispatches nothing", async () => {
  const response = await POST(request(body(), null));
  await consume(response);
  assert.equal(response.status, 401);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
});
test("pre-cancelled AGY tool request dispatches nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await POST(request(body(), key.key, controller.signal));
  await consume(response);
  assert.ok(response.status >= 400);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
});
test("client cancellation before AGY terminal cannot issue a handoff or another attempt", async () => {
  holdOpen = true;
  const response = await POST(request(body()));
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  assert.equal(
    readDecisionAttempts(key.id).find((row) => row.lane === "execution")?.application_status,
    499
  );
});
test("late client abort after committed AGY completion does not remint or roll back authority", async () => {
  const controller = new AbortController();
  const response = await POST(request(body(), key.key, controller.signal));
  assert.equal(response.status, 200);
  assert.match(await consume(response), /data: \[DONE\]/);
  controller.abort();
  assert.equal(readToolContinuations(key.id, comboId).length, 1);
  assert.equal(
    readDecisionAttempts(key.id).find((row) => row.lane === "execution")?.application_status,
    200
  );
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
});
test("queued policy change after native selection rejects before AGY execution", async () => {
  afterDecision = async () => {
    const changed = config();
    changed.decisionPolicy.policy.taskOrder.tools = ["claude-high"];
    await updateCombo(comboId, { config: changed });
  };
  const response = await POST(request(body()));
  await consume(response);
  assert.ok(response.status >= 400);
  assert.equal(decisions, 1);
  assert.equal(executions, 0);
});
test("queued AGY account change is rechecked after the physical admission wait", async () => {
  const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
  await updateProviderConnection(agyId, { maxConcurrent: 1 });
  const release = await acquire(`agy:${agyId}`, { maxConcurrency: 1 });
  const pending = POST(request(body()));
  try {
    const deadline = Date.now() + 2000;
    while (!getStats()[`agy:${agyId}`]?.queued && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      getStats()[`agy:${agyId}`]?.queued,
      1,
      "the physical request must actually be queued"
    );
    await updateProviderConnection(agyId, {
      providerSpecificData: { projectId: "synthetic-changed-project" },
    });
    release();
    const response = await pending;
    await consume(response);
    assert.ok(response.status >= 400);
    assert.equal(decisions, 1);
    assert.equal(executions, 0);
  } finally {
    release();
  }
});
test("unsupported nonparallel tool control is rejected before selection", async () => {
  await updateCombo(comboId, { config: config(true) });
  const response = await POST(request({ ...body(), parallel_tool_calls: false }));
  await consume(response);
  assert.ok(response.status >= 400);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
});

test("no-call SAFETY and prompt refusal preserve refusal status without handoff", async () => {
  for (const fault of ["no-call-safety", "prompt-refusal"]) {
    responseFault = fault;
    const before = { decisions, executions };
    const response = await POST(request(body()));
    const text = await consume(response);
    assert.equal(response.status, 200, fault);
    assert.match(text, /content_filter/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(callsFrom(text).length, 0);
    assert.equal(decisions, before.decisions + 1);
    assert.equal(executions, before.executions + 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    const row = readDecisionAttempts(key.id)
      .filter((item) => item.lane === "execution")
      .at(-1)!;
    assert.equal(row.http_status, 200);
    assert.equal(row.application_status, 422);
    assert.equal(row.input_tokens, 2);
    assert.equal(row.output_tokens, 4);
    assert.equal(row.reasoning_tokens, 1);
    assert.equal(row.cost_usd, null);
  }
});
test("failed AGY handoff publication retains physical usage and discards private replay", async () => {
  beforeEOF = async () => {
    const changed = config();
    changed.decisionPolicy.policy.taskOrder.continuation = ["claude-high"];
    await updateCombo(comboId, { config: changed });
  };
  const response = await POST(request(body()));
  let text = "";
  try {
    text = await consume(response);
  } catch (error) {
    assert.match(String(error), /decision_stream_rejected/);
  }
  assert.ok(!text.includes("data: [DONE]"));
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  const row = readDecisionAttempts(key.id).find((item) => item.lane === "execution")!;
  assert.equal(row.state, "completed");
  assert.equal(row.http_status, 200);
  assert.ok(Number(row.application_status) >= 400);
  assert.equal(row.input_tokens, 2);
  assert.equal(row.output_tokens, 4);
  assert.equal(row.reasoning_tokens, 1);
  assert.equal(row.cost_usd, null);
  const path = "../../src/lib/decisionPolicy/geminiToolReplay.ts";
  const { restoreGeminiToolReplay } = await import(path);
  assert.throws(() =>
    restoreGeminiToolReplay({
      id: String(row.id),
      keyId: key.id,
      comboId,
      provider: "agy",
      model: BOUNDED_AGY_MODEL,
      connectionId: agyId,
      effort: "high",
    })
  );
});

test("a new user turn after a closed AGY tool cycle is rejected before selection", async () => {
  await updateCombo(comboId, { config: config(true) });
  const continuation = await begin();
  const completed = await POST(request(continuation));
  assert.equal(completed.status, 200);
  assert.match(await consume(completed), /Synthetic continuation OK/);
  assert.equal(decisions, 0);
  assert.equal(executions, 2);
  const previous = readDecisionAttempts(key.id);
  assert.equal(previous.length, 2);
  const messages = [
    ...(continuation.messages as Json[]),
    { role: "assistant", content: "Synthetic continuation OK" },
    { role: "user", content: "A new synthetic task after the completed tool cycle." },
  ];
  const response = await POST(request(body(messages)));
  await consume(response);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-omniroute-decision-reason"), "decision_no_route");
  assert.equal(decisions, 0);
  assert.equal(executions, 2);
  assert.equal(unexpected, 0);
  assert.deepEqual(
    readDecisionAttempts(key.id),
    previous,
    "closed-cycle rejection adds no receipt or change to known outcomes"
  );
});
