// Independent actual-handler adversarial fixture, derived from the isolated owner setup.
import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { before, after, beforeEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { currentApplicationAttempt } from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { createProviderConnection, updateProviderConnection } from "../../src/lib/db/providers.ts";
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
};
let capturedAttempt: ReturnType<typeof currentApplicationAttempt>;
let forceRefusal = false;
let stallToolResponse = false;
let providerCancels = 0;
let toolTurns = 1,
  noThinking = false,
  denyDecision = 0,
  denyExecution = 0;
let wireFault: ((wire: Record<string, unknown>) => void) | undefined;
let formattedWire: Record<string, unknown> | undefined;
let restoreFormatter: (() => void) | undefined;
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let selectorId: string, opusId: string, sonnetId: string, comboId: string;
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
function sourceBody() {
  const capture = originalFixture("../fixtures/decisionPolicy/hermesPinned/build_request.py", {
    case: "stream-tools",
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
function candidate(family: "opus" | "sonnet") {
  return {
    id: `${family}-high`,
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
      value: "high",
      supported: ["high"],
      evidence: "Synthetic exact pair",
    },
  };
}
function frame(type: string, fields: Record<string, unknown> = {}) {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
}
function providerResponse(model: unknown, toolTurn: boolean) {
  toolTurn = toolTurn && !forceRefusal;
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
        stop_reason: forceRefusal ? "refusal" : toolTurn ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 6, cost: 0.003 },
    }),
    frame("message_stop")
  );
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
            if (stallToolResponse && new TextDecoder().decode(chunk).includes('"type":"tool_use"'))
              return;
          }
          controller.close();
        },
        cancel() {
          providerCancels++;
        },
      },
      { highWaterMark: 0 }
    ),
    { headers: { "content-type": "text/event-stream" } }
  );
}
function request(body: Record<string, unknown>) {
  return new Request("http://synthetic.invalid/api/v1/chat/completions", {
    method: "POST",
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
      assert.deepEqual(ids.sort(), ["opus-high", "sonnet-high"]);
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
    capturedAttempt = currentApplicationAttempt();
    wires.push(sent);
    if (denyExecution)
      return Response.json(
        { error: { type: "synthetic_access_denied" } },
        { status: denyExecution }
      );
    const family = selected.startsWith("opus") ? "opus" : "sonnet";
    assert.equal(headers.get("authorization"), `Bearer ${tokens[family]}`);
    assert.equal(sent.model, `claude-${family}-5-5`);
    assert.equal(sent.output_config.effort, "high");
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
  for (const family of ["opus", "sonnet"] as const) {
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
    else sonnetId = String(row.id);
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
  wires.length = 0;
  selected = "sonnet-high";
  toolTurns = 1;
  capturedAttempt = undefined;
  forceRefusal = false;
  stallToolResponse = false;
  providerCancels = 0;
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
async function begin() {
  const body = sourceBody();
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

function assertAccountingOnce() {
  const db = getDbInstance();
  const rows = readDecisionAttempts(key.id);
  const total = db
    .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE api_key_id=?")
    .get(key.id) as { n: number };
  assert.equal(total.n, rows.length, "no detached legacy usage row may duplicate a receipt");
  for (const row of rows) {
    const usage = db
      .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE decision_attempt_id=?")
      .get(row.id) as { n: number };
    assert.equal(usage.n, 1);
    if (row.cost_usd !== null) {
      const cost = db
        .prepare("SELECT COUNT(*) AS n FROM request_cost_ledger WHERE request_id=?")
        .get(row.id) as { n: number };
      assert.equal(cost.n, 1);
    }
  }
}

async function collectFailure(response: Response) {
  const reader = response.body!.getReader();
  let text = "";
  let error: unknown;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
  } catch (caught) {
    error = caught;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text, error };
}

for (const target of ["user-text", "system-text"] as const) {
  test(`independent actual POST rejects formatter-mutated ${target} before execution`, async () => {
    wireFault = (wire) => {
      if (target === "system-text") {
        wire.system = [{ type: "text", text: "Synthetic unauthorized system mutation" }];
      } else {
        const messages = wire.messages as Array<{
          role: string;
          content: Array<Record<string, unknown>>;
        }>;
        const user = messages.find((row) => row.role === "user")!;
        user.content.push({ type: "text", text: "Synthetic unauthorized user mutation" });
      }
    };
    const response = await POST(request(sourceBody()));
    assert.ok(response.status >= 400);
    await collectFailure(response);
    assert.equal(decisions, 1);
    assert.equal(executions, 0);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
  });
}

test("independent immediate DONE cancel retains committed app success and continuation binding", async () => {
  const body = sourceBody();
  const response = await POST(request(body));
  const terminal = await throughDone(response);
  assert.equal(readToolContinuations(key.id, comboId).length, 1);
  assert.equal(executionRows()[0].application_status, 200);
  await terminal.reader.cancel("synthetic close without EOF read");
  const next = await POST(request({ ...body, messages: protocol() }));
  assert.equal(next.status, 200);
  assert.match(await consume(next), /Synthetic continuation answer/);
  assert.equal(decisions, 1);
  assert.equal(executions, 2);
  assert.equal(next.headers.get("x-omniroute-selection-mode"), "continuation-pin");
  assert.ok(executionRows().every((row) => row.application_status === 200));
  assertAccountingOnce();
});

test("independent immediate DONE continuation works before cancelling or rereading EOF", async () => {
  const body = sourceBody();
  const response = await POST(request(body));
  const terminal = await throughDone(response);
  try {
    assert.equal(readToolContinuations(key.id, comboId).length, 1);
    const next = await POST(request({ ...body, messages: protocol() }));
    assert.equal(next.status, 200);
    assert.match(await consume(next), /Synthetic continuation answer/);
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
    assert.equal(next.headers.get("x-omniroute-selection-mode"), "continuation-pin");
  } finally {
    await terminal.reader.cancel();
  }
});

test("independent metadata transaction rollback withholds DONE and preserves the physical receipt", async () => {
  const db = getDbInstance();
  db.exec(
    "CREATE TEMP TRIGGER independent_tool_issue_failure BEFORE INSERT ON decision_tool_turns BEGIN SELECT RAISE(ABORT, 'synthetic_metadata_failure'); END"
  );
  const body = sourceBody();
  try {
    const response = await POST(request(body));
    const result = await collectFailure(response);
    assert.ok(!result.text.includes("data: [DONE]"));
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    const row = executionRows()[0];
    assert.equal(row.state, "completed");
    assert.equal(row.http_status, 200);
    assert.equal(row.cost_usd, 0.003);
    assert.ok(Number(row.application_status) >= 400);
    assertAccountingOnce();
  } finally {
    db.exec("DROP TRIGGER IF EXISTS independent_tool_issue_failure");
  }
  const next = await POST(request({ ...body, messages: protocol() }));
  assert.ok(next.status >= 400);
  await collectFailure(next);
  assert.equal(executions, 1, "failed publication must not grant continuation authority");
  assert.equal(decisions, 1);
});

for (const stall of [false, true])
  test(`independent client-parser rejection ${stall ? "before raw EOF" : "after buffered raw input"} terminates without another call or handoff`, async () => {
    stallToolResponse = stall;
    const { register, getResponseTranslator } =
      await import("../../open-sse/translator/registry.ts");
    const { FORMATS } = await import("../../open-sse/translator/formats.ts");
    const original = getResponseTranslator(FORMATS.CLAUDE, FORMATS.OPENAI);
    assert.ok(original);
    let injected = 0;
    register(FORMATS.CLAUDE, FORMATS.OPENAI, undefined, (event, state) => {
      const output = original(event, state);
      if (
        !event ||
        event.type !== "content_block_start" ||
        event.content_block?.type !== "tool_use"
      )
        return output;
      injected++;
      return output?.map((chunk) => ({ ...chunk, model: "synthetic-wrong-client-model" }));
    });
    try {
      const response = await POST(request(sourceBody()));
      const result = await collectFailure(response);
      assert.ok(injected >= 1);
      assert.ok(!result.text.includes("data: [DONE]"));
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
      assert.equal(readToolContinuations(key.id, comboId).length, 0);
      assert.ok(Number(executionRows()[0].application_status) >= 400);
      if (stall) assert.ok(providerCancels >= 1);
    } finally {
      register(FORMATS.CLAUDE, FORMATS.OPENAI, undefined, original);
    }
  });

test("independent active-cycle replay cannot fall back to public tool-ID thinking cache", async () => {
  const body = await begin();
  clearClaudeThinkingStore();
  const { storeClaudeThinkingBlocks } =
    await import("../../open-sse/services/claudeThinkingStore.ts");
  assert.equal(
    storeClaudeThinkingBlocks({
      toolUseIds: ["fixture-call-one", "fixture-call-two"],
      provider: "claude",
      model: "claude-sonnet-5-5",
      blocks: [
        {
          type: "thinking",
          thinking: "synthetic foreign cache",
          signature: "synthetic foreign signature",
        },
      ],
    }),
    true
  );
  const next = await POST(request({ ...body, messages: protocol() }));
  assert.ok(next.status >= 400);
  await collectFailure(next);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
});

test("independent same IDs in consecutive groups preserve both exact signed occurrences", async () => {
  toolTurns = 2;
  const body = await begin();
  const second = await POST(request({ ...body, messages: protocol() }));
  const terminal = await throughDone(second);
  await terminal.reader.cancel();
  const firstHistory = protocol();
  const thirdHistory = [...firstHistory, ...protocol().slice(1)];
  const third = await POST(request({ ...body, messages: thirdHistory }));
  assert.equal(third.status, 200);
  assert.match(await consume(third), /Synthetic continuation answer/);
  assert.equal(decisions, 1);
  assert.equal(executions, 3);
  const wire = JSON.stringify(wires[2]);
  assert.ok(wire.includes("synthetic-account-bound-signature-1"));
  assert.ok(wire.includes("synthetic-account-bound-signature-2"));
  const groups = (
    wires[2].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
  ).filter(
    (row) => row.role === "assistant" && row.content.some((block) => block.type === "tool_use")
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((row) =>
      row.content.filter((block) => block.type === "tool_use").map((block) => block.id)
    ),
    [
      ["fixture-call-one", "fixture-call-two"],
      ["fixture-call-one", "fixture-call-two"],
    ]
  );
});

test("independent final-send account mutation cannot reuse an admitted claim", async () => {
  const body = await begin();
  wireFault = () => {
    getDbInstance().prepare("UPDATE provider_connections SET is_active=0 WHERE id=?").run(sonnetId);
  };
  try {
    const next = await POST(request({ ...body, messages: protocol() }));
    assert.ok(next.status >= 400);
    await collectFailure(next);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  } finally {
    wireFault = undefined;
    await updateProviderConnection(sonnetId, { isActive: true, testStatus: "active" });
  }
});

test("independent final-wire results cannot move before their owning assistant occurrence", async () => {
  const body = await begin();
  wireFault = (wire) => {
    const messages = wire.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    const results = messages.flatMap((message) =>
      message.content.filter((block) => block.type === "tool_result")
    );
    for (const message of messages)
      message.content = message.content.filter((block) => block.type !== "tool_result");
    messages.find((message) => message.role === "user")!.content.unshift(...results);
  };
  const next = await POST(request({ ...body, messages: protocol() }));
  await collectFailure(next);
  assert.ok(next.status >= 400, "final wire occurrence order must remain authorized");
  assert.equal(decisions, 1);
  assert.equal(executions, 1, "invalid result placement must not physically execute");
});

test("independent raw refusal cannot release a translator-fabricated completed tool group", async () => {
  forceRefusal = true;
  const { register, getResponseTranslator } = await import("../../open-sse/translator/registry.ts");
  const { FORMATS } = await import("../../open-sse/translator/formats.ts");
  const original = getResponseTranslator(FORMATS.CLAUDE, FORMATS.OPENAI);
  assert.ok(original);
  let injected = 0;
  register(FORMATS.CLAUDE, FORMATS.OPENAI, undefined, (event, state) => {
    const output = original(event, state);
    if (!event || event.type !== "message_delta" || event.delta?.stop_reason !== "refusal")
      return output;
    injected++;
    return [
      {
        id: "synthetic-fabricated-refusal-tools",
        object: "chat.completion.chunk",
        created: 1,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "fabricated-call",
                  type: "function",
                  function: { name: "synthetic_tool", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
  });
  try {
    const result = await collectFailure(await POST(request(sourceBody())));
    assert.equal(injected, 1);
    writeFileSync(
      "/tmp/native-tools-refusal-observation.json",
      JSON.stringify(
        {
          injected,
          decisions,
          executions,
          hasDone: result.text.includes("data: [DONE]"),
          hasFabricatedToolCall: result.text.includes("fabricated-call"),
          bytesBeforeFabricatedCall: Buffer.byteLength(result.text.split("fabricated-call")[0]),
          totalClientBytes: Buffer.byteLength(result.text),
          pins: readToolContinuations(key.id, comboId).length,
          receipts: executionRows().map((row) => ({
            state: row.state,
            httpStatus: row.http_status,
            applicationStatus: row.application_status,
            cost: row.cost_usd,
          })),
        },
        null,
        2
      )
    );
    assert.ok(
      !result.text.includes("data: [DONE]"),
      "raw/client disagreement must withhold completed tool output"
    );
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(executionRows()[0].cost_usd, 0.003);
    assert.ok(Number(executionRows()[0].application_status) >= 400);
  } finally {
    register(FORMATS.CLAUDE, FORMATS.OPENAI, undefined, original);
  }
});

test("independent privileged formatter serialization cannot move result occurrences", async () => {
  const body = await begin();
  let serialized = 0;
  wireFault = (wire) => {
    Object.defineProperty(wire, "toJSON", {
      configurable: true,
      enumerable: true,
      value() {
        serialized++;
        const plain = { ...wire };
        delete plain.toJSON;
        const output = JSON.parse(JSON.stringify(plain));
        const messages = output.messages as Array<{
          role: string;
          content: Array<Record<string, unknown>>;
        }>;
        const results = messages.flatMap((message) =>
          message.content.filter((block) => block.type === "tool_result")
        );
        for (const message of messages)
          message.content = message.content.filter((block) => block.type !== "tool_result");
        messages.find((message) => message.role === "user")!.content.unshift(...results);
        return output;
      },
    });
  };
  const next = await POST(request({ ...body, messages: protocol() }));
  await collectFailure(next);
  assert.ok(serialized >= 1, "privileged formatter serialization fault must execute");
  writeFileSync(
    "/tmp/native-tools-serialized-occurrence-observation.json",
    JSON.stringify(
      {
        serialized,
        decisions,
        executions,
        status: next.status,
        actualSentRolesAndBlocks: (
          wires.at(-1)?.messages as
            Array<{ role: string; content: Array<Record<string, unknown>> }> | undefined
        )?.map((row) => ({ role: row.role, types: row.content.map((block) => block.type) })),
        receipts: executionRows().map((row) => ({
          state: row.state,
          httpStatus: row.http_status,
          applicationStatus: row.application_status,
          cost: row.cost_usd,
        })),
      },
      null,
      2
    )
  );
  assert.ok(next.status >= 400, "actual final wire must retain occurrence placement");
  assert.equal(decisions, 1);
  assert.equal(executions, 1, "no physical send for reordered serialized occurrences");
});

test("independent privileged core failure cannot release a valid uncommitted tool handoff", async () => {
  const response = await POST(request(sourceBody()));
  assert.ok(capturedAttempt?.stream, "synthetic provider must capture the trusted private attempt");
  capturedAttempt.stream.noteClientOutcome(502);
  const result = await collectFailure(response);
  writeFileSync(
    "/tmp/native-tools-core-failure-observation.json",
    JSON.stringify(
      {
        decisions,
        executions,
        hasDone: result.text.includes("data: [DONE]"),
        pins: readToolContinuations(key.id, comboId).length,
        receipts: executionRows().map((row) => ({
          state: row.state,
          httpStatus: row.http_status,
          applicationStatus: row.application_status,
          cost: row.cost_usd,
        })),
      },
      null,
      2
    )
  );
  assert.ok(
    !result.text.includes("data: [DONE]"),
    "failed application must not release an unpublished completed handoff"
  );
  assert.equal(readToolContinuations(key.id, comboId).length, 0);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  assert.equal(executionRows()[0].cost_usd, 0.003);
  assert.equal(executionRows()[0].application_status, 502);
});
