import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createCombo, getComboByName, updateCombo } from "../../src/lib/db/combos.ts";
import {
  createProviderConnection,
  updateProviderConnection,
  getProviderConnectionById,
} from "../../src/lib/db/providers.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { readToolContinuations } from "../../src/lib/db/decisionContinuations.ts";
import { clearClaudeThinkingStore } from "../../open-sse/services/claudeThinkingStore.ts";
process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
const MODEL = "synthetic-hermes-pinned";
const DECISION = "https://opencode.ai/inference/systemone/v1/systemone";
const EXECUTE = "https://api.anthropic.com/v1/messages?beta=true";
const tokens = {
  selector: "synthetic-free-tools",
  opus: "synthetic-tools-opus-oauth",
  sonnet: "synthetic-tools-sonnet-oauth",
  haiku: "synthetic-tools-haiku-oauth",
};
let expectedEffort = "high";
let offeredIds = ["opus-high", "sonnet-high"];
let initialConfig: Record<string, unknown>;
let afterDecision: (() => Promise<void> | void) | undefined;
let reportedCost: number | null = 0.003;
let truncate = false,
  refuse = false;
let toolTurns = 1,
  noThinking = false,
  denyDecision = 0,
  denyExecution = 0;
let wireFault: ((wire: Record<string, unknown>) => void) | undefined;
let formattedWire: Record<string, unknown> | undefined;
let restoreFormatter: (() => void) | undefined;
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let selectorId: string, opusId: string, sonnetId: string, haikuId: string, comboId: string;
let selected = "sonnet-high",
  decisions = 0,
  executions = 0,
  unexpected = 0;
