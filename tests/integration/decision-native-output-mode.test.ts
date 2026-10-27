import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { writeFile } from "node:fs/promises";
import type { Candidate } from "../../open-sse/services/decisionPolicy/contract.ts";

process.env.REQUIRE_API_KEY = "true";
process.env.PII_REDACTION_ENABLED = "true";
const {
  createProviderConnection,
  updateProviderConnection,
  resetConnectionBackoff,
  getProviderConnectionById,
} = await import("../../src/lib/db/providers.ts");
const { createCombo, updateCombo, getComboByName } = await import("../../src/lib/db/combos.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance, getDbInstance } = await import("../../src/lib/db/core.ts");
const { readDecisionAttempts } = await import("../../src/lib/db/decisionAttempts.ts");
const { upsertKeyQuotaLimits, getKeyQuotaStatus } = await import("../../src/lib/db/keyQuota.ts");
const { upsertTokenLimit } = await import("../../src/lib/db/tokenLimits.ts");
const { setBudget } = await import("../../src/domain/costRules.ts");
const { boundedDecisionEnabled } =
  await import("../../open-sse/services/decisionPolicy/applicationGate.ts");
const { NATIVE_DECISION_CODEX_ENDPOINT } =
  await import("../../open-sse/executors/codex/nativeDecision.ts");
const { BOUNDED_AGY_STREAM_URL } = await import("../../open-sse/executors/antigravity/bounded.ts");

type Json = Record<string, unknown>;
type Effort = "medium" | "high" | "xhigh" | "max";
type ResponseMode =
  "valid" | "missing" | "missingReasoning" | "zero" | "refused" | "failed" | "malformed" | "model";
const CODEX = [
  ["codex-luna-max", "gpt-6-luna", "max", true],
  ["codex-56-sol-medium", "gpt-5.6-sol", "medium", false],
  ["codex-6-sol-medium", "gpt-6-sol", "medium", false],
  ["codex-56-sol-high", "gpt-5.6-sol", "high", false],
  ["codex-6-sol-high", "gpt-6-sol", "high", false],
  ["codex-56-sol-xhigh", "gpt-5.6-sol", "xhigh", false],
  ["codex-6-sol-xhigh", "gpt-6-sol", "xhigh", false],
  ["codex-56-sol-max", "gpt-5.6-sol", "max", false],
  ["codex-6-sol-max", "gpt-6-sol", "max", false],
] as const;
function profile(
  id: string,
  provider: string,
  model: string,
  value: Effort,
  fixed = false
): Candidate {
  return {
    id,
    provider,
    model,
    endpointKind: "direct",
    evidence: "Synthetic original-pool profile; not account or capability verification",
    capabilities: {
      text: true,
      images: false,
      tools: false,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: {
      mode: fixed ? "fixed" : "set",
      value,
      supported: [value],
      evidence: "Synthetic fixture preserves the original declared effort exactly",
    },
  };
}
const codex = CODEX.map(([id, model, effort, fixed]) => profile(id, "codex", model, effort, fixed));
const opus = profile("agy-opus46-high", "agy", "claude-opus-4-6-thinking", "high", true);
const gemini = profile("agy-gemini38-high", "agy", "gemini-3.8-flash-high", "high", true);
const claude = ["opus", "sonnet", "haiku"].flatMap((family) =>
  (["medium", "high", "xhigh", "max"] as const).map((effort) =>
    profile(`claude-${family}55-${effort}`, "claude", `claude-${family}-5-5`, effort)
  )
);
const originalPool = [...codex, opus, gemini, ...claude];
const alternate = claude.find((candidate) => candidate.id === "claude-haiku55-medium")!;
const DECISION_URL = "https://opencode.ai/inference/systemone/v1/systemone";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages?beta=true";
const MODEL = "synthetic-provider-native-output-combo";
const SECRET_MARKER = "synthetic-private-prompt-must-not-enter-trace";
const QUOTA_MARKER = "synthetic-native-quota-metadata-not-client-content";
const ACCESS = {
  codex: "synthetic-native-output-codex-access",
  agy: "synthetic-native-output-agy-access",
  claude: "synthetic-native-output-claude-access",
  selector: "synthetic-native-output-free-selector",
};
const originalFetch = globalThis.fetch;
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let comboId: string;
const connections: Record<string, string> = {};
let chosen: Candidate = codex[0];
let decisions = 0;
let lastDecisionState = "";
let executions = 0;
let unexpected = 0;
let upstreamStatus = 200;
let decisionStatus = 200;
let responseMode: ResponseMode = "valid";
let decisionMode: "valid" | "refused" | "malformed" = "valid";
let afterDecision: (() => Promise<void> | void) | undefined;
let afterExecution: (() => void) | undefined;
let quotaMetadata = false;
let holdAfterTerminal = false;
let upstreamCancelled = 0;
let lastWire: Json | undefined;
let lastHeaders: Headers | undefined;
let offered: string[] = [];
let expectedPool = structuredClone(originalPool);
let expectedOrder: string[] = [];
const evidence: Json[] = [];

function nativeEvents(model: string): string {
  const id = "synthetic-native-response";
  const message = {
    id: "synthetic-native-message",
    type: "message",
    role: "assistant",
    status: "completed",
    content:
      responseMode === "refused"
        ? [{ type: "refusal", refusal: `Synthetic refusal ${ACCESS.codex}` }]
        : [{ type: "output_text", text: "Synthetic native output", annotations: [] }],
  };
  const base = { id, object: "response", model, status: "in_progress", output: [] };
  const terminal = {
    ...base,
    model: responseMode === "model" ? "synthetic-wrong-model" : model,
    status: responseMode === "failed" ? "failed" : "completed",
    output: [message],
    ...(responseMode === "missing"
      ? {}
      : {
          usage: {
            input_tokens: responseMode === "zero" ? 0 : 8,
            output_tokens: responseMode === "zero" ? 0 : 4,
            total_tokens: responseMode === "zero" ? 0 : 12,
            input_tokens_details: { cached_tokens: 0 },
            ...(responseMode === "missingReasoning"
              ? {}
              : { output_tokens_details: { reasoning_tokens: responseMode === "zero" ? 0 : 2 } }),
            // Undocumented OAuth cost must not become a claimed provider bill.
            cost: 9,
          },
        }),
    ...(responseMode === "failed"
      ? { error: { code: "synthetic_failure", message: `Synthetic failure ${ACCESS.codex}` } }
      : {}),
  };
  if (responseMode === "malformed") return "data: not-json\n\n";
  const progress = ["valid", "missing", "missingReasoning", "zero"].includes(responseMode)
    ? [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          item_id: message.id,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: message.id,
          delta: "Synthetic native output",
        },
        {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          item_id: message.id,
          text: "Synthetic native output",
        },
        {
          type: "response.content_part.done",
          output_index: 0,
          content_index: 0,
          item_id: message.id,
          part: message.content[0],
        },
        { type: "response.output_item.done", output_index: 0, item: message },
      ]
    : [];
  return [
    ...(quotaMetadata
      ? [
          {
            type: "codex.rate_limits",
            rate_limits: {
              limit_name: QUOTA_MARKER,
              primary: { used_percent: 10, window_minutes: 5, resets_at: 1900000000 },
            },
          },
        ]
      : []),
    { type: "response.created", response: base },
    ...progress,
    { type: `response.${terminal.status}`, response: terminal },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
function claudeEvents(model: string): string {
  return [
    {
      type: "message_start",
      message: {
        id: "synthetic-native-claude",
        type: "message",
        model,
        role: "assistant",
        content: [],
        usage: { input_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Synthetic native output" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4, cost: 0 },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
function agyEvents(model: string): string {
  return `data: ${JSON.stringify({
    response: {
      modelVersion: model,
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Synthetic native output" }] },
          finishReason: "STOP",
        },
      ],
      ...(responseMode === "missing"
        ? {}
        : {
            usageMetadata: {
              promptTokenCount: responseMode === "zero" ? 0 : 8,
              candidatesTokenCount: responseMode === "zero" ? 0 : 2,
              thoughtsTokenCount: responseMode === "zero" ? 0 : 2,
              totalTokenCount: responseMode === "zero" ? 0 : 12,
            },
          }),
    },
  })}\n\n`;
}

before(async () => {
  assert.equal(originalPool.length, 23);
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      init.method !== "POST" ||
      ![DECISION_URL, NATIVE_DECISION_CODEX_ENDPOINT, BOUNDED_AGY_STREAM_URL, CLAUDE_URL].includes(
        url
      )
    ) {
      unexpected++;
      throw new Error("Closed native-output fixture rejects ancillary and substitute dispatch");
    }
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    if (url === DECISION_URL) {
      decisions++;
      lastDecisionState = body.state;
      assert.equal(headers.get("authorization"), `Bearer ${ACCESS.selector}`);
      assert.equal(body.model, "jev-1.13-free");
      offered = Object.keys(body.questions.route.criteria);
      assert.ok(offered.includes(chosen.id));
      await afterDecision?.();
      if (decisionStatus !== 200)
        return Response.json(
          { error: { message: "Synthetic decision access failure" } },
          { status: decisionStatus }
        );
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route:
            decisionMode === "refused"
              ? { type: "refusal" }
              : {
                  type: "choice",
                  choice: chosen.id,
                  confidence: 1,
                  probabilities:
                    decisionMode === "malformed"
                      ? { invented: 1 }
                      : Object.fromEntries(offered.map((id) => [id, id === chosen.id ? 1 : 0])),
                },
        },
        usage: { input_tokens: 7, output_tokens: 1, cost: 0 },
      });
    }
    executions++;
    lastWire = body;
    lastHeaders = headers;
    assert.equal(body.model, chosen.model);
    assert.equal(
      headers.get("authorization"),
      `Bearer ${ACCESS[chosen.provider as keyof typeof ACCESS]}`
    );
    if (chosen.provider === "codex") {
      assert.equal(url, NATIVE_DECISION_CODEX_ENDPOINT);
      assert.equal(headers.get("user-agent"), "OmniRoute-Codex/1.0");
      assert.equal(headers.get("chatgpt-account-id"), "synthetic-workspace");
      assert.equal(body.reasoning.effort, chosen.effort.value);
      for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
        assert.equal(body[field], undefined);
    } else if (chosen.provider === "agy") {
      assert.equal(url, BOUNDED_AGY_STREAM_URL);
      assert.equal(headers.get("user-agent"), "OmniRoute-Antigravity/1.0");
      assert.equal(body.project, "synthetic-project");
      if (chosen.model === opus.model) {
        assert.deepEqual(body.request.generationConfig, { topK: 40, topP: 1 });
      } else {
        assert.equal(body.request.generationConfig.maxOutputTokens, 64);
        assert.equal(body.request.generationConfig.thinkingConfig.thinkingLevel, "high");
      }
    } else {
      assert.equal(url, CLAUDE_URL);
      assert.equal(body.max_tokens, 64);
      assert.equal(body.output_config.effort, chosen.effort.value);
    }
    afterExecution?.();
    if (upstreamStatus !== 200)
      return Response.json(
        {
          error: {
            message: `Synthetic native access failure ${ACCESS[chosen.provider as keyof typeof ACCESS]}`,
          },
          usage: { cost: 123, prompt_tokens: 8, completion_tokens: 4 },
        },
        { status: upstreamStatus }
      );
    const text =
      chosen.provider === "codex"
        ? nativeEvents(chosen.model)
        : chosen.provider === "agy"
          ? agyEvents(chosen.model)
          : claudeEvents(chosen.model);
    const bodyStream = holdAfterTerminal
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
          },
          cancel() {
            upstreamCancelled++;
          },
        })
      : text;
    return new Response(bodyStream, { headers: { "content-type": "text/event-stream" } });
  };
  ({ POST } = await import("../../src/app/api/v1/chat/completions/route.ts"));
  await updateSettings({
    memoryEnabled: false,
    semanticCacheEnabled: false,
    compressionEnabled: false,
    autoWebSearchEnabled: false,
    webSearchEnabled: false,
    streamDefaultMode: "json",
    globalFallbackModel: "openai/gpt-5.4",
  });
  for (const provider of ["codex", "agy", "claude"] as const) {
    connections[provider] = String(
      (
        await createProviderConnection({
          provider,
          authType: "oauth",
          name: `synthetic-native-output-${provider}`,
          accessToken: ACCESS[provider],
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          isActive: true,
          testStatus: "active",
          providerSpecificData:
            provider === "codex"
              ? { workspaceId: "synthetic-workspace" }
              : provider === "agy"
                ? { projectId: "synthetic-project" }
                : {},
        })
      ).id
    );
  }
  connections.selector = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-native-output-selector",
        apiKey: ACCESS.selector,
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "synthetic-native-output-prohibited-fallback",
    apiKey: "synthetic-prohibited-fallback",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  comboId = String(
    (await createCombo({ name: MODEL, strategy: "priority", models: [], config: {} })).id
  );
});

