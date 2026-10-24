import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, before, after, beforeEach, afterEach } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
process.env.REQUIRE_API_KEY = "true";
process.env.PII_REDACTION_ENABLED = "true";
const {
  createProviderConnection,
  updateProviderConnection,
  resetConnectionBackoff,
  getProviderConnectionById,
} = await import("../../src/lib/db/providers.ts");
const { createCombo, updateCombo } = await import("../../src/lib/db/combos.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance, getDbInstance } = await import("../../src/lib/db/core.ts");
const { readDecisionAttempts, settleDecisionAttempt } =
  await import("../../src/lib/db/decisionAttempts.ts");
const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const { sanitizeReasoningEffortForProvider } =
  await import("../../open-sse/executors/base/reasoningEffort.ts");
const { translateRequest, initTranslators } = await import("../../open-sse/translator/index.ts");
const { resolveClaudeCodeCompatibleEffort } =
  await import("../../open-sse/services/claudeCodeCompatible.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { supportsClaudeMaxEffort } = await import("../../open-sse/config/providerModels.ts");
const { currentApplicationAttempt } =
  await import("../../open-sse/services/decisionPolicy/applicationContext.ts");

// Deliberately fake token; no credential store outside the isolated fixture DB is used.
const access = "sk-ant-oat-synthetic-fixture-not-a-credential";
const sent: Array<Record<string, unknown>> = [];
let key: { id: string; key: string };
let connectionId: string;
let comboId: string;
let fixtureStatus = 200;
let stopReason = "end_turn";
let gate: Promise<void> | null = null;
let fixtureUsage: Record<string, unknown>;
let responseMode = "json";
let unexpectedFetches = 0;
let ordinaryControl = false;
let ordinaryAuxiliaryFetches = 0;
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  sent.push({
    body,
    bearerCorrect: req.headers.authorization === `Bearer ${access}`,
    secondaryKey: req.headers["x-api-key"] ?? req.headers["api-key"] ?? null,
  });
  if (gate) await gate;
  res.writeHead(fixtureStatus, {
    "content-type": responseMode === "sse" ? "text/event-stream" : "application/json",
  });
  if (responseMode !== "json") {
    res.end(responseMode === "sse" ? "data: synthetic\n\n" : "{bad");
    return;
  }
  res.end(
    JSON.stringify(
      fixtureStatus === 200
        ? {
            id: "synthetic-message",
            type: "message",
            role: "assistant",
            model: body.model,
            content: stopReason === "refusal" ? [] : [{ type: "text", text: "synthetic response" }],
            stop_reason: stopReason,
            stop_sequence: null,
            usage: fixtureUsage,
          }
        : { type: "error", error: { type: "authentication_error", message: "synthetic denial" } }
    )
  );
});
const originalFetch = globalThis.fetch;
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  // The real handler/executor/final-send fence retain the canonical destination.
  // Only the test's physical fetch maps it to a local mock; no DNS/TLS to Anthropic occurs.
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const ordinaryAuxiliary = [
      "https://api.anthropic.com/api/claude_cli/bootstrap",
      "https://api.anthropic.com/api/oauth/usage",
    ].includes(url);
    if (
      ordinaryControl &&
      !currentApplicationAttempt() &&
      ordinaryAuxiliary &&
      init?.method === "GET"
    ) {
      ordinaryAuxiliaryFetches++;
      return new Response(
        JSON.stringify({ error: "synthetic ordinary-control auxiliary denial" }),
        { status: 503 }
      );
    }
    if (url !== "https://api.anthropic.com/v1/messages?beta=true" || init?.method !== "POST")
      unexpectedFetches++;
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.method, "POST");
    return proxyFetch(`http://127.0.0.1:${address.port}/v1/messages`, init);
  };
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
        provider: "claude",
        authType: "oauth",
        name: "synthetic-claude-only",
        accessToken: access,
        isActive: true,
        testStatus: "active",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        providerSpecificData: {},
      })
    ).id
  );
  key = (await createApiKey("synthetic-claude-client", "synthetic-machine")) as typeof key;
  comboId = String(
    (
      await createCombo({
        name: "fixture-claude-contract",
        strategy: "priority",
        models: ["claude/claude-opus-5-5"],
        config: {},
      })
    ).id
  );
  await configure();
});
beforeEach(async () => {
  unexpectedFetches = 0;
  ordinaryControl = false;
  fixtureStatus = 200;
  stopReason = "end_turn";
  gate = null;
  responseMode = "json";
  fixtureUsage = {
    input_tokens: 8,
    output_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  };
  await updateProviderConnection(connectionId, {
    accessToken: access,
    refreshToken: "synthetic-refresh-never-used",
    apiKey: null,
    isActive: true,
    testStatus: "active",
    lastError: null,
    lastErrorType: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    providerSpecificData: {},
  });
  await resetConnectionBackoff(connectionId);
  clearAllModelLockouts(); // Each fixture outcome starts from independent synthetic health.
  await configure();
});
afterEach(() => {
  assert.equal(
    unexpectedFetches,
    0,
    "no caught refresh/quota/bootstrap fetch may be hidden by a later success"
  );
});
for (const policy of ["connection", "global"]) {
  test(`queued ${policy} quota-policy change cannot dispatch under stale admission`, async () => {
    const { acquire } = await import("../../open-sse/services/accountSemaphore.ts");
    await updateProviderConnection(connectionId, { maxConcurrent: 1 });
    const release = await acquire(`claude:${connectionId}`, { maxConcurrency: 1 });
    const count = sent.length;
    const pending = POST(request());
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (policy === "connection")
        await updateProviderConnection(connectionId, { quotaWindowThresholds: { session: 20 } });
      else await updateSettings({ resilienceSettings: { quotaPreflight: { enabled: true } } });
      release();
      const response = await pending;
      await response.text();
      assert.equal(response.status, 409);
      assert.equal(sent.length, count);
    } finally {
      release();
      await updateProviderConnection(connectionId, {
        quotaWindowThresholds: null,
        maxConcurrent: null,
      });
      await updateSettings({ resilienceSettings: { quotaPreflight: { enabled: false } } });
    }
  });
}
after(async () => {
  if (process.env.CLAUDE_EVIDENCE_PATH)
    await writeFile(
      process.env.CLAUDE_EVIDENCE_PATH,
      JSON.stringify(
        {
          synthetic: true,
          qualityMeasured: false,
          routingMode: "deterministic",
          nativeSelectorCalled: false,
          ordinaryAuxiliaryFetches,
          dispatches: sent.map((item) => {
            const body = item.body as Record<string, unknown>;
            return {
              model: body.model,
              effort: (body.output_config as Record<string, unknown> | undefined)?.effort,
              stream: body.stream,
              bearerCorrect: item.bearerCorrect,
              secondaryKeyAbsent: item.secondaryKey === null,
            };
          }),
          receipts: readDecisionAttempts(String(key.id)).map((row) =>
            Object.fromEntries(
              [
                "id",
                "provider",
                "model",
                "effort",
                "state",
                "http_status",
                "application_status",
                "input_tokens",
                "output_tokens",
                "uncached_input_tokens",
                "cache_read_tokens",
                "cache_creation_tokens",
                "reasoning_tokens",
                "cost_usd",
                "selection_trace",
              ].map((field) => [field, row[field]])
            )
          ),
        },
        null,
        2
      ) + "\n"
    );
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbInstance();
});
async function configure(model = "claude-opus-5-5", effort = "medium") {
  await updateCombo(comboId, {
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        connections: { chosen: connectionId },
        policy: {
          version: 1,
          candidates: [
            {
              id: "chosen",
              provider: "claude",
              model,
              endpointKind: "direct",
              evidence: "synthetic protocol fixture; no live capability/quality proof",
              capabilities: {
                text: true,
                images: false,
                tools: false,
                reasoning: true,
                contextTokens: 100000,
              },
              effort: {
                mode: "set",
                value: effort,
                supported: [effort],
                evidence: "synthetic exact-pair fixture",
              },
            },
          ],
          taskOrder: {
            explanation: ["chosen"],
            reasoning: ["chosen"],
            complex_code: ["chosen"],
            general: ["chosen"],
          },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: 0,
          maxExecutionAttempts: 1,
          timeoutMs: 2000,
        },
      },
    },
  });
}
function request(
  token: string | null = key.key,
  signal?: AbortSignal,
  extra: Record<string, unknown> = {}
) {
  return new Request("http://application.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal,
    body: JSON.stringify({
      model: "fixture-claude-contract",
      stream: false,
      max_completion_tokens: 4096,
      messages: [{ role: "user", content: "Explain a synthetic fixture" }],
      ...extra,
    }),
  });
}
test("actual handler dispatches exactly the selected Claude Code base model and effort", async () => {
  const count = sent.length;
  const response = await POST(request());
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    `${response.headers.get("x-omniroute-decision-reason")} ${text}`
  );
  assert.equal(sent.length, count + 1);
  const observation = sent.at(-1)!;
  const body = observation.body as Record<string, unknown>;
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal((body.output_config as Record<string, unknown>).effort, "medium");
  assert.equal((body.thinking as Record<string, unknown>).type, "adaptive");
  assert.equal(observation.bearerCorrect, true);
  assert.equal(observation.secondaryKey, null);
  const row = readDecisionAttempts(String(key.id)).at(-1)!;
  assert.equal(row.state, "completed");
  assert.equal(row.input_tokens, 11);
  assert.equal(row.output_tokens, 4);
  assert.equal(row.cache_read_tokens, 2);
  assert.equal(row.cache_creation_tokens, 1);
  assert.equal(row.cost_usd, null);
  assert.equal(row.reasoning_tokens, null);
  assert.equal(row.uncached_input_tokens, 8);
  assert.equal(JSON.parse(text).usage.prompt_tokens, 11);
  assert.equal(JSON.parse(text).usage.completion_tokens, 4);
  assert.equal(JSON.parse(text).usage.cost, null);
});
test("high is distinct and a known reported cost settles once without estimating subscription cost", async () => {
  await configure("claude-opus-5-5", "high");
  fixtureUsage.cost = 0.004;
  const count = sent.length;
  const response = await POST(request());
  assert.equal(response.status, 200, await response.text());
  assert.equal(sent.length, count + 1);
  assert.equal(
    ((sent.at(-1)!.body as Record<string, unknown>).output_config as Record<string, unknown>)
      .effort,
    "high"
  );
  const row = readDecisionAttempts(String(key.id)).at(-1)!;
  assert.equal(row.cost_usd, 0.004);
  const history = getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE decision_attempt_id=?")
    .get(row.id) as { n: number };
  assert.equal(history.n, 1);
  assert.ok(!JSON.stringify(row).includes(access));
  assert.ok(!JSON.stringify(row).includes(key.key));
});
test("client authentication failures dispatch nothing", async () => {
  const count = sent.length;
  for (const token of [null, "synthetic-invalid"]) {
    const response = await POST(request(token));
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.equal(sent.length, count);
});
for (const [model, effort] of [
  ["claude-sonnet-5-5", "max"],
  ["claude-haiku-5-5", "medium"],
  ["claude-opus-5-5", "xhigh"],
  ["claude-unknown", "high"],
]) {
  test(`unadmitted exact pair cannot revive global fallback: ${model}/${effort}`, async () => {
    await configure(model, effort);
    const count = sent.length;
    const response = await POST(request());
    assert.equal(response.status, 409);
    await response.text();
    assert.equal(sent.length, count);
  });
}
for (const status of [401, 403, 429, 503]) {
  test(`provider ${status} remains one physical attempt without refresh or fallback`, async () => {
    fixtureStatus = status;
    const count = sent.length;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, status);
    assert.equal(sent.length, count + 1);
    assert.equal(readDecisionAttempts(String(key.id)).at(-1)!.http_status, status);
  });
}
test("HTTP200 empty refusal retains its terminal meaning and reported usage", async () => {
  stopReason = "refusal";
  const count = sent.length;
  const response = await POST(request());
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.choices[0].finish_reason, "content_filter");
  assert.equal(sent.length, count + 1);
  assert.equal(readDecisionAttempts(String(key.id)).at(-1)!.input_tokens, 11);
});
for (const stop of ["pause_turn", "synthetic_unknown_stop"]) {
  test(`unadmitted provider stop state is not relabeled successful: ${stop}`, async () => {
    stopReason = stop;
    const count = sent.length;
    const response = await POST(request());
    await response.text();
    assert.ok(response.status >= 400);
    assert.equal(sent.length, count + 1);
    const row = readDecisionAttempts(String(key.id)).at(-1)!;
    assert.equal(row.input_tokens, 11);
    assert.equal(row.output_tokens, 4);
    assert.equal(row.http_status, 200);
    assert.ok(Number(row.application_status) >= 400);
  });
}
test("partial usage preserves the uncached component while total and price remain unknown", async () => {
  delete fixtureUsage.cache_creation_input_tokens;
  const response = await POST(request());
  assert.equal(response.status, 200, await response.text());
  const row = readDecisionAttempts(String(key.id)).at(-1)!;
  assert.equal(row.input_tokens, null);
  assert.equal(row.uncached_input_tokens, 8);
  assert.equal(row.cache_read_tokens, 2);
  assert.equal(row.cache_creation_tokens, null);
  assert.equal(row.cost_usd, null);
});
test("reported zero token values remain genuine zero", async () => {
  fixtureUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const response = await POST(request());
  assert.equal(response.status, 200, await response.text());
  const row = readDecisionAttempts(String(key.id)).at(-1)!;
  assert.equal(row.input_tokens, 0);
  assert.equal(row.output_tokens, 0);
  assert.equal(row.cost_usd, null);
});
for (const data of [
  { baseUrl: "https://synthetic.invalid" },
  { quotaPreflightEnabled: true },
  { customHeaders: { "x-fixture-extension": "synthetic" } },
]) {
  test(`unsupported Claude connection settings reject before any provider work: ${Object.keys(data)[0]}`, async () => {
    await updateProviderConnection(connectionId, { providerSpecificData: data });
    const count = sent.length;
    assert.ok(
      Object.keys((await getProviderConnectionById(connectionId))!.providerSpecificData as object)
        .length > 0
    );
    const response = await POST(request());
    assert.equal(response.status, 409);
    await response.text();
    assert.equal(sent.length, count);
  });
}
test("expired OAuth credentials do not refresh or dispatch", async () => {
  await updateProviderConnection(connectionId, {
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const count = sent.length;
  const response = await POST(request());
  assert.equal(response.status, 409);
  await response.text();
  assert.equal(sent.length, count);
});
test("cancellation before dispatch has zero provider calls", async () => {
  const abort = new AbortController();
  abort.abort();
  const count = sent.length;
  const response = await POST(request(key.key, abort.signal));
  await response.text();
  assert.equal(sent.length, count);
  assert.ok(response.status >= 400);
});
test("cancellation after send never falls back and keeps unconfirmed billing unknown", async () => {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abort = new AbortController();
  const count = sent.length;
  const pending = POST(request(key.key, abort.signal));
  try {
    for (let n = 0; sent.length === count && n < 100; n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, count + 1);
    abort.abort();
    const response = await pending;
    await response.text();
    assert.equal(response.status, 499);
    const row = readDecisionAttempts(String(key.id)).at(-1)!;
    assert.equal(row.state, "unknown");
    assert.equal(row.cost_usd, null);
  } finally {
    release();
    gate = null;
  }
  assert.equal(sent.length, count + 1);
});
for (const mode of ["sse", "malformed"]) {
  test(`unexpected ${mode} response is terminal with no second execution`, async () => {
    responseMode = mode;
    const count = sent.length;
    const response = await POST(request());
    await response.text();
    assert.ok(response.status >= 400);
    assert.equal(sent.length, count + 1);
    assert.equal(readDecisionAttempts(String(key.id)).at(-1)!.cost_usd, null);
    if (mode === "sse") assert.equal(readDecisionAttempts(String(key.id)).at(-1)!.state, "unknown");
  });
}
test("current documented exact Claude 5.5 max contracts survive all formatters", () => {
  initTranslators();
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const body = {
      model,
      messages: [{ role: "user", content: "synthetic" }],
      reasoning_effort: "max",
    };
    assert.equal(
      sanitizeReasoningEffortForProvider(body, "claude", model).reasoning_effort,
      "max",
      model
    );
    const formatted = translateRequest("openai", "claude", model, body, false, null, "claude");
    assert.equal(formatted.output_config?.effort, "max", model);
    assert.equal(formatted.thinking?.type, "adaptive", model);
    assert.equal(resolveClaudeCodeCompatibleEffort(body, body, model), "max", model);
  }
});
test("older and unverified Claude family restrictions are not widened", () => {
  for (const model of [
    "claude-haiku-4-5-20251001",
    "claude-haiku-6",
    "claude-sonnet-5-5-unverified",
  ]) {
    assert.equal(supportsClaudeMaxEffort(model), false, model);
  }
});
for (const [label, mutate] of [
  [
    "extra adaptive budget",
    (body: Record<string, unknown>) => {
      body.thinking = { type: "adaptive", budget_tokens: 1234 };
    },
  ],
  [
    "unapproved context management",
    (body: Record<string, unknown>) => {
      body.context_management = { edits: [{ type: "compact_20260112" }] };
    },
  ],
  [
    "nonboolean stream",
    (body: Record<string, unknown>) => {
      body.stream = 1;
    },
  ],
] as const) {
  test(`actual final-send fence rejects ${label}`, async () => {
    const original = DefaultExecutor.prototype.transformRequest;
    DefaultExecutor.prototype.transformRequest = function (...args) {
      const body = original.apply(this, args);
      if (this.provider === "claude") mutate(body as Record<string, unknown>);
      return body;
    };
    const count = sent.length;
    try {
      const response = await POST(request());
      await response.text();
      assert.equal(response.status, 409);
      assert.equal(sent.length, count);
    } finally {
      DefaultExecutor.prototype.transformRequest = original;
    }
  });
}
test("partial Claude receipt survives reopen and late disclosure settles idempotently", async () => {
  delete fixtureUsage.cache_creation_input_tokens;
  const response = await POST(request());
  assert.equal(response.status, 200, await response.text());
  const row = readDecisionAttempts(String(key.id)).at(-1)!;
  const identity = {
    id: String(row.id),
    keyId: String(key.id),
    comboId: String(row.combo_id),
    candidateId: String(row.candidate_id),
    provider: "claude",
    model: String(row.model),
    connectionId,
    effort: String(row.effort),
  };
  const late = {
    status: 200,
    input: 11,
    output: 4,
    uncachedInput: 8,
    cacheRead: 2,
    cacheCreation: 1,
    cost: 0.005,
  };
  // Allow existing asynchronous telemetry to finish before the synthetic DB reopen.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  resetDbInstance();
  assert.equal(
    readDecisionAttempts(String(key.id)).find((item) => item.id === row.id)!.uncached_input_tokens,
    8
  );
  settleDecisionAttempt(identity, late);
  settleDecisionAttempt(identity, late);
  const history = getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE decision_attempt_id=?")
    .get(row.id) as { n: number };
  const ledger = getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM request_cost_ledger WHERE request_id=?")
    .get(row.id) as { n: number };
  assert.equal(history.n, 1);
  assert.equal(ledger.n, 1);
  assert.equal(
    readDecisionAttempts(String(key.id)).find((item) => item.id === row.id)!.cost_usd,
    0.005
  );
});
for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
  test(`ordinary actual handler preserves documented max through the native OAuth formatter: ${model}`, async () => {
    ordinaryControl = true;
    const count = sent.length;
    const response = await POST(
      request(key.key, undefined, { model: `claude/${model}`, reasoning_effort: "max" })
    );
    assert.equal(response.status, 200, await response.text());
    assert.equal(sent.length, count + 1);
    const wire = sent.at(-1)!.body as Record<string, unknown>;
    assert.equal(wire.model, model);
    assert.equal((wire.output_config as Record<string, unknown>).effort, "max");
    assert.equal((wire.thinking as Record<string, unknown>).type, "adaptive");
  });
}
