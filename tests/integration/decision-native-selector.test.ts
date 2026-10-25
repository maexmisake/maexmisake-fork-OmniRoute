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
          providerSpecificData: {},
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
        providerSpecificData: {},
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
  for (const connection of Object.values(decisionConnections)) {
    await updateProviderConnection(connection, {
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
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
test("one remaining eligible option cannot silently bypass mandatory native selection", async () => {
  await mutateConfig((c) => (c.policy.candidates[0].capabilities.text = null));
  const d = decisionCalls.length,
    e = executionCalls.length;
  const response = await POST(request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(decisionCalls.length, d);
  assert.equal(executionCalls.length, e);
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
test("a concurrent request cannot enter the key slot while native decision is pending", async () => {
  let release!: () => void;
  decisionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const d = decisionCalls.length,
    e = executionCalls.length,
    pending = POST(request());
  try {
    await waitForDecision(d);
    const second = await POST(request());
    await second.text();
    assert.ok(second.status >= 400);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e);
    release();
    decisionGate = null;
    const first = await pending;
    await first.text();
    assert.equal(first.status, 200);
    assert.equal(decisionCalls.length, d + 1);
    assert.equal(executionCalls.length, e + 1);
  } finally {
    release();
    decisionGate = null;
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