beforeEach(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
  clearAllModelLockouts();
  key = await createApiKey("synthetic-native-output-client", "synthetic");
  decisions = executions = unexpected = 0;
  lastDecisionState = "";
  upstreamStatus = decisionStatus = 200;
  responseMode = "valid";
  decisionMode = "valid";
  quotaMetadata = holdAfterTerminal = false;
  upstreamCancelled = 0;
  afterDecision = afterExecution = undefined;
  lastWire = undefined;
  lastHeaders = undefined;
  offered = [];
  for (const provider of ["codex", "agy", "claude"] as const) {
    await updateProviderConnection(connections[provider], {
      accessToken: ACCESS[provider],
      isActive: true,
      testStatus: "active",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      lastError: null,
      lastErrorType: null,
      lastErrorAt: null,
      lastErrorSource: null,
      errorCode: null,
      rateLimitedUntil: null,
      backoffLevel: 0,
      providerSpecificData:
        provider === "codex"
          ? { workspaceId: "synthetic-workspace" }
          : provider === "agy"
            ? { projectId: "synthetic-project" }
            : {},
    });
    await resetConnectionBackoff(connections[provider]);
    (await import("../../src/sse/services/oauthAuthFailureBackoff.ts")).resetStreak(
      connections[provider]
    );
  }
  await configure(codex[0]);
});
afterEach(async (context) => {
  assert.equal(
    unexpected,
    0,
    "No bootstrap, usage read, refresh, account rotation or global fallback"
  );
  const stored = (await getComboByName(MODEL))!;
  const policy = (
    stored.config as {
      decisionPolicy: { policy: { candidates: Candidate[]; taskOrder: { explanation: string[] } } };
    }
  ).decisionPolicy.policy;
  assert.deepEqual(
    policy.candidates,
    expectedPool,
    "All23 original identities/efforts remain stored unchanged"
  );
  assert.deepEqual(policy.taskOrder.explanation, expectedOrder);
  assert.equal(policy.candidates.length, 23);
  const receipts = readDecisionAttempts(key.id);
  for (const row of receipts) {
    assert.equal(String(row.selection_trace).includes(SECRET_MARKER), false);
    for (const value of Object.values(ACCESS))
      assert.equal(JSON.stringify(row).includes(value), false);
  }
  evidence.push({
    test: context.name,
    synthetic: true,
    decisions,
    executions,
    unexpected,
    offered: [...offered],
    chosen: chosen.id,
    storedPoolCount: policy.candidates.length,
    receipts: receipts.map((row) => ({
      lane: row.lane,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      state: row.state,
      status: row.http_status,
      applicationStatus: row.application_status,
      input: row.input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      cost: row.cost_usd,
    })),
  });
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (process.env.NATIVE_EVIDENCE_PATH)
    await writeFile(process.env.NATIVE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
});

async function configure(target: Candidate, patch: Json = {}, order?: string[]) {
  chosen = target;
  expectedPool = structuredClone(originalPool);
  expectedOrder = order ?? [target.id, target.id === alternate.id ? codex[0].id : alternate.id];
  await updateCombo(comboId, {
    models: originalPool.map((candidate) => `${candidate.provider}/${candidate.model}`),
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "provider-native-output-v1",
        nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64 },
        selection: {
          mode: "native",
          provider: "opencode-zen",
          model: "jev-1.13-free",
          connectionId: connections.selector,
          timeoutMs: 1000,
        },
        connections: Object.fromEntries(
          originalPool.map((candidate) => [candidate.id, connections[candidate.provider]])
        ),
        policy: {
          version: 1,
          candidates: originalPool,
          taskOrder: { explanation: expectedOrder },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: 1,
          maxExecutionAttempts: 1,
          timeoutMs: 5000,
        },
        ...patch,
      },
    },
  });
}
function request(patch: Json = {}, signal?: AbortSignal, token: string | null = key.key) {
  return new Request("http://application.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: `Explain a synthetic lamp. ${SECRET_MARKER}` }],
      stream: true,
      stream_options: { include_usage: true },
      ...patch,
    }),
  });
}
async function consume(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "stream rejected";
  }
}
async function expectRejected(
  patch: Json = {},
  signal?: AbortSignal,
  token: string | null = key.key
) {
  const response = await POST(request(patch, signal, token));
  await consume(response);
  assert.notEqual(response.status, 200);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
  assert.equal(readDecisionAttempts(key.id).length, 0);
}
async function expectSuccess(target: Candidate, order?: string[]) {
  await configure(target, {}, order);
  const { resolveApplicationProvider } =
    await import("../../src/lib/decisionPolicy/applicationProvider.ts");
  const row = await getProviderConnectionById(connections[target.provider]);
  assert.ok(row);
  try {
    resolveApplicationProvider(target, row, true);
  } catch (error) {
    const message =
      error instanceof Error && /^decision_[a-z_]+$/.test(error.message)
        ? error.message
        : "unclassified";
    throw new Error(
      `Synthetic prepared-provider precondition rejected: ${message}; metadata keys ${Object.keys(row.providerSpecificData ?? {}).join(",")}`
    );
  }
  const response = await POST(request());
  const text = await consume(response);
  assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? text);
  assert.equal(response.headers.get("x-omniroute-output-policy"), "provider-native");
  assert.equal(response.headers.get("x-omniroute-output-limit-enforced"), "false");
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "native");
  assert.match(text, /Synthetic native output/);
  assert.equal(text.includes(QUOTA_MARKER), false);
  assert.equal(text.includes("codex.rate_limits"), false);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  assert.ok(lastWire);
  assert.ok(lastHeaders);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 2);
  const selector = rows.find((row) => row.lane === "decision")!;
  const execution = rows.find((row) => row.lane === "execution")!;
  assert.equal(selector.cost_usd, 0, "Reported synthetic decision zero stays zero");
  assert.equal(execution.provider, target.provider);
  assert.equal(execution.model, target.model);
  assert.equal(execution.effort, target.effort.value);
  assert.equal(execution.connection_id, connections[target.provider]);
  assert.equal(execution.state, "completed");
  assert.equal(execution.application_status, 200, text);
  assert.equal(execution.input_tokens, 8);
  assert.equal(execution.output_tokens, 4);
  assert.equal(execution.reasoning_tokens, target.provider === "claude" ? null : 2);
  assert.equal(execution.cost_usd, target.provider === "claude" ? 0 : null);
}

