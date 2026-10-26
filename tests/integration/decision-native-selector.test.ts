import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, before, beforeEach, after, afterEach } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
const evidence: Array<Record<string, unknown>> = [];
process.env.REQUIRE_API_KEY = "true";
process.env.PII_REDACTION_ENABLED = "true";
const { createProviderConnection, updateProviderConnection, resetConnectionBackoff } =
  await import("../../src/lib/db/providers.ts");
const { createCombo, updateCombo, getComboByName } = await import("../../src/lib/db/combos.ts");
const { createApiKey, updateApiKeyPermissions } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { readDecisionAttempts } = await import("../../src/lib/db/decisionAttempts.ts");
const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const access = "sk-ant-oat-synthetic-fixture-not-a-credential";
const decisionKey = "synthetic-native-decision-key";
// Official-contract synthetic envelopes; no raw observed provider response is replayed.
const decisionBindings = {
  zen: {
    provider: "opencode-zen",
    model: "jev-1.13",
    endpoint: "https://opencode.ai/inference/systemone/v1/systemone",
    credential: decisionKey,
  },
  zenFree: {
    provider: "opencode-zen",
    model: "jev-1.13-free",
    endpoint: "https://opencode.ai/inference/systemone/v1/systemone",
    credential: "synthetic-free-zen-decision-key",
  },
  typesafe: {
    provider: "typesafe",
    model: "jev-1.14.0",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    credential: "synthetic-typesafe-decision-key",
  },
  openrouter: {
    provider: "openrouter",
    model: "typesafe/jev-1.14-20261014",
    endpoint: "https://openrouter.ai/api/v1/systemone",
    credential: "synthetic-openrouter-decision-key",
  },
  vercel: {
    provider: "vercel-ai-gateway",
    model: "typesafe-ai/jev",
    endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    credential: "synthetic-vercel-decision-key",
  },
} as const;
type DecisionBindingName = keyof typeof decisionBindings;
const paidBindings: DecisionBindingName[] = ["typesafe", "openrouter", "vercel"];
const decisionConnections = {} as Record<DecisionBindingName, string>;
let decisionBindingName: DecisionBindingName = "zen";
const currentDecisionBinding = () => decisionBindings[decisionBindingName];
const decisionMetadata = (name: DecisionBindingName) =>
  name === "zenFree" ? { systemOneTier: "free" } : {};
const { SYSTEMONE_USER_AGENT } = await import("../../open-sse/handlers/systemOneTransport.ts");
let failurePayload: Record<string, unknown> | string | null = null;
const decisionUserAgents: string[] = [];
let key: { id: string; key: string };
let executionConnection: string, decisionConnection: string, comboId: string;
let openaiConnection: string;
let chosen = "deep",
  decisionStatus = 200,
  decisionCost: number | null = 0.001;
let decisionGate: Promise<void> | null = null;
let answerMode = "valid",
  unexpected = 0;
