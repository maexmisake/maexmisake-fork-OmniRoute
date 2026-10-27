import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
let POST: (request: Request) => Promise<Response>;
const FIXTURES = new URL("../fixtures/decisionPolicy/hermesPinned/", import.meta.url);
const PIN = "749cb638ff43f9ce5333c186a1e4f67d473aa4f2";
const MODEL = "synthetic-hermes-pinned";
const SELECTOR_URL = "https://opencode.ai/inference/systemone/v1/systemone";
const EXECUTION_URL = "https://api.anthropic.com/v1/messages?beta=true";
const credentials = {
  selector: "synthetic-hermes-free-selector",
  opus: "sk-ant-oat-synthetic-hermes-opus",
  sonnet: "sk-ant-oat-synthetic-hermes-sonnet",
};
type Capture = {
  pin: string;
  capturedKwargs: Record<string, unknown>;
  body: Record<string, unknown>;
  executedSourceFunctions: string[];
  driverFlags: Record<string, unknown>;
  sdkOnlyOmitted: string[];
  substitutions: string[];
  sdkWireCaptured: boolean;
  fullHermesExecuted: boolean;
};
function builder(caseName: string, success = true): Capture {
  const child = spawnSync(
    "python3",
    ["-I", "-B", fileURLToPath(new URL("build_request.py", FIXTURES))],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/hermes-empty-home` },
      input: JSON.stringify({ case: caseName }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 128000,
    }
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, success ? 0 : 2, child.stderr);
  const parsed = JSON.parse(child.stdout);
  if (!success) {
    assert.deepEqual(parsed, { ok: false, error: "closed-fixture-boundary" });
    return parsed;
  }
  assert.equal(parsed.pin, PIN);
  assert.equal(parsed.sdkWireCaptured, false);
  assert.equal(parsed.fullHermesExecuted, false);
  return parsed;
}
const sourceCaptures = new Map<string, Capture>();
function capture(name: string) {
  if (!sourceCaptures.has(name)) sourceCaptures.set(name, builder(name));
  return structuredClone(sourceCaptures.get(name)!);
}
let key: Awaited<ReturnType<typeof createApiKey>>;
let selectorId: string, opusId: string, sonnetId: string;
let selected = "sonnet-medium",
  decisionCalls = 0,
  executionCalls = 0,
  unexpectedCalls = 0;
let unknownCosts = false,
  refused = false;
let delegatedSource = false;
let lastExecution: Record<string, unknown> | undefined;
const traces: Array<Record<string, unknown>> = [];
const oldFetch = globalThis.fetch;

function candidate(family: "opus" | "sonnet", effort: "medium" | "high") {
  return {
    id: `${family}-${effort}`,
    provider: "claude",
    model: `claude-${family}-5-5`,
    endpointKind: "direct",
    evidence: "Synthetic capability fixture, not observed account or quality evidence",
    capabilities: {
      text: true,
      images: false,
      tools: false,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: { mode: "set", value: effort, supported: [effort], evidence: "Synthetic exact pair" },
  };
}
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
        timeoutMs: 1000,
      },
      connections: {
        "opus-medium": opusId,
        "opus-high": opusId,
        "sonnet-medium": sonnetId,
        "sonnet-high": sonnetId,
      },
      policy: {
        version: 1,
        candidates: [
          candidate("opus", "medium"),
          candidate("opus", "high"),
          candidate("sonnet", "medium"),
          candidate("sonnet", "high"),
        ],
        taskOrder: { explanation: ["opus-medium", "sonnet-medium", "opus-high", "sonnet-high"] },
        unknownQuota: "allow",
        decisionFailure: "stop",
        maxDecisionAttempts: 1,
        maxExecutionAttempts: 1,
        timeoutMs: 5000,
      },
    },
  };
}
function request(body: Record<string, unknown>, signal?: AbortSignal, authenticated = true) {
  return new Request("http://synthetic.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${key.key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
function mockDecision(sent: Record<string, unknown>) {
  const questions = sent.questions as Record<string, Record<string, unknown>>;
  const options = Object.keys(questions.route.criteria as Record<string, unknown>).sort();
  const effort = selected.endsWith("high") ? "high" : "medium";
  assert.deepEqual(
    options,
    delegatedSource
      ? ["opus-high", "opus-medium", "sonnet-high", "sonnet-medium"]
      : [`opus-${effort}`, `sonnet-${effort}`]
  );
  const criteria = questions.route.criteria as Record<string, string>;
  for (const option of options) {
    const offered = JSON.parse(criteria[option]);
    assert.equal(offered.effort.value, delegatedSource ? option.split("-").at(-1) : effort);
    assert.equal(offered.provider, "claude");
  }
  const text = JSON.stringify(sent);
  for (const value of Object.values(credentials)) assert.ok(!text.includes(value));
  assert.ok(!text.includes("Explain a synthetic lamp."));
  return Response.json({
    model: "jev-1.13-free",
    answers: {
      route: refused
        ? { type: "refusal" }
        : {
            type: "choice",
            choice: selected,
            confidence: 0.6,
            probabilities: Object.fromEntries(
              options.map((id) => [
                id,
                delegatedSource ? (id === selected ? 0.7 : 0.1) : id === selected ? 0.8 : 0.2,
              ])
            ),
          },
    },
    usage: { input_tokens: 7, output_tokens: 2, ...(unknownCosts ? {} : { cost: 0 }) },
  });
}
function mockExecution(sent: Record<string, unknown>, headers: Headers) {
  lastExecution = sent;
  const family = selected.startsWith("opus") ? "opus" : "sonnet";
  const effort = selected.endsWith("high") ? "high" : "medium";
  assert.equal(headers.get("authorization"), `Bearer ${credentials[family]}`);
  assert.equal(sent.model, `claude-${family}-5-5`);
  assert.equal(sent.max_tokens, 64);
  for (const parameter of ["temperature", "top_p", "top_k"])
    assert.equal(Object.hasOwn(sent, parameter), false);
  assert.equal((sent.output_config as Record<string, unknown>).effort, effort);
  assert.equal((sent.thinking as Record<string, unknown>).type, "adaptive");
  if (delegatedSource) return delegatedStream(sent.model);
  return Response.json({
    id: "synthetic-hermes-answer",
    model: sent.model,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Synthetic answer" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 8,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...(unknownCosts ? {} : { cost: 0.002 }),
    },
  });
}
function delegatedStream(model: unknown) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "synthetic-delegated",
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Synthetic delegated answer" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4, ...(unknownCosts ? {} : { cost: 0.002 }) },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}
function delegatedCapture() {
  const child = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesEffort/build_request.py", import.meta.url)
      ),
    ],
    {
      env: {
        PATH: process.env.PATH!,
        HOME: `${process.env.DATA_DIR}/empty-delegated-builder-home`,
      },
      input: JSON.stringify({ case: "delegated-unset", tools: false }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 200000,
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.pin, PIN);
  assert.equal(value.fullHermesExecuted, false);
  assert.equal(value.sdkWireCaptured, false);
  assert.equal(Object.hasOwn(value.capturedKwargs, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(value.body, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(value.body, "tools"), false);
  return value;
}
before(async () => {
  // Initialize the application's normal fetch patch before the closed fixture interceptor.
  // Otherwise the route's first import replaces the mock and the offline guard stops it.
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init.method !== "POST" || ![SELECTOR_URL, EXECUTION_URL].includes(url)) {
      unexpectedCalls++;
      throw new Error("Pinned Hermes fixture rejects every unexpected fetch");
    }
    if (url === SELECTOR_URL) decisionCalls++;
    else executionCalls++;
    const headers = new Headers(init.headers);
    const sent = JSON.parse(String(init.body));
    if (url === SELECTOR_URL) {
      assert.equal(headers.get("authorization"), `Bearer ${credentials.selector}`);
      assert.equal(sent.model, "jev-1.13-free");
      return mockDecision(sent);
    }
    if (url === EXECUTION_URL) return mockExecution(sent, headers);
    throw new Error("Unreachable fixture route");
  };
  const fixtureFetch = globalThis.fetch;
  ({ POST } = await import("../../src/app/api/v1/chat/completions/route.ts"));
  assert.equal(globalThis.fetch, fixtureFetch, "route import must retain the closed interceptor");
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
        name: "synthetic-hermes-free",
        apiKey: credentials.selector,
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
      name: `synthetic-hermes-${family}`,
      accessToken: credentials[family],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    if (family === "opus") opusId = String(row.id);
    else sonnetId = String(row.id);
  }
  await createCombo({
    name: MODEL,
    models: ["claude/claude-opus-5-5"],
    strategy: "priority",
    config: config(),
  });
});
beforeEach(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  key = await createApiKey("synthetic-hermes-client-" + randomUUID(), "synthetic");
  selected = "sonnet-medium";
  unknownCosts = false;
  refused = false;
  delegatedSource = false;
  lastExecution = undefined;
});
after(async () => {
  globalThis.fetch = oldFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(unexpectedCalls, 0);
  if (process.env.NATIVE_EVIDENCE_PATH)
    writeFileSync(
      process.env.NATIVE_EVIDENCE_PATH,
      JSON.stringify(
        {
          pin: PIN,
          proofKind: "original-and-explicit-optional-profile-source-through-actual-POST",
          sdkWireCaptured: false,
          fullHermesExecuted: false,
          liveProvidersTested: false,
          traces,
        },
        null,
        2
      )
    );
});

test("pinned original fragments and MIT provenance are fixed and internally verified", () => {
  const provenance = JSON.parse(readFileSync(new URL("provenance.json", FIXTURES), "utf8"));
  const bytes = readFileSync(new URL("upstream-fragments.json", FIXTURES));
  assert.equal(provenance.commit, PIN);
  assert.equal(
    provenance.fragmentFileSHA256,
    "2268cc6a1862efd849e2dd79556fb007fbd07637a703cf042a6241c55deec52f"
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.fragmentFileSHA256);
  const fragments = JSON.parse(String(bytes)).fragments as Array<Record<string, unknown>>;
  assert.equal(fragments.length, 23);
  for (const row of fragments)
    assert.equal(createHash("sha256").update(String(row.source)).digest("hex"), row.sha256);
  assert.match(
    readFileSync(new URL("LICENSE", FIXTURES), "utf8"),
    /MIT License[\s\S]*2025 Nous Research/
  );
});
test("original builder and profile preserve explicit cap/High and execute default Medium", () => {
  for (const [name, effort] of [
    ["explicit-high", "high"],
    ["default-medium", "medium"],
  ]) {
    const source = capture(name);
    assert.equal(source.capturedKwargs.reasoning_effort, effort);
    assert.equal(source.capturedKwargs.max_tokens, 64);
    assert.equal(source.capturedKwargs.temperature, undefined);
    assert.deepEqual(source.sdkOnlyOmitted, ["timeout"]);
    assert.equal(source.body.timeout, undefined);
    assert.ok(
      source.executedSourceFunctions.some((id) => id.endsWith(":_build_chat_completions_kwargs"))
    );
    assert.ok(source.executedSourceFunctions.some((id) => id.endsWith(":build_api_kwargs_extras")));
  }
  assert.ok(
    capture("default-medium").executedSourceFunctions.some((id) =>
      id.endsWith(":default_reasoning_config")
    )
  );
});
test("original pinned builder preserves supplied omitted-cap tool profiles without source or wire rewriting", () => {
  for (const level of ["medium", "high", "xhigh", "max"]) {
    const value = capture(level === "high" ? "omitted-cap-tools" : `omitted-cap-tools-${level}`);
    assert.equal(value.capturedKwargs.max_tokens, undefined);
    assert.equal(value.capturedKwargs.max_completion_tokens, undefined);
    assert.equal(value.capturedKwargs.reasoning_effort, level);
    assert.equal(
      (value.capturedKwargs.tools as Array<{ function: { name: string } }>)[0].function.name,
      "synthetic_tool"
    );
    assert.deepEqual(value.driverFlags, { stream: true, stream_options: { include_usage: true } });
    assert.equal(value.body.reasoning_effort, level);
    assert.equal(value.body.max_tokens, undefined);
    assert.equal(value.fullHermesExecuted, false);
  }
  const parallel = capture("omitted-cap-tools-parallel");
  assert.equal(parallel.capturedKwargs.parallel_tool_calls, true);
  assert.equal(parallel.body.parallel_tool_calls, true);
  assert.equal(parallel.capturedKwargs.max_tokens, undefined);
});
for (const chosen of ["opus-high", "sonnet-medium"]) {
  test(`optional Hermes builder omission reaches actual streaming handler and chooses ${chosen}`, async () => {
    delegatedSource = true;
    selected = chosen;
    unknownCosts = chosen === "sonnet-medium";
    const source = delegatedCapture();
    const decisionsBefore = decisionCalls,
      executionsBefore = executionCalls;
    const response = await POST(request(source.body));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /Synthetic delegated answer/);
    assert.match(text, /\[DONE\]/);
    assert.equal(decisionCalls, decisionsBefore + 1);
    assert.equal(executionCalls, executionsBefore + 1);
    const receipts = readDecisionAttempts(key.id);
    assert.equal(receipts.length, 2);
    const execution = receipts.find((row) => row.lane === "execution")!;
    assert.equal(execution.candidate_id, chosen);
    assert.equal(execution.effort, chosen.split("-").at(-1));
    assert.equal(execution.connection_id, chosen.startsWith("opus") ? opusId : sonnetId);
    assert.equal(execution.application_status, 200);
    assert.equal(execution.cost_usd, unknownCosts ? null : 0.002);
    traces.push({
      case: "optional-delegation-actual-handler",
      sourceProofKind: source.proofKind,
      sourceFunctions: source.executedSourceFunctions,
      driverFlags: source.driverFlags,
      defaultResolverSourceKind: source.defaultResolverSourceKind,
      chosen,
      decisionCalls: 1,
      executionCalls: 1,
      sdkWireCaptured: false,
      fullHermesExecuted: false,
      reportedExecutionCostUsd: execution.cost_usd,
    });
  });
}
test("unknown providers/imports, socket access and extra_body collisions fail closed", () => {
  for (const name of [
    "unknown-provider",
    "unknown-import",
    "socket-canary",
    "extra-body-collision",
  ])
    builder(name, false);
});
for (const [sourceName, chosen] of [
  ["explicit-medium", "sonnet-medium"],
  ["default-medium", "opus-medium"],
  ["explicit-high", "sonnet-high"],
]) {
  test(`actual POST accepts declared nonstream subset from ${sourceName} and selects ${chosen}`, async () => {
    selected = chosen;
    const source = capture(sourceName);
    const d = decisionCalls,
      e = executionCalls;
    const response = await POST(request(source.body));
    const text = await response.text();
    assert.equal(
      response.status,
      200,
      `${response.headers.get("x-omniroute-decision-reason")} ${text}`
    );
    assert.equal(response.headers.get("x-omniroute-selection-mode"), "native");
    assert.equal(decisionCalls, d + 1);
    assert.equal(executionCalls, e + 1);
    const receipts = readDecisionAttempts(key.id);
    assert.equal(receipts.length, 2);
    const decision = receipts.find((row) => row.lane === "decision")!;
    const execution = receipts.find((row) => row.lane === "execution")!;
    assert.equal(decision.cost_usd, 0);
    assert.equal(execution.cost_usd, 0.002);
    assert.equal(execution.candidate_id, chosen);
    assert.equal(execution.parent_attempt_id, decision.id);
    assert.equal(execution.connection_id, chosen.startsWith("opus") ? opusId : sonnetId);
    assert.equal(execution.effort, source.body.reasoning_effort);
    assert.equal(lastExecution?.model, execution.model);
    traces.push({
      case: sourceName,
      sourceFunctions: source.executedSourceFunctions,
      substitutions: source.substitutions,
      driverFlags: source.driverFlags,
      preservedEffort: source.body.reasoning_effort,
      decisionCalls: 1,
      executionCalls: 1,
      selectionMode: "native",
      executionModel: execution.model,
      executionEffort: execution.effort,
      decisionCostUsd: decision.cost_usd,
      executionCostUsd: execution.cost_usd,
    });
  });
}
for (const sourceName of ["omitted-cap", "stream-tools", "nonstream-tools", "tool-continuation"]) {
  test(`actual POST rejects ${sourceName} with zero decision/execution calls`, async () => {
    const source = capture(sourceName);
    const d = decisionCalls,
      e = executionCalls;
    const response = await POST(request(source.body));
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls, d);
    assert.equal(executionCalls, e);
    assert.equal(readDecisionAttempts(key.id).length, 0);
    traces.push({ case: sourceName, status: response.status, decisionCalls: 0, executionCalls: 0 });
  });
}
test("actual POST preserves unknown decision/execution cost without inventing zero", async () => {
  unknownCosts = true;
  const d = decisionCalls,
    e = executionCalls;
  const response = await POST(request(capture("explicit-medium").body));
  assert.equal(response.status, 200, await response.text());
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e + 1);
  const receipts = readDecisionAttempts(key.id);
  assert.equal(receipts.length, 2);
  for (const row of receipts) assert.equal(row.cost_usd, null);
  const cost = JSON.parse(response.headers.get("x-omniroute-routing-cost")!);
  assert.equal(cost.totalUsd, null);
  assert.equal(cost.unknownStages, 2);
  traces.push({ case: "unknown-costs", decisionCalls: 1, executionCalls: 1, cost });
});
test("refused decision cannot trigger execution or global fallback", async () => {
  refused = true;
  const d = decisionCalls,
    e = executionCalls;
  const response = await POST(request(capture("explicit-medium").body));
  await response.text();
  assert.ok(response.status >= 400);
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e);
  assert.equal(readDecisionAttempts(key.id).filter((row) => row.lane === "execution").length, 0);
});
test("pre-cancelled and unauthenticated builder requests produce no dispatch", async () => {
  const d = decisionCalls,
    e = executionCalls;
  const cancel = new AbortController();
  cancel.abort();
  const body = capture("explicit-medium").body;
  const cancelled = await POST(request(body, cancel.signal));
  await cancelled.text();
  assert.ok(cancelled.status >= 400);
  const unauthorized = await POST(request(body, undefined, false));
  await unauthorized.text();
  assert.equal(unauthorized.status, 401);
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e);
});