for (const consent of [null, "task-text", "Task-Text", "task-text, task-text"]) {
  test(`native-output task context requires exact client consent=${consent}`, async () => {
    await configure(codex[0], {
      selection: {
        mode: "native",
        provider: "opencode-zen",
        model: "jev-1.13-free",
        connectionId: connections.selector,
        timeoutMs: 1000,
        decisionContext: {
          mode: "task-text",
          acknowledgeExternalTransmission: true,
          maxChars: 1024,
        },
      },
    });
    const original = request({
      messages: [
        { role: "system", content: "SYNTHETIC_SYSTEM_NEVER_DISCLOSE" },
        { role: "user", content: `Explain a synthetic lamp. ${SECRET_MARKER}` },
      ],
    });
    const headers = new Headers(original.headers);
    if (consent !== null) headers.set("x-omniroute-decision-context", consent);
    const response = await POST(
      new Request(original.url, { method: "POST", headers, body: await original.text() })
    );
    await consume(response);
    assert.equal(response.status, 200);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.deepEqual(
      JSON.parse(lastDecisionState).taskContext,
      consent === "task-text"
        ? { version: "latest-user-v1", text: `Explain a synthetic lamp. ${SECRET_MARKER}` }
        : undefined
    );
    assert.ok(!lastDecisionState.includes("SYNTHETIC_SYSTEM_NEVER_DISCLOSE"));
  });
}

