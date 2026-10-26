import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
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
const MODEL = "synthetic-bounded-stream";
const SELECTOR_URL = "https://opencode.ai/inference/systemone/v1/systemone";
const EXECUTION_URL = "https://api.anthropic.com/v1/messages?beta=true";
const credentials = {
  selector: "synthetic-stream-free",
  opus: "sk-ant-oat-synthetic-stream-opus",
  sonnet: "sk-ant-oat-synthetic-stream-sonnet",
};
let key: Awaited<ReturnType<typeof createApiKey>>;
let selectorId: string, opusId: string, sonnetId: string;
let selected = "sonnet-medium",
  decisionCalls = 0,
  executionCalls = 0,
  unexpectedCalls = 0;
let upstream: ReadableStreamDefaultController<Uint8Array>;
let cancelled = 0;
let scenario = "normal",
  generated = 0;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
let openaiId: string;
let expectedStreamOptions: { include_usage: boolean } | undefined = { include_usage: true };
const oldFetch = globalThis.fetch;
const encoder = new TextEncoder();
function frame(event: string, body: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}
function start() {
  return frame("message_start", {
    type: "message_start",
    message: {
      id: "synthetic-stream-message",
      type: "message",
      role: "assistant",
      model:
        scenario === "wrong-model"
          ? "claude-wrong-synthetic"
          : `claude-${selected.startsWith("opus") ? "opus" : "sonnet"}-5-5`,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 8,
        output_tokens: 0,
        cache_read_input_tokens: scenario === "cached" ? 3 : 0,
        cache_creation_input_tokens: scenario === "cached" ? 2 : 0,
      },
    },
  });
}
function text() {
  return frame("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Synthetic é answer" },
  });
}
function finish(usage = true, reportedCost: number | null = 0.002) {
  upstream.enqueue(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
  upstream.enqueue(
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      ...(usage
        ? { usage: { output_tokens: 4, ...(reportedCost === null ? {} : { cost: reportedCost }) } }
        : {}),
    })
  );
  if (scenario === "late-usage")
    upstream.enqueue(
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: null, stop_sequence: null },
        usage: { output_tokens: 4, cost: 0.003 },
      })
    );
  upstream.enqueue(frame("message_stop", { type: "message_stop" }));
  upstream.close();
}
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
before(async () => {
  // Initialize the application's normal fetch patch before the closed fixture interceptor.
  // Otherwise the route's first import replaces the mock and the offline guard stops it.
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init.method !== "POST" || ![SELECTOR_URL, EXECUTION_URL, OPENAI_URL].includes(url)) {
      unexpectedCalls++;
      throw new Error("Closed stream fixture unexpected dispatch");
    }
    const sent = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    if (url === SELECTOR_URL) {
      decisionCalls++;
      assert.equal(headers.get("authorization"), `Bearer ${credentials.selector}`);
      const options = Object.keys(sent.questions.route.criteria);
      if (scenario.startsWith("decision-denied-"))
        return Response.json(
          { error: { message: "Synthetic access boundary" } },
          { status: Number(scenario.slice(16)) }
        );
      if (scenario === "decision-refused")
        return Response.json({
          model: "jev-1.13-free",
          answers: { route: { type: "refusal" } },
          usage: { input_tokens: 7, output_tokens: 1, cost: 0 },
        });
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: selected,
            probabilities: Object.fromEntries(
              options.map((id) => [id, id === selected ? 0.8 : 0.2])
            ),
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 7, output_tokens: 2, cost: 0 },
      });
    }
    executionCalls++;
    if (url === OPENAI_URL) {
      assert.equal(headers.get("authorization"), "Bearer synthetic-stream-openai");
      assert.equal(sent.model, "gpt-5.4");
      assert.equal(sent.reasoning_effort, "high");
      assert.equal(sent.max_completion_tokens, 64);
      assert.equal(sent.stream, true);
      assert.deepEqual(sent.stream_options, expectedStreamOptions);
      const data = (part: unknown) => encoder.encode(`data: ${JSON.stringify(part)}\n\n`);
      const chunk = (choices: unknown[], usage?: unknown) => ({
        id: "synthetic-openai",
        object: "chat.completion.chunk",
        model: "gpt-5.4",
        choices,
        ...(usage ? { usage } : {}),
      });
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(
                data(
                  chunk([
                    {
                      index: 0,
                      delta: { role: "assistant", content: "Synthetic openai" },
                      finish_reason: null,
                    },
                  ])
                )
              );
              controller.enqueue(data(chunk([{ index: 0, delta: {}, finish_reason: "stop" }])));
              if (expectedStreamOptions?.include_usage || scenario === "ignored-usage")
                controller.enqueue(
                  data(
                    chunk([], {
                      prompt_tokens: scenario === "zero" ? 0 : 8,
                      completion_tokens: scenario === "zero" ? 0 : 4,
                      total_tokens: scenario === "zero" ? 0 : 12,
                      cost: 0,
                      prompt_tokens_details: { cached_tokens: 0 },
                      completion_tokens_details: { reasoning_tokens: scenario === "zero" ? 0 : 1 },
                    })
                  )
                );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          },
          { highWaterMark: 0 }
        ),
        { headers: { "content-type": "text/event-stream" } }
      );
    }
    const family = selected.startsWith("opus") ? "opus" : "sonnet";
    assert.equal(headers.get("authorization"), `Bearer ${credentials[family]}`);
    assert.equal(sent.model, `claude-${family}-5-5`);
    assert.equal(sent.stream, true);
    assert.equal(sent.max_tokens, 64);
    assert.equal(sent.output_config.effort, selected.endsWith("high") ? "high" : "medium");
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            upstream = controller;
            controller.enqueue(start());
            controller.enqueue(
              frame("content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              })
            );
            if (scenario !== "empty") controller.enqueue(text());
            if (scenario === "split") {
              const bytes = encoder.encode(
                'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"é"}}\r\n\r\n'
              );
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            }
          },
          pull(controller) {
            if (scenario === "backpressure" && generated < 1000) {
              generated++;
              controller.enqueue(
                frame("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "x".repeat(512) },
                })
              );
            }
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    );
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
  openaiId = String(
    (
      await createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "synthetic-stream-openai",
        apiKey: "synthetic-stream-openai",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    ).id
  );
  const openaiConfig = config();
  const c = {
    ...candidate("opus", "high"),
    id: "openai-high",
    provider: "openai",
    model: "gpt-5.4",
  };
  const cfg = JSON.parse(JSON.stringify(openaiConfig));
  delete cfg.decisionPolicy.selection;
  cfg.decisionPolicy.policy.maxDecisionAttempts = 0;
  cfg.decisionPolicy.policy.candidates = [c];
  cfg.decisionPolicy.policy.taskOrder = { explanation: [c.id] };
  cfg.decisionPolicy.connections = { [c.id]: openaiId };
  await createCombo({
    name: MODEL + "-openai",
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: cfg,
  });
  await createCombo({
    name: "synthetic-hermes-pinned",
    models: ["claude/claude-opus-5-5"],
    strategy: "priority",
    config: config(),
  });
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
  key = await createApiKey("synthetic-stream-client-" + randomUUID(), "synthetic");
  selected = "sonnet-medium";
  cancelled = 0;
  scenario = "normal";
  generated = 0;
  expectedStreamOptions = { include_usage: true };
});
after(async () => {
  globalThis.fetch = oldFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(unexpectedCalls, 0);
});
function body() {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "Explain a synthetic lamp." }],
    reasoning_effort: selected.endsWith("high") ? "high" : "medium",
    max_tokens: 64,
    stream: true,
    stream_options: { include_usage: true },
  };
}
async function headers() {
  return Promise.race([
    POST(request(body())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("headers waited for provider terminal")), 1500)
    ),
  ]);
}
test("actual POST streams first text before terminal and keeps final accounting pending", async () => {
  const d = decisionCalls,
    e = executionCalls;
  const response = await headers();
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? "");
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e + 1);
  assert.equal(response.headers.get("x-omniroute-routing-cost"), null);
  assert.equal(response.headers.get("x-omniroute-routing-cost-status"), "pending");
  const reader = response.body!.getReader();
  let first = "";
  while (!first.includes("Synthetic")) {
    const part = await reader.read();
    assert.equal(part.done, false);
    first += new TextDecoder().decode(part.value);
  }
  let receipt = readDecisionAttempts(key.id).find((r) => r.lane === "execution")!;
  assert.equal(receipt.state, "started");
  assert.equal(receipt.cost_usd, null);
  assert.equal(receipt.application_status, null);
  finish();
  while (!(await reader.read()).done) {}
  receipt = readDecisionAttempts(key.id).find((r) => r.lane === "execution")!;
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.output_tokens, 4);
  assert.equal(receipt.input_tokens, 8);
  assert.equal(receipt.cost_usd, 0.002);
  assert.equal(receipt.application_status, 200);
  assert.equal(executionCalls, e + 1);
});

