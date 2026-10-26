import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { createCombo, updateCombo } from "../../src/lib/db/combos.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { readToolContinuations } from "../../src/lib/db/decisionContinuations.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { clearClaudeThinkingStore } from "../../open-sse/services/claudeThinkingStore.ts";
import {
  BOUNDED_AGY_MODEL,
  BOUNDED_AGY_STREAM_URL,
} from "../../open-sse/executors/antigravity/bounded.ts";

const PYTHON = process.env.OMNIROUTE_HERMES_SDK_PYTHON;
const AVAILABLE = !!PYTHON;
const MODEL = "synthetic-hermes-pinned";
const SELECTOR = "https://opencode.ai/inference/systemone/v1/systemone";
const EXECUTOR = "https://api.anthropic.com/v1/messages?beta=true";
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let comboId: string, selectorId: string, sonnetId: string, opusId: string, agyId: string;
let delegated = false;
let agy = false,
  agyParallel = false,
  agyRefuse = false;
let effort = "high",
  decisions = 0,
  executions = 0;
let unexpected = 0;
let denial = 0,
  missingCost = false,
  zeroCost = false,
  missingReplay = false;
const wires: Array<Record<string, unknown>> = [];
function source(caseName: string) {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesPinned/build_request.py", import.meta.url)
      ),
    ],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-sdk-builder-home` },
      input: JSON.stringify({ case: caseName }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 200000,
    }
  );
  assert.equal(result.status, 0, "Pinned original source builder must complete");
  const capture = JSON.parse(result.stdout);
  assert.equal(capture.sdkWireCaptured, false);
  assert.equal(capture.fullHermesExecuted, false);
  return capture;
}
function candidate(family: string, value: string) {
  return {
    id: `${family}-${value}`,
    provider: "claude",
    model: `claude-${family}-5-5`,
    endpointKind: "direct",
    evidence: "Synthetic installed-SDK contract fixture, not live capability/quality evidence",
    capabilities: {
      text: true,
      images: false,
      tools: true,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: { mode: "set", value, supported: [value], evidence: "Synthetic explicit pair" },
  };
}
function config() {
  const ids = ["opus-medium", "sonnet-medium", "opus-high", "sonnet-high"];
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
      connections: Object.fromEntries(
        ids.map((id) => [id, id.startsWith("opus") ? opusId : sonnetId])
      ),
      policy: {
        version: 1,
        candidates: [
          candidate("opus", "medium"),
          candidate("sonnet", "medium"),
          candidate("opus", "high"),
          candidate("sonnet", "high"),
        ],
        taskOrder: { explanation: ids, reasoning: ids, tools: ids, continuation: ids },
        unknownQuota: "allow",
        decisionFailure: "stop",
        maxDecisionAttempts: 1,
        maxExecutionAttempts: 1,
        timeoutMs: 5000,
      },
    },
  };
}
async function configureAgy(parallel: boolean) {
  agy = true;
  agyParallel = parallel;
  const value = config();
  value.decisionPolicy.connections = { "agy-high": agyId, "sonnet-high": sonnetId };
  value.decisionPolicy.policy.candidates = [
    { ...candidate("sonnet", "high"), id: "agy-high", provider: "agy", model: BOUNDED_AGY_MODEL },
    candidate("sonnet", "high"),
  ];
  const ids = ["agy-high", "sonnet-high"];
  value.decisionPolicy.policy.taskOrder = {
    explanation: ids,
    reasoning: ids,
    tools: ids,
    continuation: ids,
  };
  await updateCombo(comboId, { config: value });
}
function agyParts(): Array<Record<string, unknown>> {
  return [
    {
      functionCall: {
        id: "fixture-call-one",
        name: "synthetic_tool",
        args: { item: "synthetic lamp" },
      },
      thoughtSignature: "synthetic-sdk-agy-opaque-signature",
    },
    ...(agyParallel
      ? [
          {
            functionCall: {
              id: "fixture-call-two",
              name: "synthetic_tool",
              args: { item: "synthetic switch" },
            },
          },
        ]
      : []),
  ];
}
function agyResponse() {
  const parts = agyRefuse
    ? [{ text: "Synthetic safety refusal" }]
    : executions === 1
      ? agyParts()
      : [{ text: "Synthetic SDK OK" }];
  return new Response(
    `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts }, finishReason: agyRefuse ? "SAFETY" : "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 6 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  );
}
function event(type: string, data: Record<string, unknown> = {}) {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}
function upstream(model: string, stream: boolean, tools: boolean) {
  const usage = {
    input_tokens: 8,
    output_tokens: 6,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...(missingCost ? {} : { cost: zeroCost ? 0 : 0.003 }),
  };
  if (!stream)
    return Response.json({
      id: "synthetic-sdk-json",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Synthetic SDK OK" }],
      stop_reason: "end_turn",
      usage,
    });
  const chunks = [
    event("message_start", {
      message: {
        id: "synthetic-sdk-stream",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { ...usage, output_tokens: 0 },
      },
    }),
  ];
  if (tools) {
    chunks.push(
      event("content_block_start", {
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "Synthetic signed reasoning" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "signature_delta", signature: "synthetic-sdk-account-signature" },
      }),
      event("content_block_stop", { index: 0 })
    );
    for (const [offset, id] of ["fixture-call-one", "fixture-call-two"].entries())
      chunks.push(
        event("content_block_start", {
          index: offset + 1,
          content_block: { type: "tool_use", id, name: "synthetic_tool", input: {} },
        }),
        event("content_block_delta", {
          index: offset + 1,
          delta: { type: "input_json_delta", partial_json: '{"item":"synthetic lamp"}' },
        }),
        event("content_block_stop", { index: offset + 1 })
      );
  } else
    chunks.push(
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "Synthetic SDK OK" },
      }),
      event("content_block_stop", { index: 0 })
    );
  chunks.push(
    event("message_delta", {
      delta: { stop_reason: tools ? "tool_use" : "end_turn", stop_sequence: null },
      usage,
    }),
    event("message_stop")
  );
  return new Response(
    new ReadableStream(
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
before(async () => {
  if (!AVAILABLE) return;
  assert.equal(existsSync(PYTHON!), true, "The explicitly configured SDK executable must exist");
  process.env.REQUIRE_API_KEY = "true";
  process.env.APP_LOG_TO_FILE = "false";
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      init.method !== "POST" ||
      ![SELECTOR, EXECUTOR, ...(agy ? [BOUNDED_AGY_STREAM_URL] : [])].includes(url)
    ) {
      unexpected++;
      throw new Error("Closed SDK provider fixture rejected route");
    }
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    if (url === SELECTOR) {
      decisions++;
      assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-selector");
      const ids = Object.keys(body.questions.route.criteria);
      assert.deepEqual(
        ids.sort(),
        (agy
          ? ["agy-high", "sonnet-high"]
          : delegated
            ? ["opus-medium", "sonnet-medium", "opus-high", "sonnet-high"]
            : [`opus-${effort}`, `sonnet-${effort}`]
        ).sort()
      );
      const text = JSON.stringify(body);
      assert.ok(!text.includes("synthetic lamp"));
      assert.ok(!text.includes('"item"'));
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: agy ? "agy-high" : `sonnet-${effort}`,
            probabilities: Object.fromEntries(
              ids.map((id) => [
                id,
                id === (agy ? "agy-high" : `sonnet-${effort}`) ? 0.8 : (1 - 0.8) / (ids.length - 1),
              ])
            ),
            confidence: (0.8 - 1 / ids.length) / (1 - 1 / ids.length),
          },
        },
        usage: { input_tokens: 7, output_tokens: 1, cost: 0 },
      });
    }
    executions++;
    wires.push(body);
    if (url === BOUNDED_AGY_STREAM_URL) {
      assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-agy-oauth");
      assert.equal(headers.get("user-agent"), "OmniRoute-Antigravity/1.0");
      assert.equal(body.model, BOUNDED_AGY_MODEL);
      assert.equal(body.project, "synthetic-sdk-agy-project");
      assert.equal(body.request.generationConfig.maxOutputTokens, 64);
      assert.equal(body.request.generationConfig.thinkingConfig.thinkingLevel, "high");
      const declaration = body.request.tools[0].functionDeclarations[0];
      assert.equal(declaration.name, "synthetic_tool");
      assert.deepEqual(declaration.parametersJsonSchema, { type: "object", properties: {} });
      assert.equal(Object.hasOwn(declaration.parametersJsonSchema, "additionalProperties"), false);
      return agyResponse();
    }
    assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-sonnet-oauth");
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.output_config.effort, effort);
    assert.equal(body.max_tokens, 64);
    if (denial)
      return Response.json(
        { error: { message: "Synthetic terminal denial" } },
        { status: denial, headers: denial === 429 ? { "retry-after": "17" } : {} }
      );
    return upstream(body.model, body.stream, Array.isArray(body.tools) && executions === 1);
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
  });
  selectorId = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-sdk-free-selector",
        apiKey: "synthetic-sdk-selector",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  agyId = String(
    (
      await createProviderConnection({
        provider: "agy",
        authType: "oauth",
        name: "synthetic-sdk-agy",
        accessToken: "synthetic-sdk-agy-oauth",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: { projectId: "synthetic-sdk-agy-project" },
      })
    ).id
  );
  comboId = String(
    (
      await createCombo({
        name: MODEL,
        models: ["claude/claude-opus-5-5"],
        strategy: "priority",
        config: {},
      })
    ).id
  );
});
beforeEach(async () => {
  if (!AVAILABLE) return;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  key = await createApiKey("synthetic-sdk-client-" + randomUUID(), "synthetic");
  for (const family of ["opus", "sonnet"]) {
    const row = await createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name: `synthetic-sdk-${family}-${randomUUID()}`,
      accessToken: `synthetic-sdk-${family}-oauth`,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    if (family === "opus") opusId = String(row.id);
    else sonnetId = String(row.id);
  }
  await updateCombo(comboId, { config: config() });
  agy = false;
  agyParallel = false;
  agyRefuse = false;
  effort = "high";
  delegated = false;
  decisions = 0;
  executions = 0;
  denial = 0;
  missingCost = false;
  zeroCost = false;
  missingReplay = false;
  wires.length = 0;
  clearClaudeThinkingStore();
});
after(async () => {
  if (!AVAILABLE) return;
  globalThis.fetch = originalFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(unexpected, 0);
});
type Message = {
  kind: string;
  id?: number;
  body?: string;
  headers?: Record<string, string>;
  data?: string;
  method?: string;
  url?: string;
  [key: string]: unknown;
};
async function sdk(capture: ReturnType<typeof source>, mode: string) {
  const child = spawn(
    PYTHON!,
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesSDK/sdk_stdio_client.py", import.meta.url)
      ),
    ],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-sdk-home` },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const readers = new Map<number, ReadableStreamDefaultReader<Uint8Array>>();
  const requests: Record<string, unknown>[] = [];
  const observations: Record<string, unknown>[] = [];
  let result: Message | undefined,
    failure: unknown,
    stderrBytes = 0;
  const send = (row: unknown) => child.stdin.write(JSON.stringify(row) + "\n");
  let stdoutBuffer = Buffer.alloc(0);
  let pending = Promise.resolve();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) child.kill();
  });
  const timer = setTimeout(() => child.kill(), 30000);
  const handleLine = (line: string) => {
    pending = pending
      .then(async () => {
        assert.ok(line.length <= 1500000);
        const row = JSON.parse(line) as Message;
        if (row.kind === "result") {
          result = row;
          return;
        }
        const id = Number(row.id);
        assert.ok(id >= 1 && id <= 2);
        if (row.kind === "request") {
          assert.equal(row.method, "POST");
          assert.equal(row.url, "https://hermes.fixture.invalid/v1/chat/completions");
          assert.ok(Object.keys(row.headers ?? {}).length <= 32);
          assert.equal(row.headers?.authorization, `Bearer ${key.key}`);
          assert.match(row.headers?.["user-agent"] ?? "", /^OpenAI\/Python 2\.54\.0/);
          const bytes = Buffer.from(row.body!, "base64");
          assert.ok(bytes.length <= 262144);
          const body = JSON.parse(bytes.toString());
          requests.push(body);
          assert.equal(body.model, MODEL);
          assert.ok(!Object.hasOwn(body, "timeout"));
          if (missingReplay && id === 2) clearClaudeThinkingStore();
          const response = await POST(
            new Request("https://hermes.fixture.invalid/api/v1/chat/completions", {
              method: "POST",
              headers: row.headers,
              body: bytes,
            })
          );
          observations.push({
            status: response.status,
            reason: response.headers.get("x-omniroute-decision-reason"),
            keys: Object.keys(body),
            tools: body.tools,
            reasoning: body.reasoning_effort,
          });
          readers.set(id, response.body!.getReader());
          send({
            kind: "headers",
            id,
            status: response.status,
            headers: Object.fromEntries(response.headers),
          });
          return;
        }
        const reader = readers.get(id);
        assert.ok(reader);
        if (row.kind === "close") {
          await reader.cancel().catch(() => {});
          send({ kind: "closed", id });
          return;
        }
        assert.equal(row.kind, "pull");
        try {
          const value = await reader.read();
          send(
            value.done
              ? { kind: "end", id }
              : { kind: "chunk", id, data: Buffer.from(value.value).toString("base64") }
          );
        } catch {
          send({ kind: "stream_error", id });
        }
      })
      .catch((error) => {
        failure = error;
        child.kill();
      });
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBuffer.length + chunk.length > 1500000) {
      failure = new Error("SDK fixture stdout exceeded line boundary");
      child.kill();
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newline: number;
    while ((newline = stdoutBuffer.indexOf(10)) >= 0) {
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          stdoutBuffer.subarray(0, newline)
        );
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        handleLine(line);
      } catch {
        failure = new Error("SDK fixture stdout encoding rejected");
        child.kill();
        return;
      }
    }
  });
  send({ key: key.key, kwargs: capture.capturedKwargs, driverFlags: capture.driverFlags, mode });
  try {
    const status = await closed;
    await pending;
    if (failure) throw failure;
    assert.equal(stdoutBuffer.length, 0, "SDK result lines must terminate");
    assert.ok(result, "SDK must return a bounded result");
    assert.equal(status, result.ok ? 0 : 2);
    return { result, requests, observations };
  } finally {
    clearTimeout(timer);
    for (const reader of readers.values()) void reader.cancel().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}
const options = {
  skip: AVAILABLE ? false : "Exact external SDK venv is not configured; no SDK execution",
  timeout: 40000,
};
for (const [caseName, value] of [
  ["explicit-medium", "medium"],
  ["explicit-high", "high"],
])
  test(
    `installed SDK serializes original ${caseName} kwargs and parses actual-handler JSON`,
    options,
    async () => {
      effort = value;
      const { result, requests, observations } = await sdk(source(caseName), "json");
      assert.equal(
        result.ok,
        true,
        JSON.stringify({
          error: result.errorClass,
          status: result.status,
          observations: typeof observations === "undefined" ? null : observations,
        })
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].reasoning_effort, value);
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
      assert.equal(
        (result.summaries as Array<Record<string, unknown>>)[0].content,
        "Synthetic SDK OK"
      );
      assert.equal(result.fullHermesExecuted, false);
    }
  );
test(
  "installed SDK parses actual-handler SSE and closes normally on its terminal",
  options,
  async () => {
    const { result, requests } = await sdk(source("default-stream"), "stream");
    assert.equal(result.ok, true);
    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(
      readDecisionAttempts(key.id).filter((row) => row.lane === "execution")[0].application_status,
      200
    );
  }
);
test(
  "actual SDK assembles tools, original constructors build results, and next SDK POST stays pinned",
  options,
  async () => {
    const { result, requests } = await sdk(source("stream-tools"), "tool-loop");
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
    const summaries = result.summaries as Array<Record<string, unknown>>;
    assert.equal(summaries[0].callCount, 2);
    assert.equal(summaries[1].content, "Synthetic SDK OK");
    assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
    assert.ok(JSON.stringify(wires[1]).includes("synthetic-sdk-account-signature"));
    const rows = readDecisionAttempts(key.id).filter((row) => row.lane === "execution");
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.connection_id, sonnetId);
      assert.equal(row.application_status, 200);
      assert.equal(row.cost_usd, 0.003);
    }
  }
);
for (const status of [401, 429])
  test(
    `actual SDK receives terminal ${status} without SDK retry or provider fallback`,
    options,
    async () => {
      denial = status;
      const { result, requests } = await sdk(source("default-stream"), "stream");
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(requests.length, 1);
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
      assert.equal(readToolContinuations(key.id, comboId).length, 0);
    }
  );
test(
  "SDK cancellation closes the actual handler before tool completion without a pin",
  options,
  async () => {
    const { result } = await sdk(source("stream-tools"), "cancel");
    assert.equal(result.ok, true);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    assert.equal(
      readDecisionAttempts(key.id).filter((row) => row.lane === "execution")[0].application_status,
      499
    );
  }
);
test(
  "SDK-built continuation cannot replace missing signed replay with the public ID cache",
  options,
  async () => {
    missingReplay = true;
    const { result, requests } = await sdk(source("stream-tools"), "tool-loop");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(requests.length, 2);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  }
);
for (const zero of [false, true])
  test(`actual SDK usage retains ${zero ? "genuine zero" : "unknown"} cost`, options, async () => {
    missingCost = !zero;
    zeroCost = zero;
    const { result } = await sdk(source("default-stream"), "stream");
    assert.equal(result.ok, true);
    const summary = (result.summaries as Array<{ usage: Record<string, unknown> }>)[0];
    assert.equal(summary.usage.cost, zero ? 0 : null);
    assert.equal(
      readDecisionAttempts(key.id).filter((row) => row.lane === "execution")[0].cost_usd,
      zero ? 0 : null
    );
  });

function effortSource(caseName: string, tools: boolean) {
  const run = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesEffort/build_request.py", import.meta.url)
      ),
    ],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-effort-sdk-home` },
      input: JSON.stringify({ case: caseName, tools }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 200000,
    }
  );
  assert.equal(run.status, 0, "Approved profile source fixture must complete");
  const capture = JSON.parse(run.stdout);
  assert.equal(capture.ok, true);
  assert.equal(capture.clientBaseURL, "https://hermes.fixture.invalid/v1");
  assert.equal(capture.fullHermesExecuted, false);
  assert.equal(capture.sdkWireCaptured, false);
  return capture;
}
test(
  "installed SDK preserves opt-in delegated effort omission through both tool requests",
  options,
  async () => {
    delegated = true;
    effort = "high";
    const capture = effortSource("delegated-unset", true);
    assert.equal(Object.hasOwn(capture.capturedKwargs, "reasoning_effort"), false);
    const { result, requests } = await sdk(capture, "tool-loop");
    assert.equal(
      result.ok,
      true,
      JSON.stringify({ error: result.errorClass, status: result.status })
    );
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(Object.hasOwn(request, "reasoning_effort"), false);
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
    for (const row of readDecisionAttempts(key.id).filter((row) => row.lane === "execution")) {
      assert.equal(row.effort, "high");
      assert.equal(row.connection_id, sonnetId);
      assert.equal(row.application_status, 200);
    }
  }
);
for (const value of ["medium", "high"])
  test(`installed SDK retains explicit ${value} in the opt-in relay profile`, options, async () => {
    effort = value;
    const { result, requests } = await sdk(effortSource(`explicit-${value}`, false), "stream");
    assert.equal(result.ok, true);
    assert.equal(requests[0].reasoning_effort, value);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  });