test("oversized consented task stops before any physical native decision or execution", async () => {
  await configure(codex[0], {
    selection: {
      mode: "native",
      provider: "opencode-zen",
      model: "jev-1.13-free",
      connectionId: connections.selector,
      timeoutMs: 1000,
      decisionContext: {
        mode: "task-text",
        acknowledgeExternalTransmission: true,
        maxChars: 10,
      },
    },
  });
  const original = request();
  const headers = new Headers(original.headers);
  headers.set("x-omniroute-decision-context", "task-text");
  const response = await POST(
    new Request(original.url, { method: "POST", headers, body: await original.text() })
  );
  assert.equal(response.status, 409);
  await consume(response);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
});

for (const candidate of [...codex, opus])
  test(`actual handler native output executes original ${candidate.id} once without a wire cap`, async () => {
    await expectSuccess(candidate);
  });
test("actual selector can inspect all23 original eligible choices in the distinct native-output mode", async () => {
  await expectSuccess(
    codex[0],
    originalPool.map((candidate) => candidate.id)
  );
  assert.equal(offered.length, 23);
  assert.deepEqual(new Set(offered), new Set(originalPool.map((candidate) => candidate.id)));
});
for (const candidate of [...claude, gemini])
  test(`native-output mode retains the existing finite ${candidate.id} contract using the explicit planning allowance`, async () => {
    await expectSuccess(candidate);
  });