async function drain(response: Response) {
  const reader = response.body!.getReader();
  let content = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      content += new TextDecoder().decode(chunk.value);
    }
  } catch {
    /* Stream failure is also asserted by its durable status. */
  }
  return content;
}
function receipt() {
  return readDecisionAttempts(key.id).find((row) => row.lane === "execution")!;
}
for (const choice of ["opus-medium", "sonnet-high", "opus-high"]) {
  test(`streaming exact ${choice} reaches its selected target once`, async () => {
    selected = choice;
    const e = executionCalls,
      d = decisionCalls;
    const response = await headers();
    assert.equal(response.status, 200);
    finish();
    await drain(response);
    assert.equal(receipt().candidate_id, choice);
    assert.equal(receipt().application_status, 200);
    assert.equal(executionCalls, e + 1);
    assert.equal(decisionCalls, d + 1);
  });
}
test("OpenAI text stream preserves exact effort/output and reported zero cost", async () => {
  selected = "openai-high";
  const d = decisionCalls,
    e = executionCalls;
  const response = await POST(request({ ...body(), model: MODEL + "-openai" }));
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? "");
  const text = await drain(response);
  assert.match(text, /Synthetic openai/);
  assert.equal(receipt().cost_usd, 0);
  assert.equal(receipt().reasoning_tokens, 1);
  assert.equal(receipt().application_status, 200);
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e + 1);
});
test("split UTF-8 and CRLF SSE frames retain text and terminal usage", async () => {
  scenario = "split";
  const response = await headers();
  assert.equal(response.status, 200);
  finish();
  const text = await drain(response);
  assert.match(text, /é/);
  assert.equal(receipt().output_tokens, 4);
  assert.equal(receipt().application_status, 200);
});
test("missing terminal output usage remains null despite initial output zero", async () => {
  const response = await headers();
  assert.equal(response.status, 200);
  finish(false);
  const clientBody = await drain(response);
  assert.ok(
    !/"usage"\s*:\s*\{/.test(clientBody),
    "Missing Claude output must not become client-visible zero or estimated totals"
  );
  assert.equal(receipt().output_tokens, null);
  assert.equal(receipt().cost_usd, null);
  assert.equal(receipt().state, "completed");
});
test("missing cost stays unknown and a genuine zero cost is preserved", async () => {
  const response = await headers();
  finish(true, null);
  await drain(response);
  assert.equal(receipt().cost_usd, null);
  assert.equal(receipt().output_tokens, 4);
});
test("truncated provider EOF is not downstream synthetic success", async () => {
  const e = executionCalls;
  const response = await headers();
  assert.equal(response.status, 200);
  upstream.close();
  await drain(response);
  assert.equal(receipt().state, "unknown");
  assert.equal(receipt().cost_usd, null);
  assert.notEqual(receipt().application_status, 200);
  assert.equal(executionCalls, e + 1);
});
test("client cancel after initial output cancels provider with no following dispatch", async () => {
  const e = executionCalls;
  const response = await headers();
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(receipt().state, "unknown");
  assert.equal(receipt().application_status, 499);
  assert.equal(executionCalls, e + 1);
  assert.ok(cancelled >= 1);
});
test("slow consumer cannot eagerly drain an entire provider stream", async (t) => {
  scenario = "backpressure";
  const response = await headers();
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  t.diagnostic(`Bounded read-ahead: ${generated} of 1000 fixture frames`);
  assert.ok(generated <= 128, `read-ahead consumed ${generated} frames`);
  await response.body!.cancel();
  assert.equal(receipt().state, "unknown");
});
test("wrong provider model before client output cannot call fallback", async () => {
  scenario = "wrong-model";
  const e = executionCalls;
  const response = await headers();
  await drain(response);
  assert.notEqual(response.status, 200);
  assert.equal(executionCalls, e + 1);
  assert.equal(receipt().state, "unknown");
});
test("oversized frame after output is rejected without another dispatch", async () => {
  const e = executionCalls;
  const response = await headers();
  assert.equal(response.status, 200);
  upstream.enqueue(encoder.encode(`data: ${"x".repeat(65537)}\n\n`));
  upstream.close();
  await drain(response);
  assert.equal(receipt().state, "unknown");
  assert.notEqual(receipt().application_status, 200);
  assert.equal(executionCalls, e + 1);
});
test("aborted request before entry has zero decision/execution calls", async () => {
  const a = new AbortController();
  a.abort();
  const e = executionCalls,
    d = decisionCalls;
  const response = await POST(request(body(), a.signal));
  assert.ok(response.status >= 400);
  assert.equal(executionCalls, e);
  assert.equal(decisionCalls, d);
  assert.equal(readDecisionAttempts(key.id).length, 0);
});

for (const options of [{ include_usage: false }, undefined]) {
  test(`OpenAI include_usage ${options ? "false" : "omitted"} is preserved and missing usage stays unknown`, async () => {
    selected = "openai-high";
    expectedStreamOptions = options;
    const sent = { ...body(), model: MODEL + "-openai", stream_options: options };
    const response = await POST(request(sent));
    assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? "");
    const clientBody = await drain(response);
    assert.ok(
      !/"usage"\s*:\s*\{/.test(clientBody),
      "Missing provider totals must not be replaced by client-visible estimates"
    );
    assert.equal(receipt().output_tokens, null);
    assert.equal(receipt().cost_usd, null);
    assert.equal(receipt().application_status, 200);
  });
}

test("pinned original Hermes High kwargs and declared stream flags reach actual POST", async () => {
  const child = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesPinned/build_request.py", import.meta.url)
      ),
    ],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-hermes-home` },
      input: JSON.stringify({ case: "default-stream" }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 128000,
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const capture = JSON.parse(child.stdout);
  assert.equal(capture.sdkWireCaptured, false);
  assert.equal(capture.fullHermesExecuted, false);
  assert.equal(capture.capturedKwargs.reasoning_effort, "high");
  selected = "sonnet-high";
  assert.equal(capture.body.stream, true);
  assert.deepEqual(capture.body.stream_options, { include_usage: true });
  const d = decisionCalls,
    e = executionCalls;
  const response = await POST(request(capture.body));
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? "");
  finish();
  await drain(response);
  assert.equal(receipt().application_status, 200);
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e + 1);
});

for (const status of [401, 403, 429])
  test(`streaming native decision HTTP${status} is terminal without execution/fallback`, async () => {
    scenario = `decision-denied-${status}`;
    const d = decisionCalls,
      e = executionCalls;
    const response = await POST(request(body()));
    await response.text();
    assert.ok(response.status >= 400);
    assert.equal(decisionCalls, d + 1);
    assert.equal(executionCalls, e);
    assert.equal(readDecisionAttempts(key.id).filter((row) => row.lane === "execution").length, 0);
  });
test("refused streaming selection never executes a candidate", async () => {
  scenario = "decision-refused";
  const d = decisionCalls,
    e = executionCalls;
  const response = await POST(request(body()));
  await response.text();
  assert.ok(response.status >= 400);
  assert.equal(decisionCalls, d + 1);
  assert.equal(executionCalls, e);
});
for (const committed of [false, true])
  test(`request abort ${committed ? "after" : "before"} client read errors stream and cancels raw provider`, async () => {
    const a = new AbortController(),
      d = decisionCalls,
      e = executionCalls;
    const response = await POST(request(body(), a.signal));
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    if (committed) await reader.read();
    a.abort();
    // The real route's early-keepalive wrapper can express the failure as an
    // in-band SSE error or an orderly abort rather than a rejected read promise.
    await Promise.race([
      (async () => {
        try {
          while (!(await reader.read()).done) {}
        } catch {
          /* aborted reader */
        }
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Abort did not close stream")), 1000)
      ),
    ]);
    assert.equal(receipt().application_status, 499);
    assert.equal(receipt().cost_usd, null);
    assert.ok(cancelled >= 1);
    assert.equal(decisionCalls, d + 1);
    assert.equal(executionCalls, e + 1);
  });
for (const patch of [
  { stream: false, stream_options: { include_usage: true } },
  { stream: true, stream_options: { include_usage: "true" } },
  { stream: true, stream_options: { include_usage: true, extra: true } },
])
  test(`invalid stream control ${JSON.stringify(patch)} sends nothing`, async () => {
    const d = decisionCalls,
      e = executionCalls;
    const response = await POST(request({ ...body(), ...patch }));
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls, d);
    assert.equal(executionCalls, e);
  });

test("client cancel immediately after delivered DONE preserves verified provider completion", async () => {
  const response = await headers();
  assert.equal(response.status, 200);
  finish();
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes("[DONE]")) {
    const part = await reader.read();
    assert.equal(part.done, false);
    text += new TextDecoder().decode(part.value);
  }
  await reader.cancel();
  assert.equal(receipt().state, "completed");
  assert.equal(receipt().application_status, 200);
  assert.equal(receipt().cost_usd, 0.002);
});

test("late usage-only message_delta after stop reason retains final reported receipt", async () => {
  scenario = "late-usage";
  const response = await headers();
  assert.equal(response.status, 200);
  finish();
  await drain(response);
  assert.equal(receipt().cost_usd, 0.003);
  assert.equal(receipt().output_tokens, 4);
  assert.equal(receipt().application_status, 200);
});

test("streaming zero eligible candidates remains a no-route result without reservations", async () => {
  const d = decisionCalls,
    e = executionCalls;
  const response = await POST(request({ ...body(), reasoning_effort: "none" }));
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "no-route");
  assert.equal(decisionCalls, d);
  assert.equal(executionCalls, e);
  assert.equal(readDecisionAttempts(key.id).length, 0);
});

function usageChunks(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((chunk) => chunk.usage && typeof chunk.usage === "object")
    .map((chunk) => chunk.usage);
}
test("Claude client totals include reported caches without inventing reasoning tokens", async () => {
  scenario = "cached";
  const response = await headers();
  assert.equal(response.status, 200);
  finish();
  const text = await drain(response);
  const totals = usageChunks(text);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].prompt_tokens, 13);
  assert.equal(totals[0].completion_tokens, 4);
  assert.equal(totals[0].prompt_tokens_details.cached_tokens, 3);
  assert.equal(totals[0].prompt_tokens_details.cache_creation_tokens, 2);
  assert.equal(totals[0].completion_tokens_details?.reasoning_tokens, undefined);
  assert.equal(receipt().input_tokens, 13);
});

test("armed recovery/readiness/empty retry controls cannot replay a bounded empty stream", async () => {
  const flags = [
    "STREAM_RECOVERY_ENABLED",
    "STREAM_RECOVERY_MIDSTREAM_ENABLED",
    "STREAM_THROUGHPUT_WATCHDOG_ENABLED",
    "EMPTY_STREAM_SIBLING_RECOVERY_ENABLED",
    "FLUSH_EMPTY_RETRY_ENABLED",
  ];
  const old = flags.map((flag) => process.env[flag]);
  for (const flag of flags) process.env[flag] = "true";
  try {
    const { isFeatureFlagEnabled } = await import("../../src/shared/utils/featureFlags.ts");
    for (const flag of flags) assert.equal(isFeatureFlagEnabled(flag), true);
    const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");
    const { getSettings } = await import("../../src/lib/db/settings.ts");
    assert.equal(resolveResilienceSettings(await getSettings()).streamRecovery.enabled, true);
    scenario = "empty";
    const e = executionCalls,
      d = decisionCalls;
    const response = await headers();
    assert.equal(response.status, 200);
    upstream.close();
    await drain(response);
    assert.equal(executionCalls, e + 1);
    assert.equal(decisionCalls, d + 1);
    assert.equal(receipt().state, "unknown");
    assert.notEqual(receipt().application_status, 200);
  } finally {
    flags.forEach((flag, index) => {
      if (old[index] === undefined) delete process.env[flag];
      else process.env[flag] = old[index];
    });
  }
});

test("explicit synthetic zero token counters stay zero in final client usage", async () => {
  scenario = "zero";
  selected = "openai-high";
  const response = await POST(request({ ...body(), model: MODEL + "-openai" }));
  assert.equal(response.status, 200);
  const totals = usageChunks(await drain(response));
  assert.equal(totals.length, 1);
  assert.equal(totals[0].prompt_tokens, 0);
  assert.equal(totals[0].completion_tokens, 0);
  assert.equal(totals[0].total_tokens, 0);
  assert.equal(totals[0].completion_tokens_details.reasoning_tokens, 0);
  assert.equal(receipt().output_tokens, 0);
  assert.equal(receipt().cost_usd, 0);
});
for (const options of [{ include_usage: false }, undefined])
  test(`provider ignoring include_usage ${options ? "false" : "omitted"} cannot force client totals`, async () => {
    scenario = "ignored-usage";
    selected = "openai-high";
    expectedStreamOptions = options;
    const response = await POST(
      request({ ...body(), model: MODEL + "-openai", stream_options: options })
    );
    assert.equal(response.status, 200);
    assert.equal(usageChunks(await drain(response)).length, 0);
    assert.equal(receipt().input_tokens, 8);
    assert.equal(receipt().output_tokens, 4);
    assert.equal(receipt().cost_usd, 0);
  });