const wires: Array<Record<string, unknown>> = [];
const oldFetch = globalThis.fetch;
const encoder = new TextEncoder();
function originalFixture(file: string, input?: unknown) {
  const result = spawnSync("python3", ["-I", "-B", fileURLToPath(new URL(file, import.meta.url))], {
    env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-tools-home` },
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1000000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function sourceBody(caseName = "stream-tools") {
  const capture = originalFixture("../fixtures/decisionPolicy/hermesPinned/build_request.py", {
    case: caseName,
  });
  assert.equal(capture.sdkWireCaptured, false);
  assert.equal(capture.fullHermesExecuted, false);
  return capture.body as Record<string, unknown>;
}
function protocol() {
  const capture = originalFixture(
    "../fixtures/decisionPolicy/hermesTools/tool_protocol_fixture.py",
    { tool_name: "synthetic_tool" }
  );
  assert.equal(capture.actualToolsRun, false);
  assert.equal(capture.openAISDKWireCaptured, false);
  return capture.captures["two-results-reversed"].projectedMessages;
}
function candidate(family: "opus" | "sonnet" | "haiku", effort = "high") {
  return {
    id: `${family}-${effort}`,
    provider: "claude",
    model: `claude-${family}-5-5`,
    endpointKind: "direct",
    evidence: "Synthetic tools profile, not live capability or quality evidence",
    capabilities: {
      text: true,
      images: false,
      tools: true,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: {
      mode: "set",
      value: effort,
      supported: [effort],
      evidence: "Synthetic exact pair",
    },
  };
}
function frame(type: string, fields: Record<string, unknown> = {}) {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
}
function providerResponse(model: unknown, toolTurn: boolean) {
  const chunks = [
    frame("message_start", {
      message: {
        id: "synthetic-tool-answer",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }),
  ];
  if (toolTurn) {
    if (!noThinking)
      chunks.push(
        frame("content_block_start", {
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        frame("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "SYNTHETIC-PRIVATE-THINKING" },
        }),
        frame("content_block_delta", {
          index: 0,
          delta: {
            type: "signature_delta",
            signature: `synthetic-account-bound-signature-${executions}`,
          },
        }),
        frame("content_block_stop", { index: 0 })
      );
    for (const [index, id] of ["fixture-call-one", "fixture-call-two"].entries())
      chunks.push(
        frame("content_block_start", {
          index: index + (noThinking ? 0 : 1),
          content_block: { type: "tool_use", id, name: "synthetic_tool", input: {} },
        }),
        frame("content_block_delta", {
          index: index + (noThinking ? 0 : 1),
          delta: { type: "input_json_delta", partial_json: '{"item":"synthetic lamp"}' },
        }),
        frame("content_block_stop", { index: index + (noThinking ? 0 : 1) })
      );
  } else
    chunks.push(
      frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "Synthetic continuation answer" },
      }),
      frame("content_block_stop", { index: 0 })
    );
  chunks.push(
    frame("message_delta", {
      delta: {
        stop_reason: refuse ? "refusal" : toolTurn ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 6, ...(reportedCost === null ? {} : { cost: reportedCost }) },
    }),
    ...(truncate ? [] : [frame("message_stop")])
  );
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      },
      { highWaterMark: 0 }
    ),
    { headers: { "content-type": "text/event-stream" } }
  );
}
function request(body: Record<string, unknown>, signal?: AbortSignal) {
  return new Request("http://synthetic.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
    body: JSON.stringify(body),
  });
}
async function consume(response: Response) {
  const reader = response.body!.getReader();
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  return text;
}
before(async () => {
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init.method !== "POST" || ![DECISION, EXECUTE].includes(url)) {
      unexpected++;
      throw new Error("Closed tool fixture unexpected dispatch");
    }
    const sent = JSON.parse(String(init.body)),
      headers = new Headers(init.headers);
    if (url === DECISION) {
      decisions++;
      if (denyDecision)
        return Response.json(
          { error: { type: "synthetic_access_denied" } },
          { status: denyDecision }
        );
      assert.equal(headers.get("authorization"), `Bearer ${tokens.selector}`);
      const body = JSON.stringify(sent);
      for (const privateValue of [
        "synthetic lamp",
        "Synthetic result",
        "SYNTHETIC-PRIVATE-THINKING",
        '"item"',
      ])
        assert.ok(!body.includes(privateValue));
      const ids = Object.keys(sent.questions.route.criteria);
      assert.deepEqual(ids.sort(), [...offeredIds].sort());
      await afterDecision?.();
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: selected,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 0.8 : 0.2])),
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 7, output_tokens: 1, cost: 0 },
      });
    }
    executions++;
    wires.push(sent);
    if (denyExecution)
      return Response.json(
        { error: { type: "synthetic_access_denied" } },
        { status: denyExecution, headers: denyExecution === 429 ? { "retry-after": "17" } : {} }
      );
    const family = selected.split("-")[0] as keyof typeof tokens;
    assert.equal(headers.get("authorization"), `Bearer ${tokens[family]}`);
    assert.equal(sent.model, `claude-${family}-5-5`);
    assert.equal(sent.output_config.effort, expectedEffort);
    assert.equal(sent.max_tokens, 64);
    return providerResponse(sent.model, executions <= toolTurns);
  };
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const executor = await getExecutor("claude");
  const original = executor.transformRequest;
  executor.transformRequest = function (...args: Parameters<typeof original>) {
    const result = original.apply(executor, args);
    formattedWire = result as Record<string, unknown>;
    wireFault?.(formattedWire);
    return result;
  };
  restoreFormatter = () => {
    executor.transformRequest = original;
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
    streamDefaultMode: "json",
    globalFallbackModel: "openai/gpt-5.4",
  });
  selectorId = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-tools-free",
        apiKey: tokens.selector,
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  for (const family of ["opus", "sonnet", "haiku"] as const) {
    const row = await createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name: `synthetic-tools-${family}`,
      accessToken: tokens[family],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    if (family === "opus") opusId = String(row.id);
    else if (family === "sonnet") sonnetId = String(row.id);
    else haikuId = String(row.id);
  }
  comboId = String(
    (
      await createCombo({
        name: MODEL,
        models: ["claude/claude-opus-5-5"],
        strategy: "priority",
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
            connections: { "opus-high": opusId, "sonnet-high": sonnetId },
            policy: {
              version: 1,
              candidates: [candidate("opus"), candidate("sonnet")],
              taskOrder: {
                tools: ["opus-high", "sonnet-high"],
                continuation: ["opus-high", "sonnet-high"],
              },
              unknownQuota: "allow",
              decisionFailure: "stop",
              maxDecisionAttempts: 1,
              maxExecutionAttempts: 1,
              timeoutMs: 5000,
            },
          },
        },
      })
    ).id
  );
});
beforeEach(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  key = await createApiKey("synthetic-tools-client-" + randomUUID(), "synthetic");
  decisions = 0;
  executions = 0;
  afterDecision = undefined;
  wires.length = 0;
  selected = "sonnet-high";
  expectedEffort = "high";
  offeredIds = ["opus-high", "sonnet-high"];
  initialConfig ??= structuredClone((await getComboByName(MODEL))!.config) as Record<
    string,
    unknown
  >;
  for (const family of ["opus", "sonnet", "haiku"] as const) {
    const row = await createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name: `synthetic-isolated-${family}-${randomUUID()}`,
      accessToken: tokens[family],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    if (family === "opus") opusId = String(row.id);
    else if (family === "sonnet") sonnetId = String(row.id);
    else haikuId = String(row.id);
  }
  (initialConfig.decisionPolicy as { connections: Record<string, string> }).connections = {
    "opus-high": opusId,
    "sonnet-high": sonnetId,
  };
  await updateCombo(comboId, { config: structuredClone(initialConfig) });
  reportedCost = 0.003;
  truncate = false;
  refuse = false;
  toolTurns = 1;
  noThinking = false;
  denyDecision = 0;
  denyExecution = 0;
  wireFault = undefined;
  clearClaudeThinkingStore();
});
after(async () => {
  restoreFormatter?.();
  globalThis.fetch = oldFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(unexpected, 0);
});
test("original Hermes tool kwargs and supplied result construction continue through actual POST without reselection", async () => {
  const body = sourceBody();
  const initial = await POST(request(body));
  const summary = formattedWire
    ? {
        keys: Object.keys(formattedWire),
        tools: formattedWire.tools,
        choice: formattedWire.tool_choice,
        messages: (formattedWire.messages as Array<Record<string, unknown>> | undefined)?.map(
          (message) => ({
            role: message.role,
            keys: Object.keys(message),
            blocks: Array.isArray(message.content)
              ? message.content.map((block) => ({
                  type: block.type,
                  keys: Object.keys(block),
                  textLength: typeof block.text === "string" ? block.text.length : null,
                }))
              : typeof message.content,
          })
        ),
      }
    : null;
  assert.equal(
    initial.status,
    200,
    JSON.stringify({
      reason: initial.headers.get("x-omniroute-decision-reason"),
      decisions,
      executions,
      summary,
    })
  );
  const { text: toolResponse, reader } = await throughDone(initial);
  assert.match(toolResponse, /fixture-call-one/);
  assert.match(toolResponse, /fixture-call-two/);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  const continued = await POST(request({ ...body, messages: protocol() }));
  assert.equal(
    continued.status,
    200,
    JSON.stringify({
      reason: continued.headers.get("x-omniroute-decision-reason"),
      messages: (formattedWire?.messages as Array<Record<string, unknown>>)?.map((m) => ({
        role: m.role,
        blocks: Array.isArray(m.content)
          ? m.content.map((b) => ({
              type: b.type,
              keys: Object.keys(b),
              id: b.id,
              resultId: b.tool_use_id,
              input: b.input,
              signatureMatch: b.signature === "synthetic-account-bound-signature",
              content: b.type === "tool_result" ? b.content : undefined,
            }))
          : typeof m.content,
      })),
    })
  );
  assert.match(await consume(continued), /Synthetic continuation answer/);
  assert.equal(decisions, 1);
  assert.equal(executions, 2);
  await reader.cancel();
  assert.equal(continued.headers.get("x-omniroute-selection-mode"), "continuation-pin");
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.lane === "execution").length, 2);
  for (const row of rows.filter((row) => row.lane === "execution")) {
    assert.equal(row.model, "claude-sonnet-5-5");
    assert.equal(row.connection_id, sonnetId);
    assert.equal(row.effort, "high");
    assert.equal(row.application_status, 200);
  }
  const signature = JSON.stringify(wires[1]);
  assert.ok(signature.includes("synthetic-account-bound-signature-1"));
});

test("durable sessions keep exact tool origin and reject task-boundary reselection", async () => {
  const config = structuredClone(initialConfig) as { decisionPolicy: Record<string, unknown> };
  config.decisionPolicy.sessions = {
    mode: "task-boundary",
    idleTtlMs: 60000,
    maxTurns: 20,
    minStableTurns: 2,
    maxActiveSessions: 4,
  };
  await updateCombo(comboId, { config });
  const body = sourceBody(),
    initialRequest = request(body);
  initialRequest.headers.set("x-omniroute-routing-session", "new");
  const initial = await POST(initialRequest);
  assert.equal(initial.status, 200);
  assert.match(await consume(initial), /fixture-call-one/);
  const session = initial.headers.get("x-omniroute-routing-session")!;
  assert.match(session, /^[a-f0-9-]{36}$/);
  const continuedBody = { ...body, messages: protocol() };
  const invalid = request(continuedBody);
  invalid.headers.set("x-omniroute-routing-session", session);
  invalid.headers.set("x-omniroute-task-boundary", "new-task");
  const denied = await POST(invalid);
  await denied.text();
  assert.equal(denied.status, 409);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  const next = request(continuedBody);
  next.headers.set("x-omniroute-routing-session", session);
  const completed = await POST(next);
  assert.equal(completed.status, 200);
  assert.match(await consume(completed), /Synthetic continuation answer/);
  assert.equal(completed.headers.get("x-omniroute-selection-mode"), "session-pin");
  assert.equal(decisions, 1);
  assert.equal(executions, 2);
  for (const row of readDecisionAttempts(key.id).filter((row) => row.lane === "execution")) {
    assert.equal(row.connection_id, sonnetId);
    assert.equal(row.effort, "high");
    assert.equal(row.application_status, 200);
  }
});
async function rejectedToolStream(response: Response) {
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let text = "",
    rejected = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    rejected = true;
    assert.match(String(error), /decision_stream_rejected/);
  }
  assert.equal(rejected, true, "The failed tool stream must expose failure");
  assert.ok(
    !text.includes("data: [DONE]"),
    "No successful completion may escape the failed handoff"
  );
  return text;
}
async function throughDone(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("data: [DONE]")) {
    const result = await reader.read();
    assert.equal(result.done, false, "A tool response must publish its completion terminal");
    text += decoder.decode(result.value, { stream: true });
  }
  return { text, reader };
}
async function begin(body = sourceBody()) {
  const response = await POST(request(body));
  assert.equal(response.status, 200);
  const result = await throughDone(response);
  assert.equal(readToolContinuations(key.id, comboId).length, 1);
  await result.reader.cancel();
  return body;
}
function executionRows() {
  return readDecisionAttempts(key.id).filter((row) => row.lane === "execution");
}
for (const status of [401, 403, 429])
  test(`tool native selector ${status} stops before execution`, async () => {
    denyDecision = status;
    const response = await POST(request(sourceBody()));
    assert.ok(response.status >= 400);
    assert.equal(decisions, 1);
    assert.equal(executions, 0);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
  });
for (const change of [
  "missing-result",
  "extra-result",
  "forged-id",
  "schema",
  "prefix",
  "cross-key",
])
  test(`continuation rejects ${change} without a second physical call`, async () => {
    const body = await begin();
    const messages = protocol();
    if (change === "missing-result") messages.pop();
    if (change === "extra-result") messages.push(structuredClone(messages.at(-1)));
    if (change === "forged-id") messages.at(-1).tool_call_id = "forged_id";
    if (change === "prefix") messages[0].content = "A different synthetic task";
    if (change === "schema")
      (
        body.tools as Array<{ function: { parameters: Record<string, unknown> } }>
      )[0].function.parameters.description = "Changed schema";
    if (change === "cross-key")
      key = await createApiKey("synthetic-other-tools-" + randomUUID(), "synthetic");
    const response = await POST(request({ ...body, messages }));
    assert.ok(response.status >= 400);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  });
test("missing signed replay memory fails closed instead of consulting the ordinary tool-ID cache", async () => {
  const body = await begin();
  clearClaudeThinkingStore();
  const response = await POST(request({ ...body, messages: protocol() }));
  assert.ok(response.status >= 400);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
});
test("a changed originating account rejects continuation before execution", async () => {
  const body = await begin();
  await updateProviderConnection(sonnetId, { isActive: false });
  try {
    const response = await POST(request({ ...body, messages: protocol() }));
    assert.ok(response.status >= 400);
    assert.equal(executions, 1);
    assert.equal(decisions, 1);
  } finally {
    await updateProviderConnection(sonnetId, { isActive: true });
  }
});
for (const choice of ["required", { type: "function", function: { name: "synthetic_tool" } }])
  test(`unsupported forced tool control is rejected before decision`, async () => {
    const response = await POST(request({ ...sourceBody(), tool_choice: choice }));
    assert.ok(response.status >= 400);
    assert.equal(decisions, 0);
    assert.equal(executions, 0);
  });
test("tool metadata write failure rolls back application success and withholds completion authority", async () => {
  const db = getDbInstance();
  db.exec(
    "CREATE TRIGGER synthetic_tool_issue_failure BEFORE INSERT ON decision_tool_turns BEGIN SELECT RAISE(ABORT, 'synthetic metadata failure'); END"
  );
  try {
    const response = await POST(request(sourceBody()));
    assert.equal(response.status, 200);
    await rejectedToolStream(response);
    assert.equal(executions, 1);
    assert.equal(decisions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    const row = executionRows()[0];
    assert.equal(row.state, "completed");
    assert.ok(Number(row.application_status) >= 400);
    assert.equal(row.cost_usd, 0.003);
  } finally {
    db.exec("DROP TRIGGER synthetic_tool_issue_failure");
  }
});
test("a complete tool response without signed thinking is unsupported and issues no authority", async () => {
  noThinking = true;
  const response = await POST(request(sourceBody()));
  assert.equal(response.status, 200);
  await rejectedToolStream(response);
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  assert.equal(executions, 1);
  assert.equal(executionRows()[0].cost_usd, 0.003);
});
test("formatter-mutated user text is rejected before physical execution", async () => {
  wireFault = (wire) => {
    const row = (wire.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0];
    row.content.find((b) => b.type === "text")!.text = "Injected synthetic text";
  };
  const response = await POST(request(sourceBody()));
  assert.ok(response.status >= 400);
  assert.equal(decisions, 1);
  assert.equal(executions, 0);
});
test("a consumed continuation cannot be replayed", async () => {
  const body = await begin();
  const continuation = { ...body, messages: protocol() };
  const first = await POST(request(continuation));
  assert.equal(first.status, 200);
  await consume(first);
  const second = await POST(request(continuation));
  assert.ok(second.status >= 400);
  assert.equal(executions, 2);
  assert.equal(decisions, 1);
});
test("reused IDs in a second complete group retain separate occurrence-bound signed blocks", async () => {
  toolTurns = 2;
  const body = await begin();
  const firstHistory = protocol();
  const response = await POST(request({ ...body, messages: firstHistory }));
  assert.equal(response.status, 200);
  const second = await throughDone(response);
  const fullHistory = [...firstHistory, ...protocol().slice(1)];
  const last = await POST(request({ ...body, messages: fullHistory }));
  assert.equal(
    last.status,
    200,
    JSON.stringify({
      reason: last.headers.get("x-omniroute-decision-reason"),
      messages: (formattedWire?.messages as Array<Record<string, unknown>>)?.map((m) => ({
        role: m.role,
        blocks: Array.isArray(m.content)
          ? m.content.map((b) => ({
              type: b.type,
              id: b.id,
              resultId: b.tool_use_id,
              firstSignature: b.signature === "synthetic-account-bound-signature-1",
              secondSignature: b.signature === "synthetic-account-bound-signature-2",
            }))
          : [],
      })),
    })
  );
  await consume(last);
  await second.reader.cancel();
  assert.equal(executions, 3);
  assert.equal(decisions, 1);
  const assistant = (
    wires[2].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
  ).filter((m) => m.role === "assistant");
  assert.equal(assistant[0].content[0].signature, "synthetic-account-bound-signature-1");
  assert.equal(assistant[1].content[0].signature, "synthetic-account-bound-signature-2");
  assert.equal(executionRows().length, 3);
});

for (const family of ["opus", "sonnet", "haiku"] as const)
  for (const effort of ["medium", "high", "xhigh", "max"])
    for (const native of [false, true]) {
      test(`synthetic ${native ? "native-output " : ""}adjusted Hermes tools continue with exact ${family} ${effort}`, async () => {
        expectedEffort = effort;
        selected = `${family}-${effort}`;
        const other = family === "opus" ? "sonnet" : "opus";
        const config = structuredClone(initialConfig) as {
          decisionPolicy: Record<string, unknown>;
        };
        const policy = config.decisionPolicy.policy as Record<string, unknown>;
        policy.candidates = [candidate(other, effort), candidate(family, effort)];
        offeredIds = [`${other}-${effort}`, selected];
        policy.taskOrder = { tools: offeredIds, continuation: offeredIds };
        config.decisionPolicy.connections = {
          [`${other}-${effort}`]: other === "opus" ? opusId : sonnetId,
          [selected]: family === "opus" ? opusId : family === "sonnet" ? sonnetId : haikuId,
        };
        if (native) {
          config.decisionPolicy.applicationMode = "provider-native-output-v1";
          config.decisionPolicy.nativeOutput = {
            acknowledgeNoTokenCeiling: true,
            contextOutputTokens: 64,
          };
        }
        await updateCombo(comboId, { config });
        // Explicit synthetic effort/model-pool substitution, not captured Hermes defaults.
        const body = {
          ...sourceBody(native ? "omitted-cap-tools" : "stream-tools"),
          reasoning_effort: effort,
        };
        const initial = await POST(request(body));
        assert.equal(initial.status, 200);
        const first = await throughDone(initial);
        const continued = await POST(request({ ...body, messages: protocol() }));
        assert.equal(
          continued.status,
          200,
          continued.headers.get("x-omniroute-decision-reason") ?? ""
        );
        await consume(continued);
        await first.reader.cancel();
        assert.equal(decisions, 1);
        assert.equal(executions, 2);
        for (const row of executionRows()) {
          assert.equal(row.model, `claude-${family}-5-5`);
          assert.equal(row.effort, effort);
          assert.equal(row.application_status, 200);
        }
      });
    }

async function configureNativeTools(patch: Record<string, unknown> = {}) {
  const config = structuredClone(initialConfig) as { decisionPolicy: Record<string, unknown> };
  Object.assign(
    config.decisionPolicy,
    {
      applicationMode: "provider-native-output-v1",
      nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64 },
    },
    patch
  );
  await updateCombo(comboId, { config });
}
for (const change of ["mode", "planning", "tool-schema", "account", "missing-replay"]) {
  test(`native-output tool continuation rejects changed ${change} before another stage`, async () => {
    await configureNativeTools();
    const body = await begin(sourceBody("omitted-cap-tools"));
    if (change === "mode")
      await configureNativeTools({ applicationMode: "bounded-v1", nativeOutput: undefined });
    if (change === "planning")
      await configureNativeTools({
        nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 128 },
      });
    if (change === "tool-schema")
      (
        body.tools as Array<{ function: { parameters: Record<string, unknown> } }>
      )[0].function.parameters.description = "Changed native schema";
    if (change === "account") await updateProviderConnection(sonnetId, { isActive: false });
    if (change === "missing-replay") clearClaudeThinkingStore();
    const response = await POST(request({ ...body, messages: protocol() }));
    assert.equal(response.status, 409);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId)[0].state, "issued");
    if (change === "mode" || change === "planning") {
      await configureNativeTools();
      const resumed = await POST(request({ ...body, messages: protocol() }));
      // Saving even identical values changes the authority revision. Reverting
      // a policy must not resurrect a pin admitted under an earlier revision.
      assert.equal(resumed.status, 409);
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
    }
  });
}
for (const field of ["max_tokens", "max_completion_tokens"]) {
  test(`native-output continuation preserves pin after recovery-added ${field} rejection`, async () => {
    await configureNativeTools();
    const body = await begin(sourceBody("omitted-cap-tools"));
    const rejected = await POST(request({ ...body, [field]: 64, messages: protocol() }));
    assert.equal(rejected.status, 409);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId)[0].state, "issued");
    const permitted = await POST(request({ ...body, messages: protocol() }));
    assert.equal(permitted.status, 200);
    await consume(permitted);
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
  });
}
for (const status of [401, 403, 429]) {
  test(`native-output tool selector HTTP${status} never executes or falls back`, async () => {
    await configureNativeTools();
    denyDecision = status;
    const response = await POST(request(sourceBody("omitted-cap-tools")));
    assert.ok(response.status >= 400);
    assert.equal(decisions, 1);
    assert.equal(executions, 0);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
  });
}
test("native-output tool unoffered choice cannot trigger execution", async () => {
  await configureNativeTools();
  selected = "unoffered-native-choice";
  const response = await POST(request(sourceBody("omitted-cap-tools")));
  assert.ok(response.status >= 400);
  assert.equal(decisions, 1);
  assert.equal(executions, 0);
});
for (const change of ["cancel", "policy", "connection"]) {
  test(`native-output tool queued ${change} stops before execution`, async () => {
    await configureNativeTools();
    const abort = new AbortController();
    afterDecision = async () => {
      if (change === "cancel") abort.abort();
      else if (change === "connection")
        await updateProviderConnection(sonnetId, { isActive: false });
      else
        await configureNativeTools({
          nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 128 },
        });
    };
    const response = await POST(request(sourceBody("omitted-cap-tools"), abort.signal));
    assert.ok(response.status >= 400);
    assert.equal(decisions, 1);
    assert.equal(executions, 0);
  });
}
for (const order of [undefined, [], ["opus-high"]])
  test(`continuation preference ${order === undefined ? "missing" : order.length ? "excludes pin" : "empty"} cannot resurrect the pinned candidate`, async () => {
    const config = structuredClone(initialConfig) as {
      decisionPolicy: { policy: { taskOrder: Record<string, string[]> } };
    };
    if (order === undefined) delete config.decisionPolicy.policy.taskOrder.continuation;
    else config.decisionPolicy.policy.taskOrder.continuation = order;
    await updateCombo(comboId, { config });
    const body = await begin();
    const response = await POST(request({ ...body, messages: protocol() }));
    assert.equal(response.status, 409);
    assert.equal(executions, 1);
    assert.equal(decisions, 1);
  });

for (const status of [401, 403, 429])
  test(`execution access denial ${status} never retries or issues a tool pin`, async () => {
    denyExecution = status;
    const prior = await getProviderConnectionById(sonnetId);
    const response = await POST(request(sourceBody()));
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    if (status === 429) assert.equal(response.headers.get("retry-after"), "17");
    const body = await response.json();
    assert.equal(
      body.error.code,
      (
        { 401: "invalid_api_key", 403: "permission_denied", 429: "rate_limit_exceeded" } as Record<
          number,
          string
        >
      )[status]
    );
    const after = await getProviderConnectionById(sonnetId);
    for (const field of [
      "accessToken",
      "refreshToken",
      "isActive",
      "testStatus",
      "lastError",
    ] as const)
      assert.deepEqual(after?.[field], prior?.[field]);
    // Existing BaseExecutor health bookkeeping may record a warning/cooldown.
    // It is not a credential refresh or a key-validity/account-entitlement conclusion.
    if (status === 401 || status === 429) assert.ok(after?.providerSpecificData?.apiKeyHealth);
    assert.equal(response.headers.get("x-omniroute-routing-cost-status"), "unknown");
    const logical = JSON.parse(response.headers.get("x-omniroute-routing-cost")!);
    assert.equal(logical.totalUsd, null);
    assert.equal(logical.unknownStages, 1);
    const receipt = executionRows()[0];
    assert.equal(receipt.http_status, status);
    assert.equal(receipt.cost_usd, null);
    assert.equal(receipt.input_tokens, null);
    assert.equal(receipt.output_tokens, null);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    assert.ok(
      Number(executionRows()[0].application_status) >= 400,
      JSON.stringify({
        http: executionRows()[0].http_status,
        app: executionRows()[0].application_status,
        state: executionRows()[0].state,
        response: response.status,
      })
    );
  });
for (const value of [null, 0])
  test(`complete tool usage preserves reported cost ${value === null ? "unknown" : "zero"}`, async () => {
    reportedCost = value;
    await begin();
    const row = executionRows()[0];
    assert.equal(row.cost_usd, value);
    assert.equal(row.input_tokens, 8);
    assert.equal(row.output_tokens, 6);
  });
test("a truncated tool stream cannot mint authority or pretend final output/cost is known", async () => {
  truncate = true;
  const response = await POST(request(sourceBody()));
  assert.equal(response.status, 200);
  await rejectedToolStream(response);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  const row = executionRows()[0];
  assert.equal(row.cost_usd, null);
  assert.equal(row.output_tokens, null);
  assert.equal(row.input_tokens, 8);
  assert.ok(Number(row.application_status) >= 400);
});
test("no-call provider refusal retains a refused application outcome without a pin", async () => {
  toolTurns = 0;
  refuse = true;
  const response = await POST(request(sourceBody()));
  assert.equal(response.status, 200);
  await consume(response);
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  assert.equal(executionRows()[0].application_status, 422);
  assert.equal(executions, 1);
});
test("pre-aborted tool request causes no decision or execution", async () => {
  const abort = new AbortController();
  abort.abort();
  const response = await POST(request(sourceBody(), abort.signal));
  assert.ok(response.status >= 400);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
});
test("outside-context client cancellation before completion publishes no authority", async () => {
  const response = await POST(request(sourceBody()));
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  assert.equal(executionRows()[0].application_status, 499);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
});
test("explicit none admits a complete text answer but publishes no tool authority", async () => {
  toolTurns = 0;
  const response = await POST(
    request({ ...sourceBody(), tool_choice: "none", parallel_tool_calls: false })
  );
  assert.equal(response.status, 200);
  await consume(response);
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  assert.equal(executions, 1);
});
test("parallel false refuses a provider multi-call group rather than weakening the client control", async () => {
  const response = await POST(
    request({ ...sourceBody(), tool_choice: "auto", parallel_tool_calls: false })
  );
  assert.equal(response.status, 200);
  await rejectedToolStream(response);
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  assert.equal(executions, 1);
});

test("a new user turn strips historical signed replay and permits a fresh allowed model selection", async () => {
  const body = await begin();
  selected = "opus-high";
  const response = await POST(
    request({
      ...body,
      messages: [...protocol(), { role: "user", content: "Explain another synthetic task." }],
    })
  );
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? "");
  await consume(response);
  assert.equal(decisions, 2);
  assert.equal(executions, 2);
  assert.equal(wires[1].model, "claude-opus-5-5");
  assert.ok(!JSON.stringify(wires[1]).includes("synthetic-account-bound-signature-1"));
});