for (const field of ["max_tokens", "max_completion_tokens"])
  for (const value of [64, 1, null])
    test(`caller ${field}=${value} is rejected instead of silently discarded`, async () => {
      await expectRejected({ [field]: value });
    });
for (const output of [
  undefined,
  { contextOutputTokens: 64 },
  { acknowledgeNoTokenCeiling: false, contextOutputTokens: 64 },
  { acknowledgeNoTokenCeiling: true, contextOutputTokens: 0 },
  { acknowledgeNoTokenCeiling: true, contextOutputTokens: 1000001 },
])
  test(`missing or invalid explicit native-output acknowledgement/planning rejects ${JSON.stringify(output)}`, async () => {
    await configure(codex[0], { nativeOutput: output });
    await expectRejected();
  });
test("bounded mode does not infer native output from a request omitting its ceiling", async () => {
  await configure(codex[0], { applicationMode: "bounded-v1", nativeOutput: undefined });
  await expectRejected();
});
test("disabled stored policy is not recognized as native application activation", async () => {
  await configure(codex[0], { enabled: false });
  assert.equal(boundedDecisionEnabled(await getComboByName(MODEL)), false);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
});
test("client cannot activate native output through request fields", async () => {
  await expectRejected({
    applicationMode: "provider-native-output-v1",
    nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64 },
  });
});
test("native output requires authentication before either stage", async () => {
  await expectRejected({}, undefined, null);
});
for (const patch of [
  { stream: false, stream_options: undefined },
  {
    tools: [{ type: "function", function: { name: "synthetic", parameters: { type: "object" } } }],
  },
  { temperature: 0 },
])
  test(`unsupported native request cannot escape its text-only contract ${JSON.stringify(patch)}`, async () => {
    await expectRejected(patch);
  });