for (const caseName of ["explicit-off", "recovery-off"])
  test(`installed SDK does not turn ${caseName} into enabled thinking`, options, async () => {
    const capture = effortSource(caseName, false);
    assert.equal(capture.capturedKwargs.reasoning_effort, "none");
    const { result, requests } = await sdk(capture, "stream");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(requests[0].reasoning_effort, "none");
    assert.equal(decisions, 0);
    assert.equal(executions, 0);
  });

// Opaque signatures exercise structural replay only, not provider cryptography.
for (const count of [1, 2])
  test(
    `installed SDK completes ${count} native AGY calls through original Hermes result constructors`,
    options,
    async () => {
      await configureAgy(count === 2);
      const { result, requests, observations } = await sdk(source("stream-tools"), "tool-loop");
      assert.equal(
        result.ok,
        true,
        JSON.stringify({
          error: result.errorClass,
          status: result.status,
          observations,
          decisions,
          executions,
        })
      );
      assert.equal(requests.length, 2);
      assert.equal(decisions, 1);
      assert.equal(executions, 2);
      for (const request of requests) assert.equal(request.reasoning_effort, "high");
      const summaries = result.summaries as Array<Record<string, unknown>>;
      assert.equal(summaries[0].callCount, count);
      assert.equal(summaries[1].content, "Synthetic SDK OK");
      const native = wires[1].request as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      const parts = native.contents.flatMap((row) => row.parts);
      assert.deepEqual(
        parts.filter((part) => part.functionCall),
        agyParts()
      );
      assert.deepEqual(
        parts.filter((part) => part.functionResponse),
        agyParts().map((part) => {
          const call = part.functionCall as { id: string; name: string };
          return {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { output: "Synthetic result" },
            },
          };
        })
      );
      assert.ok(
        parts.findIndex((part) => part.functionResponse) >
          parts.findLastIndex((part) => part.functionCall)
      );
      assert.ok(!JSON.stringify(wires[1]).includes("skip_thought_signature_validator"));
      assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.filter((row) => row.lane === "decision").length, 1);
      assert.equal(rows.find((row) => row.lane === "decision")?.cost_usd, 0);
      const executionRows = rows.filter((row) => row.lane === "execution");
      assert.equal(executionRows.length, 2);
      for (const row of executionRows) {
        assert.equal(row.connection_id, agyId);
        assert.equal(row.provider, "agy");
        assert.equal(row.model, BOUNDED_AGY_MODEL);
        assert.equal(row.effort, "high");
        assert.equal(row.application_status, 200);
        assert.equal(row.cost_usd, null);
      }
      assert.equal(result.fullHermesExecuted, false);
    }
  );
test(
  "installed SDK receives native AGY no-call refusal without continuation or retry",
  options,
  async () => {
    await configureAgy(true);
    agyRefuse = true;
    const { result, requests, observations } = await sdk(source("stream-tools"), "stream");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "ContentFilterFinishReasonError");
    assert.equal(result.status, null);
    assert.equal(observations[0].status, 200);
    assert.equal(requests.length, 1);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    const row = readDecisionAttempts(key.id).find((item) => item.lane === "execution")!;
    assert.equal(row.http_status, 200);
    assert.equal(row.application_status, 422);
    assert.equal(row.input_tokens, 2);
    assert.equal(row.output_tokens, 4);
    assert.equal(row.reasoning_tokens, 1);
    assert.equal(row.cost_usd, null);
  }
);
