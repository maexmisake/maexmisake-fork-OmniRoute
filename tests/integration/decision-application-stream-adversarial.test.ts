import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";

// Independent synthetic protocol cases, not captured provider replies or live account evidence.
process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
const model = "synthetic-stream-adversarial";
const endpoint = "https://api.anthropic.com/v1/messages?beta=true";
const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let scenario = "normal";
let physicalCalls = 0;
let unexpectedCalls = 0;
let cancellationCalls = 0;

function event(type: string, value: Record<string, unknown> = {}) {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
}
function frames() {
  return [
    event("message_start", {
      message: {
        id: "synthetic-adversarial-message",
        model: "claude-sonnet-5-5",
        type: "message",
        role: "assistant",
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
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Synthetic OK" } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", {
      delta: { stop_reason: scenario === "refusal" ? "refusal" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 4, cost: 0.002 },
    }),
    event("message_stop"),
  ];
}
function request(signal?: AbortSignal, authenticated = true) {
  return new Request("http://synthetic.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${key.key}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Explain the synthetic fixture." }],
      reasoning_effort: "medium",
      max_completion_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
}
async function consume(response: Response) {
  try {
    return await response.text();
  } catch {
    return "closed-stream";
  }
}
function execution() {
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lane, "execution");
  assert.equal(rows[0].logical_counted, 1);
  const history = getDbInstance()
    .prepare("SELECT decision_attempt_id FROM usage_history WHERE api_key_id=?")
    .all(key.id) as Array<{ decision_attempt_id: string | null }>;
  assert.deepEqual(
    history,
    [{ decision_attempt_id: rows[0].id }],
    "no duplicate ordinary usage row"
  );
  const ledger = getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM request_cost_ledger WHERE api_key_id=?")
    .get(key.id) as { n: number };
  assert.equal(
    ledger.n,
    rows[0].cost_usd === null ? 0 : 1,
    "reported cost is billed once or remains unknown"
  );
  return rows[0];
}
before(async () => {
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint || init.method !== "POST") {
      unexpectedCalls++;
      throw new Error("Closed adversarial stream fixture");
    }
    physicalCalls++;
    const wire = JSON.parse(String(init.body));
    assert.equal(wire.model, "claude-sonnet-5-5");
    assert.deepEqual(wire.output_config, { effort: "medium" });
    assert.equal(wire.max_tokens, 64);
    assert.equal(wire.stream, true);
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer synthetic-adversarial-oauth"
    );
    const parts = frames();
    if (scenario === "post-terminal") parts.push(event("message_start", { message: {} }));
    if (scenario === "truncated") parts.pop();
    if (scenario === "edge-secret")
      parts.splice(
        3,
        parts.length,
        event("error", {
          error: { type: "authentication_error", message: "sk-ant-PRIVATE-STREAM-CANARY" },
        })
      );
    if (scenario === "invalid-utf8") parts.splice(3, parts.length, new Uint8Array([0xc3, 0x28]));
    const hold = scenario === "hold" || scenario === "stuck-cancel";
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            for (const part of hold ? parts.slice(0, 3) : parts) controller.enqueue(part);
            if (!hold) controller.close();
          },
          cancel() {
            cancellationCalls++;
            if (scenario === "stuck-cancel") return new Promise<void>(() => {});
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    );
  };
  const closedFetch = globalThis.fetch;
  ({ POST } = await import("../../src/app/api/v1/chat/completions/route.ts"));
  assert.equal(globalThis.fetch, closedFetch);
  await updateSettings({
    memoryEnabled: false,
    semanticCacheEnabled: false,
    compressionEnabled: false,
    autoWebSearchEnabled: false,
    webSearchEnabled: false,
    globalFallbackModel: "openai/gpt-5.4",
    streamDefaultMode: "json",
  });
  const connection = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "synthetic-adversarial-account",
    accessToken: "synthetic-adversarial-oauth",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  await createCombo({
    name: model,
    models: ["claude/claude-sonnet-5-5"],
    strategy: "priority",
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        connections: { exact: String(connection.id) },
        policy: {
          version: 1,
          candidates: [
            {
              id: "exact",
              provider: "claude",
              model: "claude-sonnet-5-5",
              endpointKind: "direct",
              evidence: "Synthetic fixture, not live model or account evidence",
              capabilities: {
                text: true,
                tools: false,
                images: false,
                reasoning: true,
                contextTokens: 100000,
              },
              effort: {
                mode: "set",
                value: "medium",
                supported: ["medium"],
                evidence: "Synthetic pair",
              },
            },
          ],
          taskOrder: { explanation: ["exact"] },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: 0,
          maxExecutionAttempts: 1,
          timeoutMs: 5000,
        },
      },
    },
  });
});
beforeEach(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  key = await createApiKey(`synthetic-adversarial-${randomUUID()}`, "synthetic");
  scenario = "normal";
  cancellationCalls = 0;
});
after(async () => {
  globalThis.fetch = originalFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(unexpectedCalls, 0, "no decision, fallback, quota probe or other outbound route");
});