test("explicit client effort cannot be rewritten to the fixed Luna Max profile", async () => {
  await configure(codex[0], {}, [codex[0].id]);
  await expectRejected({ reasoning_effort: "medium" });
});

for (const scope of ["global", "provider", "model"] as const)
  test(`native output preserves ${scope} token cap rejection`, async () => {
    await configure(codex[0], {}, [codex[0].id]);
    upsertTokenLimit({
      apiKeyId: key.id,
      scopeType: scope,
      scopeValue: scope === "provider" ? "codex" : scope === "model" ? codex[0].model : "",
      tokenLimit: 100000,
    });
    await expectRejected();
  });
for (const limits of [{ tpmLimit: 100000 }, { monthlyAmountUsd: 100 }])
  test(`native output preserves key quota cap rejection ${JSON.stringify(limits)}`, async () => {
    upsertKeyQuotaLimits(key.id, limits);
    await expectRejected();
  });
test("native output preserves monetary budget rejection", async () => {
  setBudget(key.id, { dailyLimitUsd: 100 });
  await expectRejected();
});

for (const candidate of [codex[0], opus])
  for (const status of [401, 403, 429, 503])
    test(`native ${candidate.provider} execution HTTP${status} stops once and ignores foreign chat cost/usage`, async () => {
      await configure(candidate);
      upstreamStatus = status;
      const response = await POST(request());
      const text = await consume(response);
      assert.equal(response.status, status);
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
      for (const value of Object.values(ACCESS))
        assert.equal(
          text.includes(value),
          false,
          "Known synthetic credentials cannot enter public errors"
        );
      const rows = readDecisionAttempts(key.id).filter((row) => row.lane === "execution");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].http_status, status);
      assert.equal(rows[0].cost_usd, null);
      assert.equal(rows[0].input_tokens, null);
      assert.equal(rows[0].output_tokens, null);
    });
for (const mode of ["refused", "failed", "malformed", "model"] as const)
  test(`native terminal ${mode} never settles as application success or retries`, async () => {
    responseMode = mode;
    const response = await POST(request());
    const text = await consume(response);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    for (const value of Object.values(ACCESS))
      assert.equal(
        text.includes(value),
        false,
        "Native refusal/failure must not expose known credentials"
      );
    const row = readDecisionAttempts(key.id).find((value) => value.lane === "execution")!;
    assert.ok(row);
    assert.notEqual(row.application_status, 200);
    assert.equal(row.cost_usd, null);
  });
for (const mode of ["missing", "zero"] as const)
  test(`native ${mode} usage remains distinct while undocumented OAuth cost stays unknown`, async () => {
    responseMode = mode;
    const response = await POST(request());
    await consume(response);
    assert.equal(response.status, 200);
    assert.equal(executions, 1);
    const row = readDecisionAttempts(key.id).find((value) => value.lane === "execution")!;
    assert.equal(row.application_status, 200);
    for (const field of ["input_tokens", "output_tokens", "reasoning_tokens"])
      assert.equal(row[field], mode === "zero" ? 0 : null);
    assert.equal(row.cost_usd, null);
  });
for (const status of [401, 403, 429])
  test(`native decision HTTP${status} cannot trigger execution or decision-provider rotation`, async () => {
    decisionStatus = status;
    const response = await POST(request());
    await consume(response);
    assert.notEqual(response.status, 200);
    assert.equal(decisions, 1);
    assert.equal(executions, 0);
    assert.equal(readDecisionAttempts(key.id).filter((row) => row.lane === "execution").length, 0);
  });