let afterDecision: (() => Promise<void>) | null = null;
let largeResponse = false;
let responseModel: string | null = "jev-1.13";
const { getKeyQuotaStatus, upsertKeyQuotaLimits } = await import("../../src/lib/db/keyQuota.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const decisionCalls: Array<Record<string, unknown>> = [],
  executionCalls: Array<Record<string, unknown>> = [];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  res.setHeader("content-type", "application/json");
  if (req.url === "/decision") {
    const binding = currentDecisionBinding();
    assert.equal(req.headers.authorization, `Bearer ${binding.credential}`);
    assert.equal(req.headers["x-api-key"], undefined);
    assert.equal(req.headers["user-agent"], SYSTEMONE_USER_AGENT);
    assert.equal(body.model, binding.model);
    decisionUserAgents.push(String(req.headers["user-agent"]));
    decisionCalls.push(body);
    if (failurePayload !== null) {
      res.statusCode = decisionStatus;
      res.end(typeof failurePayload === "string" ? failurePayload : JSON.stringify(failurePayload));
      return;
    }
    if (decisionGate) await decisionGate;
    const probabilities = chosen === "deep" ? { light: 0.2, deep: 0.8 } : { light: 0.8, deep: 0.2 };
    const answer =
      answerMode === "refused"
        ? { type: "refusal" }
        : {
            type: "choice",
            choice: answerMode === "invented" ? "excluded" : chosen,
            probabilities:
              answerMode === "unknown"
                ? undefined
                : answerMode === "malformed"
                  ? { light: 0.1 }
                  : probabilities,
            confidence: 0.6,
          };
    res.statusCode = decisionStatus;
    res.end(
      JSON.stringify({
        ...(responseModel ? { model: responseModel } : {}),
        answers: { route: answer },
        ...(largeResponse ? { padding: "x".repeat(70000) } : {}),
        usage: {
          input_tokens: 7,
          output_tokens: 2,
          ...(decisionCost === null || ["typesafe", "vercel"].includes(decisionBindingName)
            ? {}
            : { cost: decisionCost }),
        },
        ...(decisionBindingName === "vercel" && decisionCost !== null
          ? { provider_metadata: { gateway: { cost: String(decisionCost) } } }
          : {}),
      })
    );
    return;
  }
  if (req.url === "/openai") {
    assert.equal(req.headers.authorization, "Bearer synthetic-openai-execution-key");
    executionCalls.push(body);
    res.end(
      JSON.stringify({
        id: "synthetic-openai",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "synthetic execution" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.002 },
      })
    );
    return;
  }
  assert.equal(req.url, "/execution");
  assert.equal(req.headers.authorization, `Bearer ${access}`);
  executionCalls.push(body);
  res.end(
    JSON.stringify({
      id: "synthetic-execution",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "synthetic execution" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        cost: 0.002,
      },
    })
  );
});
const oldFetch = globalThis.fetch;
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    let path: string;
    if (url === currentDecisionBinding().endpoint && init?.method === "POST") path = "/decision";
    else if (url === "https://api.anthropic.com/v1/messages?beta=true" && init?.method === "POST")
      path = "/execution";
    else if (
      url === `http://127.0.0.1:${address.port}/v1/chat/completions` &&
      init?.method === "POST"
    )
      path = "/openai";
    else {
      unexpected++;
      throw new Error("synthetic fixture rejects every extra provider fetch");
    }
    const response = await proxyFetch(`http://127.0.0.1:${address.port}${path}`, init);
    if (path === "/decision" && afterDecision) await afterDecision();
    return response;
  };
  await updateSettings({
    semanticCacheEnabled: false,
    memoryEnabled: false,
    compressionEnabled: false,
    globalFallbackModel: "openai/gpt-5.4",
    streamDefaultMode: "json",
  });
  executionConnection = String(
    (
      await createProviderConnection({
        provider: "claude",
        authType: "oauth",
        name: "synthetic-native-execution",
        accessToken: access,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    ).id
  );
  for (const name of Object.keys(decisionBindings) as DecisionBindingName[]) {
    const binding = decisionBindings[name];
    decisionConnections[name] = String(
      (
        await createProviderConnection({
          provider: binding.provider,
          authType: "apikey",
          name: `synthetic-native-selection-${name}`,
          apiKey: binding.credential,
          isActive: true,
          testStatus: "active",
          providerSpecificData: decisionMetadata(name),
        })
      ).id
    );
    if (name !== "zen")
      await createProviderConnection({
        provider: binding.provider,
        authType: "apikey",
        name: `synthetic-unselected-account-${name}`,
        apiKey: `synthetic-unselected-credential-${name}`,
        isActive: true,
        testStatus: "active",
        providerSpecificData: decisionMetadata(name),
      });
  }
  decisionConnection = decisionConnections.zen;
  openaiConnection = String(
    (
      await createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "synthetic-openai-execution",
        apiKey: "synthetic-openai-execution-key",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { baseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions` },
      })
    ).id
  );
  comboId = String(
    (
      await createCombo({
        name: "fixture-native-selector",
        strategy: "priority",
        models: ["claude/claude-opus-5-5"],
        config: {},
      })
    ).id
  );
});
beforeEach(async () => {
  // Each synthetic fixture starts with independent learned quota/queue state.
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  key = (await createApiKey("synthetic-native-client", "synthetic-machine")) as typeof key;
  chosen = "deep";
  decisionStatus = 200;
  answerMode = "valid";
  failurePayload = null;
  decisionGate = null;
  decisionCost = 0.001;
  unexpected = 0;
  afterDecision = null;
  largeResponse = false;
  responseModel = "jev-1.13";
  for (const name of Object.keys(decisionConnections) as DecisionBindingName[]) {
    const connection = decisionConnections[name];
    await updateProviderConnection(connection, {
      isActive: true,
      testStatus: "active",
      maxConcurrent: null,
      providerSpecificData: decisionMetadata(name),
    });
    await resetConnectionBackoff(connection);
  }
  await updateProviderConnection(executionConnection, {
    isActive: true,
    testStatus: "active",
    maxConcurrent: null,
    quotaWindowThresholds: null,
    providerSpecificData: {},
  });
  await resetConnectionBackoff(executionConnection);
  clearAllModelLockouts();
  await configure();
});
afterEach((context) => {
  assert.equal(unexpected, 0, "no caught ancillary fetch may be hidden");
  evidence.push({
    test: context.name,
    synthetic: true,
    fixtureProvenance: "official-contract-synthetic",
    decisionProvider: currentDecisionBinding().provider,
    decisionModel: currentDecisionBinding().model,
    qualityMeasured: false,
    receipts: readDecisionAttempts(key.id),
  });
});
after(async () => {
  if (process.env.NATIVE_EVIDENCE_PATH)
    await writeFile(process.env.NATIVE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  globalThis.fetch = oldFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetDbInstance();
});
async function configure(mode = "native", bindingName: DecisionBindingName = "zen") {
  decisionBindingName = bindingName;
  decisionConnection = decisionConnections[bindingName];
  const binding = currentDecisionBinding();
  responseModel = binding.model;
  const candidate = (id: string, effort: string) => ({
    id,
    provider: "claude",
    model: "claude-opus-5-5",
    endpointKind: "direct",
    evidence: "synthetic-private-config-note",
    capabilities: {
      text: true,
      images: false,
      tools: false,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: { mode: "set", value: effort, supported: [effort], evidence: "private-profile-note" },
  });
  await updateCombo(comboId, {
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        selection:
          mode === "native"
            ? {
                mode: "native",
                provider: binding.provider,
                model: binding.model,
                connectionId: decisionConnection,
                timeoutMs: 500,
              }
            : { mode: "deterministic" },
        connections: { light: executionConnection, deep: executionConnection },
        policy: {
          version: 1,
          candidates: [candidate("light", "medium"), candidate("deep", "high")],
          taskOrder: { explanation: ["light", "deep"], reasoning: ["deep", "light"] },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: mode === "native" ? 1 : 0,
          maxExecutionAttempts: 1,
          timeoutMs: 3000,
        },
      },
    },
  });
}
function request(token: string | null = key.key, signal?: AbortSignal) {
  return new Request("http://application.invalid/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model: "fixture-native-selector",
      stream: false,
      max_completion_tokens: 4096,
      messages: [
        { role: "user", content: "Explain a synthetic native fixture for person@example.invalid" },
      ],
    }),
  });
}
for (const [id, effort] of [
  ["deep", "high"],
  ["light", "medium"],
]) {
  test(`actual handler honors native selected pair ${id}/${effort} with separate receipts`, async () => {
    chosen = id;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    const text = await response.text();
    assert.equal(
      response.status,
      200,
      `${response.headers.get("x-omniroute-decision-reason")} ${text}`
    );
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e + 1);
    assert.equal(response.headers.get("x-omniroute-decision-candidate"), id);
    const wire = executionCalls.at(-1)!;
    assert.equal(wire.model, "claude-opus-5-5");
    assert.equal((wire.output_config as Record<string, unknown>).effort, effort);
    const decision = decisionCalls.at(-1)!;
    const serialized = JSON.stringify(decision);
    assert.ok(!serialized.includes("private-profile-note"));
    assert.ok(!serialized.includes("synthetic-private-config-note"));
    assert.ok(!serialized.includes("person@example.invalid"));
    assert.ok(!serialized.includes(access));
    const rows = readDecisionAttempts(String(key.id));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.lane).sort(), ["decision", "execution"]);
    assert.equal(rows.find((row) => row.lane === "decision")!.cost_usd, 0.001);
    assert.equal(rows.find((row) => row.lane === "execution")!.cost_usd, 0.002);
    assert.equal(rows[0].request_id, rows[1].request_id);
  });
}

type FixturePolicy = {
  connections: Record<string, string>;
  policy: {
    candidates: Array<{ model: string; provider: string; capabilities: { text: boolean | null } }>;
    taskOrder: { explanation: string[] };
  };
};
async function mutateConfig(change: (config: FixturePolicy) => void) {
  const combo = await getComboByName("fixture-native-selector");
  const config = structuredClone(combo!.config) as Record<string, unknown>;
  change(config.decisionPolicy as FixturePolicy);
  await updateCombo(comboId, { config });
}
async function waitForDecision(count: number) {
  for (let i = 0; i < 200 && decisionCalls.length === count; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(decisionCalls.length, count + 1);
}
for (const mode of ["refused", "invented", "malformed"])
  test(`${mode} decision is terminal with zero executions and retained decision cost`, async () => {
    answerMode = mode;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cost_usd, 0.001);
    assert.equal(rows[0].application_status, 409);
  });
for (const status of [401, 402, 403, 429, 503])
  test(`decision HTTP${status} never retries or executes`, async () => {
    decisionStatus = status;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    assert.equal(readDecisionAttempts(key.id)[0].cost_usd, 0.001);
  });
test("unknown decision cost stays unknown independently of known execution cost", async () => {
  decisionCost = null;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 200);
  const cost = JSON.parse(response.headers.get("x-omniroute-routing-cost")!);
  assert.deepEqual(cost, { knownUsd: 0.002, unknownStages: 1, totalUsd: null });
  assert.equal(readDecisionAttempts(key.id).find((r) => r.lane === "decision")!.cost_usd, null);
});
test("deterministic mode remains explicit and makes zero decision requests", async () => {
  await configure("deterministic");
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 200);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e + 1);
  assert.equal((executionCalls.at(-1)!.output_config as Record<string, unknown>).effort, "medium");
});
test("unauthorized client produces zero decision and execution calls", async () => {
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request(null));
  await response.text();
  assert.equal(response.status, 401);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e);
});
test("one logical request at RPM1 permits both stages, then blocks another request", async () => {
  upsertKeyQuotaLimits(key.id, { rpmLimit: 1 });
  const d = decisionCalls.length,
    e = executionCalls.length;
  const first = await POST(request());
  await first.text();
  assert.equal(first.status, 200);
  assert.equal(getKeyQuotaStatus(key.id).counters.rpmUsed, 1);
  const second = await POST(request());
  await second.text();
  assert.ok(second.status >= 400);
  assert.equal(decisionCalls.length, d + 1);
  assert.equal(executionCalls.length, e + 1);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.filter((r) => r.logical_counted === 1).length, 1);
  assert.equal(
    getDbInstance()
      .prepare(
        "SELECT COUNT(*) n FROM usage_history WHERE api_key_id=? AND decision_attempt_id IS NOT NULL"
      )
      .get(key.id).n,
    2
  );
});
test("zero eligible candidates remains no-route without any provider request", async () => {
  await mutateConfig((c) =>
    c.policy.candidates.forEach((candidate) => (candidate.capabilities.text = null))
  );
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e);
});
test("selector recursion is rejected before decision dispatch", async () => {
  await mutateConfig((c) => (c.policy.candidates[0].model = "fixture-native-selector"));
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e);
});
test("oversize decision response is terminal and does not invent usage", async () => {
  largeResponse = true;
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(decisionCalls.length, d + 1);
  assert.equal(executionCalls.length, e);
  assert.equal(readDecisionAttempts(key.id)[0].cost_usd, null);
});
test("cancellation before decision has zero dispatches", async () => {
  const abort = new AbortController();
  abort.abort();
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request(key.key, abort.signal));
  await response.text();
  assert.equal(response.status, 499);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e);
});
for (const kind of ["timeout", "cancel"])
  test(`${kind} during decision never executes and leaves unknown billing`, async () => {
    let release!: () => void;
    decisionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = new AbortController(),
      d = decisionCalls.length,
      e = executionCalls.length;
    const pending = POST(request(key.key, abort.signal));
    try {
      await waitForDecision(d);
      if (kind === "cancel") abort.abort();
      const response = await pending;
      await response.text();
      assert.equal(response.status, kind === "cancel" ? 499 : 504);
      assert.equal(executionCalls.length, e);
      assert.equal(decisionCalls.length, d + 1);
      assert.equal(readDecisionAttempts(key.id)[0].cost_usd, null);
    } finally {
      release();
      decisionGate = null;
    }
  });
test("cancellation after decision headers prevents execution; unconsumed billing remains unknown", async () => {
  const abort = new AbortController(),
    e = executionCalls.length;
  afterDecision = async () => {
    abort.abort();
  };
  const response = await POST(request(key.key, abort.signal));
  await response.text();
  assert.equal(response.status, 499);
  assert.equal(executionCalls.length, e);
});
for (const changed of ["key", "connection", "combo"])
  test(`queued ${changed} authorization change after decision blocks execution`, async () => {
    const e = executionCalls.length;
    afterDecision = async () => {
      if (changed === "key")
        await updateApiKeyPermissions(key.id, { allowedConnections: [decisionConnection] });
      else if (changed === "connection")
        await updateProviderConnection(executionConnection, { isActive: false });
      else await mutateConfig((c) => c.policy.taskOrder.explanation.reverse());
    };
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(executionCalls.length, e);
    assert.equal(readDecisionAttempts(key.id)[0].cost_usd, 0.001);
  });
for (const setting of ["HTTP_PROXY", "ENABLE_TLS_FINGERPRINT"])
  test(`unsupported ${setting} rejects before either stage`, async () => {
    const d = decisionCalls.length,
      e = executionCalls.length;
    process.env[setting] = setting === "HTTP_PROXY" ? "http://fixture.invalid:3128" : "true";
    try {
      const response = await POST(request());
      await response.text();
      assert.equal(response.status, 409);
      assert.equal(decisionCalls.length, d);
      assert.equal(executionCalls.length, e);
    } finally {
      delete process.env[setting];
    }
  });

for (const change of ["cancel", "authorization"])
  test(`execution queue ${change} after validated selection prevents follow-on dispatch`, async () => {
    const { acquire } = await import("../../open-sse/services/accountSemaphore.ts");
    await updateProviderConnection(executionConnection, { maxConcurrent: 1 });
    const release = await acquire(`claude:${executionConnection}`, { maxConcurrency: 1 });
    const abort = new AbortController(),
      d = decisionCalls.length,
      e = executionCalls.length;
    const pending = POST(request(key.key, abort.signal));
    try {
      await waitForDecision(d);
      for (let i = 0; i < 200 && readDecisionAttempts(key.id).length < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(readDecisionAttempts(key.id).length, 2);
      if (change === "cancel") abort.abort();
      else await updateApiKeyPermissions(key.id, { allowedConnections: [decisionConnection] });
      release();
      const response = await pending;
      await response.text();
      assert.equal(response.status, change === "cancel" ? 499 : 409);
      assert.equal(executionCalls.length, e);
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.find((r) => r.lane === "decision")!.cost_usd, 0.001);
      assert.equal(rows.find((r) => r.lane === "execution")!.state, "cancelled");
    } finally {
      release();
    }
  });

test("authentication error without a model echo retains auth outcome and decision usage", async () => {
  decisionStatus = 401;
  responseModel = null;
  const e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(executionCalls.length, e);
  const row = readDecisionAttempts(key.id)[0];
  assert.equal(row.decision_outcome, "auth");
  assert.equal(row.cost_usd, 0.001);
});
for (const restriction of ["quota", "endpoint", "model", "connection"])
  test(`selector ${restriction} permission rejection spends nothing`, async () => {
    if (restriction === "quota")
      await updateApiKeyPermissions(key.id, { allowedQuotas: ["synthetic-exclusive-quota"] });
    else if (restriction === "endpoint")
      await updateApiKeyPermissions(key.id, { allowedEndpoints: ["chat"] });
    else if (restriction === "model")
      await updateApiKeyPermissions(key.id, {
        modelAccessMode: "blocklist",
        blockedModels: ["opencode-zen/jev-1.13"],
      });
    else await updateApiKeyPermissions(key.id, { allowedConnections: [executionConnection] });
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    await response.text();
    assert.ok(response.status >= 400);
    assert.equal(decisionCalls.length, d);
    assert.equal(executionCalls.length, e);
  });
test("one remaining eligible option executes explicitly without a native decision", async () => {
  await mutateConfig((c) => (c.policy.candidates[0].capabilities.text = null));
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  assert.equal(response.status, 200, await response.text());
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "sole-eligible");
  assert.equal(response.headers.get("x-omniroute-decision-status"), "no-decision");
  assert.equal(response.headers.has("x-omniroute-decision-request"), false);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e + 1);
  assert.equal((executionCalls.at(-1)!.output_config as Record<string, unknown>).effort, "high");
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lane, "execution");
  assert.ok(String(rows[0].selection_trace).includes("sole_eligible_no_decision"));
});

test("native selection honors an allowed different provider/model pair without executing the other", async () => {
  chosen = "light";
  await mutateConfig((c) => {
    c.policy.candidates[0].provider = "openai";
    c.policy.candidates[0].model = "gpt-5.4";
    c.connections.light = openaiConnection;
  });
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(decisionCalls.length, d + 1);
  assert.equal(executionCalls.length, e + 1);
  const wire = executionCalls.at(-1)!;
  assert.equal(wire.model, "gpt-5.4");
  assert.equal(wire.reasoning_effort, "medium");
  assert.equal(
    readDecisionAttempts(key.id).find((r) => r.lane === "execution")!.connection_id,
    openaiConnection
  );
});

test("missing native distribution stays unknown and produces zero executions", async () => {
  answerMode = "unknown";
  const e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(executionCalls.length, e);
  assert.equal(readDecisionAttempts(key.id)[0].decision_outcome, "unknown");
});
test("mismatched successful decision model preserves cost but cannot execute", async () => {
  responseModel = "unoffered-decision-model";
  const e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(executionCalls.length, e);
  assert.equal(readDecisionAttempts(key.id)[0].cost_usd, 0.001);
});
test("four concurrent native stages are bounded without a whole-key lock", async () => {
  const combo = await getComboByName("fixture-native-selector");
  const config = structuredClone(combo!.config) as {
    decisionPolicy: { selection: { timeoutMs: number }; policy: { timeoutMs: number } };
  };
  config.decisionPolicy.selection.timeoutMs = 2000;
  config.decisionPolicy.policy.timeoutMs = 10000;
  await updateCombo(comboId, { config });
  let release!: () => void;
  decisionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const d = decisionCalls.length,
    e = executionCalls.length;
  const pending = Array.from({ length: 4 }, () => POST(request()));
  try {
    for (let tick = 0; tick < 100; tick++) {
      if (
        readDecisionAttempts(key.id).filter((row) =>
          ["reserved", "started"].includes(String(row.state))
        ).length === 4
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(
      readDecisionAttempts(key.id).filter((row) =>
        ["reserved", "started"].includes(String(row.state))
      ).length,
      4
    );
    const fifth = await POST(request());
    await fifth.text();
    assert.ok(fifth.status >= 400);
    assert.ok(decisionCalls.length <= d + 4);
    assert.equal(executionCalls.length, e);
    release();
    decisionGate = null;
    const responses = await Promise.all(pending);
    for (const response of responses) {
      await response.text();
      assert.equal(response.status, 200);
    }
    assert.equal(decisionCalls.length, d + 4);
    assert.equal(executionCalls.length, e + 4);
  } finally {
    release();
    decisionGate = null;
    await Promise.allSettled(pending);
  }
});

for (const sample of [
  {
    status: 403,
    kind: "edge",
    outcome: "denied",
    body: "<html><title>Cloudflare error 1010</title><p>synthetic-private-account</p></html>",
    cause: /Cloudflare 1010/,
  },
  {
    status: 401,
    kind: "authentication",
    outcome: "auth",
    body: { error: { message: "Authentication required", code: "authentication_error" } },
    cause: /Authentication required/,
  },
  {
    status: 429,
    kind: "quota",
    outcome: "denied",
    body: {
      title: "FreeUsageLimitError",
      detail: "Free usage limit reached.",
      type: "https://errors.example.invalid/free-usage-limit?account=synthetic-private-account",
    },
    cause: /Free usage limit reached/,
  },
]) {
  test(`actual handler preserves sanitized ${sample.kind} diagnostics with zero follow-on calls`, async () => {
    decisionStatus = sample.status;
    failurePayload = sample.body;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    const text = await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    assert.equal(decisionUserAgents.at(-1), SYSTEMONE_USER_AGENT);
    assert.equal(response.headers.get("x-omniroute-provider-error-kind"), sample.kind);
    assert.equal(response.headers.get("x-omniroute-provider-auth-scope"), "unknown");
    assert.match(text, sample.cause);
    assert.doesNotMatch(text, /synthetic-private-account|<html>|synthetic-native-decision-key/);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision_outcome, sample.outcome);
    assert.equal(rows[0].cost_usd, null);
  });
}

test("native account header overrides cannot replace truthful identity or dispatch", async () => {
  await updateProviderConnection(decisionConnection, {
    providerSpecificData: {
      headers: { "User-Agent": "Mozilla/5.0", "X-OpenCode-Identity": "fabricated" },
    },
  });
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e);
});

for (const bindingName of paidBindings) {
  for (const selected of ["deep", "light"]) {
    test(`paid native ${bindingName} honors explicit ${selected} model-and-effort selection`, async () => {
      await configure("native", bindingName);
      chosen = selected;
      if (selected === "light")
        await mutateConfig((config) => {
          config.policy.candidates[0].provider = "openai";
          config.policy.candidates[0].model = "gpt-5.4";
          config.connections.light = openaiConnection;
        });
      const d = decisionCalls.length,
        e = executionCalls.length;
      const response = await POST(request());
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(decisionCalls.length, d + 1);
      assert.equal(executionCalls.length, e + 1);
      assert.equal(decisionCalls.at(-1)!.model, currentDecisionBinding().model);
      assert.equal(decisionUserAgents.at(-1), SYSTEMONE_USER_AGENT);
      assert.equal(response.headers.get("x-omniroute-decision-candidate"), selected);
      const executed = executionCalls.at(-1)!;
      assert.equal(executed.model, selected === "light" ? "gpt-5.4" : "claude-opus-5-5");
      assert.equal(
        selected === "light"
          ? executed.reasoning_effort
          : (executed.output_config as Record<string, unknown>).effort,
        selected === "light" ? "medium" : "high"
      );
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.length, 2);
      const decision = rows.find((row) => row.lane === "decision")!;
      const execution = rows.find((row) => row.lane === "execution")!;
      assert.equal(decision.provider, currentDecisionBinding().provider);
      assert.equal(decision.model, currentDecisionBinding().model);
      assert.equal(decision.connection_id, decisionConnection);
      assert.equal(decision.cost_usd, bindingName === "typesafe" ? null : 0.001);
      assert.equal(execution.provider, selected === "light" ? "openai" : "claude");
      assert.equal(
        execution.connection_id,
        selected === "light" ? openaiConnection : executionConnection
      );
      assert.equal(execution.cost_usd, 0.002);
      assert.equal(decision.request_id, execution.request_id);
      const serialized = JSON.stringify(decisionCalls.at(-1));
      assert.doesNotMatch(
        serialized,
        /private-profile-note|synthetic-private-config-note|person@example.invalid/
      );
      for (const binding of Object.values(decisionBindings))
        assert.ok(!serialized.includes(binding.credential));
    });
  }

  for (const outcome of ["401", "403", "429", "refused", "badidentity", "missingidentity"]) {
    test(`paid native ${bindingName} ${outcome} stops after one selected account and zero executions`, async () => {
      await configure("native", bindingName);
      if (outcome === "refused") answerMode = "refused";
      else if (outcome === "badidentity") responseModel = "unoffered-decision-model";
      else if (outcome === "missingidentity") responseModel = null;
      else {
        decisionStatus = Number(outcome);
        failurePayload = {
          error: {
            message:
              outcome === "429" ? "Free usage limit reached." : "Synthetic access restriction",
            code: outcome === "429" ? "FreeUsageLimitError" : "authentication_error",
          },
        };
      }
      const d = decisionCalls.length,
        e = executionCalls.length;
      const response = await POST(request());
      const text = await response.text();
      assert.equal(response.status, 409);
      assert.equal(decisionCalls.length, d + 1);
      assert.equal(executionCalls.length, e);
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].provider, currentDecisionBinding().provider);
      assert.equal(rows[0].model, currentDecisionBinding().model);
      assert.equal(rows[0].connection_id, decisionConnection);
      assert.equal(
        rows[0].cost_usd,
        ["401", "403", "429"].includes(outcome) || bindingName === "typesafe" ? null : 0.001
      );
      if (["401", "403", "429"].includes(outcome)) {
        assert.equal(rows[0].decision_outcome, outcome === "401" ? "auth" : "denied");
        assert.equal(response.headers.get("x-omniroute-provider-auth-scope"), "unknown");
      }
      assert.doesNotMatch(
        text,
        /synthetic-native-decision-key|synthetic-typesafe-decision-key|synthetic-openrouter-decision-key|synthetic-vercel-decision-key/
      );
    });
  }

  test(`paid native ${bindingName} missing reported cost remains unknown after one execution`, async () => {
    await configure("native", bindingName);
    decisionCost = null;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e + 1);
    const decision = readDecisionAttempts(key.id).find((row) => row.lane === "decision")!;
    assert.equal(decision.cost_usd, null);
    assert.equal(decision.input_tokens, 7);
    assert.equal(decision.output_tokens, 2);
    assert.deepEqual(JSON.parse(response.headers.get("x-omniroute-routing-cost")!), {
      knownUsd: 0.002,
      unknownStages: 1,
      totalUsd: null,
    });
  });

  if (bindingName !== "typesafe")
    test(`paid native ${bindingName} reported zero remains known zero in its provider-specific receipt`, async () => {
      await configure("native", bindingName);
      decisionCost = 0;
      const response = await POST(request());
      await response.text();
      assert.equal(response.status, 200);
      assert.equal(
        readDecisionAttempts(key.id).find((row) => row.lane === "decision")!.cost_usd,
        0
      );
      assert.deepEqual(JSON.parse(response.headers.get("x-omniroute-routing-cost")!), {
        knownUsd: 0.002,
        unknownStages: 0,
        totalUsd: 0.002,
      });
    });

  test(`paid native ${bindingName} cancellation after decision headers prevents execution`, async () => {
    await configure("native", bindingName);
    const abort = new AbortController(),
      d = decisionCalls.length,
      e = executionCalls.length;
    afterDecision = async () => {
      abort.abort();
    };
    const response = await POST(request(key.key, abort.signal));
    await response.text();
    assert.equal(response.status, 499);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    const decision = readDecisionAttempts(key.id)[0];
    assert.equal(decision.provider, currentDecisionBinding().provider);
    assert.equal(decision.cost_usd, null);
  });

  test(`paid native ${bindingName} queued authority change after decision prevents execution`, async () => {
    await configure("native", bindingName);
    const d = decisionCalls.length,
      e = executionCalls.length;
    afterDecision = async () => {
      await updateApiKeyPermissions(key.id, { allowedConnections: [decisionConnection] });
    };
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    const decision = readDecisionAttempts(key.id)[0];
    assert.equal(decision.provider, currentDecisionBinding().provider);
    assert.equal(decision.cost_usd, bindingName === "typesafe" ? null : 0.001);
  });
}

for (const [id, effort] of [
  ["deep", "high"],
  ["light", "medium"],
]) {
  test(`free Zen actual handler honors ${id}/${effort} with exactly one free decision`, async () => {
    await configure("native", "zenFree");
    chosen = id;
    decisionCost = 0;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e + 1);
    assert.equal(decisionCalls.at(-1)!.model, "jev-1.13-free");
    assert.equal(decisionUserAgents.at(-1), SYSTEMONE_USER_AGENT);
    assert.equal(response.headers.get("x-omniroute-decision-candidate"), id);
    assert.equal(executionCalls.at(-1)!.model, "claude-opus-5-5");
    assert.equal((executionCalls.at(-1)!.output_config as Record<string, unknown>).effort, effort);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.length, 2);
    const decision = rows.find((r) => r.lane === "decision")!;
    const execution = rows.find((r) => r.lane === "execution")!;
    assert.equal(decision.provider, "opencode-zen");
    assert.equal(decision.model, "jev-1.13-free");
    assert.equal(decision.connection_id, decisionConnections.zenFree);
    assert.equal(decision.cost_usd, 0);
    assert.equal(execution.request_id, decision.request_id);
    assert.equal(execution.connection_id, executionConnection);
    assert.equal(execution.cost_usd, 0.002);
  });
}

for (const metadata of [
  {},
  { systemOneTier: "paid" },
  { systemOneTier: "FREE" },
  { systemOneTier: "free", headers: { "User-Agent": "fabricated" } },
  { systemOneTier: "free", systemOneUrl: "https://opencode.ai/other" },
]) {
  test(`free Zen rejects unsupported connection metadata ${JSON.stringify(metadata)} before dispatch`, async () => {
    await configure("native", "zenFree");
    await updateProviderConnection(decisionConnection, { providerSpecificData: metadata });
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d);
    assert.equal(executionCalls.length, e);
  });
}

for (const substitution of ["paid-connection", "paid-model-free-connection", "foreign-provider"]) {
  test(`free Zen rejects ${substitution} substitution before dispatch`, async () => {
    await configure("native", "zenFree");
    const combo = await getComboByName("fixture-native-selector");
    const config = structuredClone(combo!.config) as {
      decisionPolicy: { selection: { connectionId: string; model: string; provider: string } };
    };
    if (substitution === "paid-connection")
      config.decisionPolicy.selection.connectionId = decisionConnections.zen;
    else if (substitution === "paid-model-free-connection")
      config.decisionPolicy.selection.model = "jev-1.13";
    else config.decisionPolicy.selection.provider = "openrouter";
    await updateCombo(comboId, { config });
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d);
    assert.equal(executionCalls.length, e);
  });
}

for (const outcome of ["401", "403", "429", "refused", "paid-echo", "missing-echo"]) {
  test(`free Zen ${outcome} stops without paid account, global, or execution fallback`, async () => {
    await configure("native", "zenFree");
    decisionCost = null;
    if (outcome === "refused") answerMode = "refused";
    else if (outcome === "paid-echo") responseModel = "jev-1.13";
    else if (outcome === "missing-echo") responseModel = null;
    else {
      decisionStatus = Number(outcome);
      failurePayload = {
        error: {
          type: outcome === "429" ? "FreeUsageLimitError" : "SyntheticAccessError",
          message: outcome === "429" ? "Free usage limit reached." : "Synthetic access restriction",
        },
      };
    }
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    const text = await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "jev-1.13-free");
    assert.equal(rows[0].connection_id, decisionConnections.zenFree);
    assert.equal(rows[0].cost_usd, null);
    if (["401", "403", "429"].includes(outcome)) {
      assert.equal(rows[0].decision_outcome, outcome === "401" ? "auth" : "denied");
      assert.equal(response.headers.get("x-omniroute-provider-auth-scope"), "unknown");
    }
    for (const binding of Object.values(decisionBindings))
      assert.ok(!text.includes(binding.credential));
  });
}

for (const cost of [null, 0]) {
  test(`free Zen ${cost === null ? "missing" : "reported zero"} decision cost remains distinct from execution`, async () => {
    await configure("native", "zenFree");
    decisionCost = cost;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e + 1);
    const rows = readDecisionAttempts(key.id);
    const decision = rows.find((row) => row.lane === "decision")!;
    assert.equal(decision.cost_usd, cost);
    assert.equal(decision.input_tokens, 7);
    assert.equal(decision.output_tokens, 2);
    assert.equal(rows.find((row) => row.lane === "execution")!.cost_usd, 0.002);
    assert.deepEqual(JSON.parse(response.headers.get("x-omniroute-routing-cost")!), {
      knownUsd: 0.002,
      unknownStages: cost === null ? 1 : 0,
      totalUsd: cost === null ? null : 0.002,
    });
    const serialized = JSON.stringify(decisionCalls.at(-1));
    assert.doesNotMatch(
      serialized,
      /private-profile-note|synthetic-private-config-note|person@example.invalid/
    );
    for (const binding of Object.values(decisionBindings))
      assert.ok(!serialized.includes(binding.credential));
  });
}

for (const phase of ["before-decision", "after-headers"]) {
  test(`free Zen cancellation ${phase} prevents subsequent dispatch`, async () => {
    await configure("native", "zenFree");
    const abort = new AbortController(),
      d = decisionCalls.length,
      e = executionCalls.length;
    if (phase === "before-decision") abort.abort();
    else
      afterDecision = async () => {
        abort.abort();
      };
    const response = await POST(request(key.key, abort.signal));
    await response.text();
    assert.equal(response.status, 499);
    assert.equal(decisionCalls.length, d + (phase === "before-decision" ? 0 : 1));
    assert.equal(executionCalls.length, e);
    if (phase === "after-headers") assert.equal(readDecisionAttempts(key.id)[0].cost_usd, null);
  });
}

test("free Zen tier change while decision capacity is queued prevents every provider call", async () => {
  await configure("native", "zenFree");
  const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
  await updateProviderConnection(decisionConnection, { maxConcurrent: 1 });
  const semaphore = `opencode-zen:${decisionConnection}`;
  const release = await acquire(semaphore, { maxConcurrency: 1 });
  const d = decisionCalls.length,
    e = executionCalls.length;
  const pending = POST(request());
  try {
    for (let n = 0; n < 200 && !getStats()[semaphore]?.queued; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      getStats()[semaphore]?.queued,
      1,
      "request must reach the actual decision capacity queue"
    );
    await updateProviderConnection(decisionConnection, {
      providerSpecificData: { systemOneTier: "paid" },
    });
    release();
    const response = await pending;
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d);
    assert.equal(executionCalls.length, e);
  } finally {
    release();
  }
});

test("free Zen tier change after decision response prevents handover execution", async () => {
  await configure("native", "zenFree");
  decisionCost = 0;
  const d = decisionCalls.length,
    e = executionCalls.length;
  afterDecision = async () => {
    await updateProviderConnection(decisionConnection, {
      providerSpecificData: { systemOneTier: "paid" },
    });
  };
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(decisionCalls.length, d + 1);
  assert.equal(executionCalls.length, e);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_usd, 0);
});

test("free Zen tier change in execution queue after selection prevents physical execution", async () => {
  await configure("native", "zenFree");
  decisionCost = 0;
  const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
  await updateProviderConnection(executionConnection, { maxConcurrent: 1 });
  const semaphore = `claude:${executionConnection}`;
  const release = await acquire(semaphore, { maxConcurrency: 1 });
  const d = decisionCalls.length,
    e = executionCalls.length;
  const pending = POST(request());
  try {
    await waitForDecision(d);
    for (let n = 0; n < 200 && !getStats()[semaphore]?.queued; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      getStats()[semaphore]?.queued,
      1,
      "selected request must reach the actual execution queue"
    );
    await updateProviderConnection(decisionConnection, { providerSpecificData: {} });
    release();
    const response = await pending;
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.find((row) => row.lane === "decision")!.cost_usd, 0);
    assert.equal(rows.find((row) => row.lane === "execution")!.state, "cancelled");
  } finally {
    release();
  }
});

// Exclusive session leases are separate from the bounded attempt/journal lease.
async function holdAccountLease(connectionId: string, provider: string) {
  const { acquireExclusiveConnectionLease, releaseExclusiveConnectionLease } =
    await import("../../src/lib/db/exclusiveConnectionLeases.ts");
  const holder = await createApiKey("synthetic-other-exclusive-owner", "synthetic-machine");
  const owner = `vlo_${"a".repeat(43)}`;
  const claim = acquireExclusiveConnectionLease({
    leaseOwnerId: owner,
    apiKeyId: String(holder.id),
    provider,
    connectionId,
  });
  assert.ok("lease" in claim && claim.kind === "ACQUIRED");
  return () =>
    releaseExclusiveConnectionLease({
      leaseOwnerId: owner,
      apiKeyId: String(holder.id),
      generation: claim.lease.generation,
    });
}
for (const stage of ["selector", "execution"]) {
  test(`another active exclusive session lease blocks ${stage} before every native dispatch`, async () => {
    const releaseLease = await holdAccountLease(
      stage === "selector" ? decisionConnection : executionConnection,
      stage === "selector" ? "opencode-zen" : "claude"
    );
    const d = decisionCalls.length,
      e = executionCalls.length;
    try {
      const response = await POST(request());
      await response.text();
      assert.equal(response.status, 409);
      assert.equal(decisionCalls.length, d);
      assert.equal(executionCalls.length, e);
    } finally {
      releaseLease();
    }
  });
  test(`exclusive session lease acquired in ${stage} queue prevents the pending physical dispatch`, async () => {
    const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
    const connection = stage === "selector" ? decisionConnection : executionConnection;
    const provider = stage === "selector" ? "opencode-zen" : "claude";
    await updateProviderConnection(connection, { maxConcurrent: 1 });
    const semaphore = `${provider}:${connection}`;
    const releaseCapacity = await acquire(semaphore, { maxConcurrency: 1 });
    const d = decisionCalls.length,
      e = executionCalls.length;
    let releaseLease: (() => unknown) | undefined;
    const pending = POST(request());
    try {
      for (let n = 0; n < 200 && !getStats()[semaphore]?.queued; n++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(
        getStats()[semaphore]?.queued,
        1,
        "request reaches actual shared capacity queue"
      );
      releaseLease = await holdAccountLease(connection, provider);
      releaseCapacity();
      const response = await pending;
      await response.text();
      assert.equal(response.status, 409);
      assert.equal(decisionCalls.length, d + (stage === "execution" ? 1 : 0));
      assert.equal(executionCalls.length, e);
    } finally {
      releaseCapacity();
      releaseLease?.();
    }
  });
}

test("expired decision lease cannot hand over, while its returned cost remains reconciled", async () => {
  const d = decisionCalls.length,
    e = executionCalls.length;
  afterDecision = async () => {
    getDbInstance()
      .prepare(
        "UPDATE decision_application_attempts SET lease_expires_at=? WHERE api_key_id=? AND lane='decision'"
      )
      .run(Date.now() - 1, key.id);
  };
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(decisionCalls.length, d + 1);
  assert.equal(executionCalls.length, e);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_usd, 0.001);
  assert.equal(rows[0].decision_outcome, "selection_unavailable");
});

test("journal release failure returns a terminal response without fallback or replay", async () => {
  const d = decisionCalls.length,
    e = executionCalls.length;
  afterDecision = async () => {
    getDbInstance().exec(
      "CREATE TEMP TRIGGER fail_native_terminal_cleanup BEFORE UPDATE OF state ON decision_application_attempts WHEN NEW.state IN ('completed','unknown') BEGIN SELECT RAISE(ABORT,'synthetic terminal cleanup failure'); END"
    );
    throw new Error("synthetic response delivery failure");
  };
  try {
    const response = await POST(request());
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "started");
    assert.equal(rows[0].cost_usd, null);
  } finally {
    getDbInstance().exec("DROP TRIGGER IF EXISTS fail_native_terminal_cleanup");
  }
});

test("queued expired decision reservation cannot send or acquire a fresh lease", async () => {
  const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
  await updateProviderConnection(decisionConnection, { maxConcurrent: 1 });
  const semaphore = `opencode-zen:${decisionConnection}`;
  const release = await acquire(semaphore, { maxConcurrency: 1 });
  const d = decisionCalls.length,
    e = executionCalls.length;
  const pending = POST(request());
  try {
    for (let tick = 0; tick < 200 && !getStats()[semaphore]?.queued; tick++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(getStats()[semaphore]?.queued, 1);
    getDbInstance()
      .prepare("UPDATE decision_application_attempts SET lease_expires_at=? WHERE api_key_id=?")
      .run(Date.now() - 1, key.id);
    release();
    const response = await pending;
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(decisionCalls.length, d);
    assert.equal(executionCalls.length, e);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "cancelled");
    assert.equal(rows[0].cost_usd, 0);
  } finally {
    release();
    await Promise.allSettled([pending]);
  }
});

async function hermesShapedRequest(
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
  token: string | null = key.key
) {
  const source = request(token, signal);
  const body = { ...(await source.json()), ...extra };
  for (const [name, value] of Object.entries(body)) if (value === undefined) delete body[name];
  return new Request(source.url, {
    method: "POST",
    headers: source.headers,
    body: JSON.stringify(body),
    signal,
  });
}
for (const [label, aliases] of [
  ["max_tokens alias", { max_completion_tokens: undefined, max_tokens: 4096 }],
  ["equal token aliases", { max_completion_tokens: 4096, max_tokens: 4096 }],
] as const) {
  test(`Hermes-shaped text ${label} preserves a native choice and exact output reservation`, async () => {
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(await hermesShapedRequest(aliases));
    assert.equal(response.status, 200, await response.text());
    assert.equal(response.headers.get("x-omniroute-selection-mode"), "native");
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e + 1);
    assert.equal(executionCalls.at(-1)!.max_tokens, 4096);
  });
}
for (const aliases of [
  { reasoning_effort: "high" },
  { reasoning: { effort: "high" } },
  { reasoning_effort: "high", reasoning: { effort: "high" } },
]) {
  test(`Hermes-shaped explicit High ${JSON.stringify(aliases)} has one exact execution and no Jev usage`, async () => {
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(
      await hermesShapedRequest({ ...aliases, max_completion_tokens: undefined, max_tokens: 4096 })
    );
    assert.equal(response.status, 200, await response.text());
    assert.equal(response.headers.get("x-omniroute-selection-mode"), "sole-eligible");
    assert.equal(response.headers.get("x-omniroute-decision-status"), "no-decision");
    assert.equal(decisionCalls.length, d);
    assert.equal(executionCalls.length, e + 1);
    assert.equal((executionCalls.at(-1)!.output_config as Record<string, unknown>).effort, "high");
    assert.equal(executionCalls.at(-1)!.max_tokens, 4096);
    const rows = readDecisionAttempts(key.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lane, "execution");
    assert.equal(rows[0].model, "claude-opus-5-5");
    assert.equal(rows[0].connection_id, executionConnection);
  });
}
for (const [label, aliases] of [
  ["conflicting token aliases", { max_tokens: 2048 }],
  ["conflicting effort aliases", { reasoning_effort: "high", reasoning: { effort: "medium" } }],
  [
    "disabled contradicts explicit High",
    { reasoning_effort: "high", reasoning: { enabled: false } },
  ],
  ["unknown nested property", { reasoning: { effort: "high", privateUnknown: true } }],
  ["invalid token string", { max_tokens: "4096" }],
  ["token overflow", { max_completion_tokens: undefined, max_tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ["bounded token ceiling", { max_completion_tokens: 1000001 }],
  ["invalid nested effort", { reasoning: { effort: "turbo" } }],
  ["stream remains unsupported", { stream: true }],
  ["temperature remains unsupported", { temperature: 0.7 }],
  [
    "tools remain unsupported",
    { tools: [{ type: "function", function: { name: "synthetic_tool", parameters: {} } }] },
  ],
] as const) {
  test(`Hermes-shaped invalid ${label} makes zero decision and execution sends`, async () => {
    const d = decisionCalls.length,
      e = executionCalls.length;
    const response = await POST(await hermesShapedRequest(aliases));
    await response.text();
    assert.ok(response.status >= 400);
    assert.equal(decisionCalls.length, d);
    assert.equal(executionCalls.length, e);
  });
}
test("Hermes-shaped text normalization does not mutate caller-owned nested input in the actual handler", async () => {
  const { handleChat } = await import("../../src/sse/handlers/chat.ts");
  const body = {
    model: "fixture-native-selector",
    stream: false,
    max_tokens: 4096,
    reasoning: { effort: "high" },
    messages: [{ role: "user", content: "Explain a synthetic readonly fixture" }],
  };
  const initial = JSON.stringify(body);
  Object.freeze(body.reasoning);
  Object.freeze(body.messages[0]);
  Object.freeze(body.messages);
  Object.freeze(body);
  const response = await handleChat(request(), null, body);
  assert.equal(response.status, 200, await response.text());
  assert.equal(JSON.stringify(body), initial);
  assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
});
for (const change of ["auth", "cancel", "zero-eligible", "queued-policy", "queued-lease"]) {
  test(`sole-eligible text ${change} cannot produce an unintended decision or execution`, async () => {
    const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
    const controller = new AbortController();
    if (change === "cancel") controller.abort();
    if (change === "zero-eligible")
      await mutateConfig((c) => {
        for (const row of c.policy.candidates) row.capabilities.text = null;
      });
    const queued = change.startsWith("queued");
    if (queued) await updateProviderConnection(executionConnection, { maxConcurrent: 1 });
    const semaphore = `claude:${executionConnection}`;
    const releaseCapacity = queued ? await acquire(semaphore, { maxConcurrency: 1 }) : () => {};
    let releaseLease: (() => unknown) | undefined;
    const d = decisionCalls.length,
      e = executionCalls.length;
    const pending = POST(
      await hermesShapedRequest(
        { reasoning_effort: "high" },
        controller.signal,
        change === "auth" ? "synthetic-invalid" : key.key
      )
    );
    try {
      if (queued) {
        for (let n = 0; n < 200 && !getStats()[semaphore]?.queued; n++)
          await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(getStats()[semaphore]?.queued, 1);
        if (change === "queued-policy")
          await updateApiKeyPermissions(key.id, { allowedConnections: [decisionConnection] });
        else releaseLease = await holdAccountLease(executionConnection, "claude");
        releaseCapacity();
      }
      const response = await pending;
      await response.text();
      assert.ok(response.status >= 400);
      assert.equal(decisionCalls.length, d);
      assert.equal(executionCalls.length, e);
    } finally {
      releaseCapacity();
      releaseLease?.();
    }
  });
}
test("deterministic text aliases remain explicitly distinct from sole-eligible native mode", async () => {
  await configure("deterministic");
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(
    await hermesShapedRequest({
      max_completion_tokens: undefined,
      max_tokens: 4096,
      reasoning: { effort: "high" },
    })
  );
  assert.equal(response.status, 200, await response.text());
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "deterministic");
  assert.equal(response.headers.get("x-omniroute-decision-status"), "no-decision");
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e + 1);
});

test("ordinary non-combo text normalization remains outside the bounded alias contract", async () => {
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(
    await hermesShapedRequest({
      model: "openai/gpt-5.4",
      reasoning_effort: "high",
      reasoning: { enabled: false },
      temperature: 0.7,
    })
  );
  assert.equal(response.status, 200, await response.text());
  assert.equal(response.headers.has("x-omniroute-selection-mode"), false);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e + 1);
});

test("sole-eligible receipt annotation failure returns unknown cost without replay or escaping", async (context) => {
  const db = getDbInstance();
  const prepare = db.prepare.bind(db);
  let annotationReads = 0;
  const mocked = context.mock.method(db, "prepare", (sql: string) => {
    if (sql === "SELECT cost_usd FROM decision_application_attempts WHERE request_id=?") {
      annotationReads++;
      throw new Error("synthetic aggregate receipt read failure");
    }
    return prepare(sql);
  });
  const d = decisionCalls.length,
    e = executionCalls.length;
  let response: Response;
  try {
    response = await POST(await hermesShapedRequest({ reasoning_effort: "high" }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-omniroute-selection-mode"), "sole-eligible");
    assert.equal(response.headers.get("x-omniroute-routing-cost-status"), "unknown");
    assert.equal(response.headers.has("x-omniroute-routing-cost"), false);
    await response.text();
  } finally {
    mocked.mock.restore();
  }
  assert.equal(annotationReads, 1);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e + 1);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_usd, 0.002);
});

test("Hermes-shaped multipart caller data stays immutable through the actual guarded handler", async () => {
  const { handleChat } = await import("../../src/sse/handlers/chat.ts");
  const part = Object.freeze({ type: "text", text: "Explain a synthetic multipart fixture" });
  const body = Object.freeze({
    model: "fixture-native-selector",
    stream: false,
    max_tokens: 4096,
    reasoning: Object.freeze({ effort: "high" }),
    messages: Object.freeze([Object.freeze({ role: "user", content: Object.freeze([part]) })]),
  });
  const initial = JSON.stringify(body);
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await handleChat(request(), null, body);
  assert.equal(response.status, 200, await response.text());
  assert.equal(JSON.stringify(body), initial);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e + 1);
});

test("native receipt annotation failure returns unknown cost without replay or duplicate settlement", async (context) => {
  const db = getDbInstance();
  const prepare = db.prepare.bind(db);
  let annotationReads = 0;
  const mocked = context.mock.method(db, "prepare", (sql: string) => {
    if (sql === "SELECT cost_usd FROM decision_application_attempts WHERE request_id=?") {
      annotationReads++;
      throw new Error("synthetic native aggregate receipt read failure");
    }
    return prepare(sql);
  });
  const d = decisionCalls.length,
    e = executionCalls.length;
  try {
    const response = await POST(request());
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-omniroute-selection-mode"), "native");
    assert.equal(response.headers.get("x-omniroute-routing-cost-status"), "unknown");
    assert.equal(response.headers.has("x-omniroute-routing-cost"), false);
    await response.text();
  } finally {
    mocked.mock.restore();
  }
  assert.equal(annotationReads, 1);
  assert.equal(decisionCalls.length, d + 1);
  assert.equal(executionCalls.length, e + 1);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.lane === "decision")!.cost_usd, 0.001);
  assert.equal(rows.find((row) => row.lane === "execution")!.cost_usd, 0.002);
  for (const row of rows) {
    const ledger = db
      .prepare("SELECT COUNT(*) AS n FROM request_cost_ledger WHERE request_id=?")
      .get(row.id) as { n: number };
    const usage = db
      .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE decision_attempt_id=?")
      .get(row.id) as { n: number };
    assert.equal(ledger.n, 1);
    assert.equal(usage.n, 1);
  }
});

for (const change of [
  "secondary-output-conflict",
  "secondary-effort-conflict",
  "nested-effort-extra",
  "equal-secondary-carriers",
]) {
  test(`final text wire ${change} preserves every selected effort and reserved output carrier`, async () => {
    const { getExecutor } = await import("../../open-sse/executors/index.ts");
    await mutateConfig((c) => {
      c.policy.candidates[1].provider = "openai";
      c.policy.candidates[1].model = "gpt-5.4";
      c.connections.deep = openaiConnection;
    });
    const executor = await getExecutor("openai"),
      original = executor.transformRequest;
    executor.transformRequest = async function (...args: Parameters<typeof original>) {
      const wire = await original.apply(this, args);
      if (change === "secondary-output-conflict")
        return { ...wire, max_completion_tokens: 4096, max_tokens: 8192 };
      if (change === "secondary-effort-conflict")
        return { ...wire, reasoning: { effort: "medium" } };
      if (change === "nested-effort-extra")
        return { ...wire, reasoning: { effort: "high", privateExtra: true } };
      return {
        ...wire,
        max_completion_tokens: 4096,
        max_tokens: 4096,
        reasoning: { effort: "high" },
      };
    };
    const d = decisionCalls.length,
      e = executionCalls.length;
    try {
      const response = await POST(await hermesShapedRequest({ reasoning_effort: "high" }));
      await response.text();
      assert.equal(response.status, change === "equal-secondary-carriers" ? 200 : 409);
      assert.equal(decisionCalls.length, d);
      assert.equal(executionCalls.length, e + (change === "equal-secondary-carriers" ? 1 : 0));
    } finally {
      executor.transformRequest = original;
    }
  });
}