test("independent actual POST preserves one complete receipt and exact selected target", async () => {
  const before = physicalCalls;
  const response = await POST(request());
  const text = await consume(response);
  assert.equal(response.status, 200, text);
  assert.match(text, /Synthetic OK/);
  const row = execution();
  assert.equal(row.application_status, 200);
  assert.equal(row.input_tokens, 8);
  assert.equal(row.output_tokens, 4);
  assert.equal(row.cost_usd, 0.002);
  assert.equal(physicalCalls, before + 1);
});
for (const name of ["post-terminal", "truncated", "invalid-utf8", "edge-secret"]) {
  test(`independent actual POST ${name} remains unknown with no second dispatch`, async () => {
    scenario = name;
    const before = physicalCalls;
    const response = await POST(request());
    const text = await consume(response);
    assert.ok(!text.includes("PRIVATE-STREAM-CANARY"));
    const row = execution();
    assert.ok(Number(row.application_status) >= 400);
    assert.equal(row.input_tokens, 8, "preserve already-reported processed input");
    assert.equal(row.output_tokens, null, "an incomplete stream cannot establish final output");
    assert.equal(row.cost_usd, null);
    assert.equal(physicalCalls, before + 1);
  });
}
test("provider refusal retains known reported usage but application outcome is refusal", async () => {
  scenario = "refusal";
  const before = physicalCalls;
  const response = await POST(request());
  await consume(response);
  const row = execution();
  assert.equal(row.application_status, 422);
  assert.equal(row.cost_usd, 0.002);
  assert.equal(physicalCalls, before + 1);
});
test("a client closing immediately after delivered DONE retains verified successful completion", async () => {
  const before = physicalCalls;
  const response = await POST(request());
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("data: [DONE]")) {
    const next = await reader.read();
    assert.equal(next.done, false, "terminal must be delivered before stream EOF");
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  assert.equal(execution().application_status, 200);
  assert.equal(execution().cost_usd, 0.002);
  assert.equal(physicalCalls, before + 1);
});
test("external reader cancellation has bounded cleanup even when provider cancel never resolves", async () => {
  scenario = "stuck-cancel";
  const before = physicalCalls;
  const response = await POST(request());
  const reader = response.body!.getReader();
  await reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const done = await Promise.race([
      reader.cancel().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    assert.equal(done, true, "consumer cancellation must not await an uncooperative provider");
  } finally {
    if (timer) clearTimeout(timer);
  }
  assert.ok(cancellationCalls > 0);
  assert.equal(execution().application_status, 499);
  assert.equal(execution().cost_usd, null);
  assert.equal(physicalCalls, before + 1);
});
test("a response translator failure cannot turn valid provider billing into application success", async () => {
  const { register, getResponseTranslator } = await import("../../open-sse/translator/registry.ts");
  const { FORMATS } = await import("../../open-sse/translator/formats.ts");
  const original = getResponseTranslator(FORMATS.CLAUDE, FORMATS.OPENAI);
  assert.ok(original);
  let injected = 0;
  register(FORMATS.CLAUDE, FORMATS.OPENAI, undefined, (chunk, state) => {
    if (chunk.type === "content_block_delta") {
      injected++;
      throw new Error("Synthetic translator failure");
    }
    return original(chunk, state);
  });
  const before = physicalCalls;
  try {
    const response = await POST(request());
    await consume(response);
    assert.equal(injected, 1);
    const row = execution();
    assert.ok(Number(row.application_status) >= 400, "lost output must not be reported as success");
    assert.ok(row.cost_usd === null || row.cost_usd === 0.002);
    assert.equal(physicalCalls, before + 1);
  } finally {
    register(FORMATS.CLAUDE, FORMATS.OPENAI, undefined, original);
  }
});
test("unauthenticated streaming request has no provider dispatch", async () => {
  const before = physicalCalls;
  const response = await POST(request(undefined, false));
  await consume(response);
  assert.equal(response.status, 401);
  assert.equal(physicalCalls, before);
  assert.equal(readDecisionAttempts(key.id).length, 0);
});