for (const mode of ["refused", "malformed"] as const)
  test(`native ${mode} decision cannot authorize execution`, async () => {
    decisionMode = mode;
    const response = await POST(request());
    await consume(response);
    assert.notEqual(response.status, 200);
    assert.equal(decisions, 1);
    assert.equal(executions, 0);
  });
test("cancellation before admission has zero stages", async () => {
  const controller = new AbortController();
  controller.abort();
  await expectRejected({}, controller.signal);
});
test("cancellation after decision cannot start execution", async () => {
  const controller = new AbortController();
  afterDecision = () => controller.abort();
  const response = await POST(request({}, controller.signal));
  await consume(response);
  assert.notEqual(response.status, 200);
  assert.equal(decisions, 1);
  assert.equal(executions, 0);
});
test("cancellation after physical execution cannot start a retry or fallback", async () => {
  const controller = new AbortController();
  afterExecution = () => controller.abort();
  const response = await POST(request({}, controller.signal));
  await consume(response);
  assert.notEqual(response.status, 200);
  assert.equal(decisions, 1);
  assert.equal(executions, 1);
  const row = readDecisionAttempts(key.id).find((value) => value.lane === "execution")!;
  assert.notEqual(row.application_status, 200);
  assert.equal(row.cost_usd, null);
});
test("a financial cap installed after selection is rechecked before execution", async () => {
  afterDecision = () => {
    upsertKeyQuotaLimits(key.id, { monthlyAmountUsd: 1 });
  };
  const response = await POST(request());
  await consume(response);
  assert.notEqual(response.status, 200);
  assert.equal(decisions, 1);
  assert.equal(executions, 0);
});
test("a queued output-policy revision cannot reuse prepared dispatch authority", async () => {
  afterDecision = async () => {
    const combo = (await getComboByName(MODEL))!;
    const config = structuredClone(combo.config) as { decisionPolicy: Json };
    config.decisionPolicy.nativeOutput = {
      acknowledgeNoTokenCeiling: true,
      contextOutputTokens: 128,
    };
    await updateCombo(comboId, { config });
  };
  const response = await POST(request());
  await consume(response);
  assert.notEqual(response.status, 200);
  assert.equal(decisions, 1);
  assert.equal(executions, 0);
});

test("native quota metadata stays private and valid terminal cancels a never-ending upstream", async () => {
  quotaMetadata = true;
  holdAfterTerminal = true;
  await expectSuccess(codex[0]);
  assert.ok(
    upstreamCancelled >= 1,
    "Completed native evidence must release the underlying stream without waiting for socket close"
  );
});
test("missing Codex reasoning preserves raw total output but never invents visible output or double bills TPM", async () => {
  responseMode = "missingReasoning";
  await configure(codex[0], {}, [codex[0].id]);
  const response = await POST(request());
  const text = await consume(response);
  assert.equal(response.status, 200, text);
  assert.equal(decisions, 0);
  assert.equal(executions, 1);
  const row = readDecisionAttempts(key.id).find((value) => value.lane === "execution")!;
  assert.equal(row.application_status, 200);
  assert.equal(row.input_tokens, 8);
  assert.equal(row.output_tokens, 4);
  assert.equal(row.reasoning_tokens, null);
  assert.equal(row.cost_usd, null);
  const history = getDbInstance()
    .prepare(
      "SELECT tokens_input,tokens_output,tokens_reasoning FROM usage_history WHERE decision_attempt_id=?"
    )
    .get(row.id) as {
    tokens_input: number | null;
    tokens_output: number | null;
    tokens_reasoning: number | null;
  };
  assert.ok(history);
  assert.equal(history.tokens_input, 8);
  assert.equal(history.tokens_output, null);
  assert.equal(history.tokens_reasoning, null);
  assert.equal(getKeyQuotaStatus(key.id).counters.tpmUsed, 12);
});

function mutateNativeWire(wire: Json, provider: string, mutation: string): void {
  if (mutation === "model") wire.model = "synthetic-substitute-model";
  else if (mutation === "project") wire.project = "synthetic-substitute-project";
  else if (provider === "codex") {
    if (mutation === "cap") wire.max_completion_tokens = 64;
    else (wire.reasoning as Json).effort = "high";
  } else {
    const generation = (wire.request as { generationConfig: Json }).generationConfig;
    if (mutation === "cap") generation.maxOutputTokens = 64;
    else generation.thinkingConfig = { thinkingLevel: "high" };
  }
}
async function expectLateFenceRejection(): Promise<void> {
  const response = await POST(request());
  await consume(response);
  assert.equal(response.status, 409);
  assert.equal(decisions, 1);
  assert.equal(executions, 0, "Changed final serialization cannot become a physical call");
  const execution = readDecisionAttempts(key.id).find((row) => row.lane === "execution");
  assert.ok(execution);
  assert.equal(execution.state, "cancelled");
  assert.equal(execution.cost_usd, 0, "An unstarted attempt is distinct from unknown remote usage");
}
for (const candidate of [codex[1], opus])
  for (const mutation of ["model", "cap", "effort"])
    test(`late ${candidate.provider} ${mutation} wire injection is rejected before physical dispatch`, async () => {
      await configure(candidate);
      if (candidate.provider === "codex") {
        const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
        const original = CodexExecutor.prototype.transformRequest;
        CodexExecutor.prototype.transformRequest = async function (...args) {
          const wire = await original.apply(this, args);
          assert.ok(!(wire instanceof Response));
          mutateNativeWire(wire as Json, candidate.provider, mutation);
          return wire;
        };
        try {
          await expectLateFenceRejection();
        } finally {
          CodexExecutor.prototype.transformRequest = original;
        }
      } else {
        const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
        const original = AntigravityExecutor.prototype.transformRequest;
        AntigravityExecutor.prototype.transformRequest = async function (...args) {
          const wire = await original.apply(this, args);
          assert.ok(!(wire instanceof Response));
          mutateNativeWire(wire as unknown as Json, candidate.provider, mutation);
          return wire;
        };
        try {
          await expectLateFenceRejection();
        } finally {
          AntigravityExecutor.prototype.transformRequest = original;
        }
      }
    });
test("late AGY project injection cannot change the selected fixed-profile account", async () => {
  await configure(opus);
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
  const original = AntigravityExecutor.prototype.transformRequest;
  AntigravityExecutor.prototype.transformRequest = async function (...args) {
    const wire = await original.apply(this, args);
    assert.ok(!(wire instanceof Response));
    mutateNativeWire(wire as unknown as Json, "agy", "project");
    return wire;
  };
  try {
    await expectLateFenceRejection();
  } finally {
    AntigravityExecutor.prototype.transformRequest = original;
  }
});
for (const header of ["User-Agent", "chatgpt-account-id"])
  test(`late Codex ${header} injection cannot bypass exact truthful identity`, async () => {
    await configure(codex[0]);
    const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
    const original = CodexExecutor.prototype.buildHeaders;
    CodexExecutor.prototype.buildHeaders = function (...args) {
      return { ...original.apply(this, args), [header]: "synthetic-rejected-header" };
    };
    try {
      await expectLateFenceRejection();
    } finally {
      CodexExecutor.prototype.buildHeaders = original;
    }
  });
test("late AGY application-identity injection cannot reach the provider", async () => {
  await configure(opus);
  const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
  const original = AntigravityExecutor.prototype.buildHeaders;
  AntigravityExecutor.prototype.buildHeaders = function (...args) {
    return { ...original.apply(this, args), "User-Agent": "synthetic-rejected-header" };
  };
  try {
    await expectLateFenceRejection();
  } finally {
    AntigravityExecutor.prototype.buildHeaders = original;
  }
});
test("in-place translator transcript mutation cannot change the immutable prepared original", async () => {
  await configure(codex[0]);
  const { getRequestTranslator, register } = await import("../../open-sse/translator/registry.ts");
  const original = getRequestTranslator("openai", "openai-responses");
  assert.ok(original);
  const changedContent = "Synthetic unauthorized translator transcript change";
  let changed = false;
  register("openai", "openai-responses", (model, body, stream, credentials) => {
    assert.ok(Array.isArray(body.messages));
    const message = (body.messages as Json[]).find((row) => row.role === "user");
    assert.ok(message);
    assert.equal(typeof message.content, "string");
    message.content = changedContent;
    changed = true;
    return original(model, body, stream, credentials);
  });
  const input = request();
  const originalInput = input.clone();
  try {
    const response = await POST(input);
    await consume(response);
    assert.equal(changed, true, "The real request entered the registered translator");
    assert.equal(response.status, 409);
    assert.equal(decisions, 1);
    assert.equal(executions, 0, "Changed transcript cannot pass final original-message comparison");
    const callerBytes = await originalInput.text();
    assert.equal(callerBytes.includes(SECRET_MARKER), true);
    assert.equal(callerBytes.includes(changedContent), false);
    const execution = readDecisionAttempts(key.id).find((row) => row.lane === "execution");
    assert.ok(execution);
    assert.equal(execution.state, "cancelled");
    assert.equal(execution.cost_usd, 0);
  } finally {
    register("openai", "openai-responses", original);
  }
});
