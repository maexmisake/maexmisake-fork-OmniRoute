import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

import { writeFile } from "node:fs/promises";
process.env.REQUIRE_API_KEY = "true";
process.env.PII_REDACTION_ENABLED = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.EXPOSE_CC_DISCOVERY_ALIASES = "true";
const { createProviderConnection, resetConnectionBackoff } =
  await import("../../src/lib/db/providers.ts");
const { createCombo, deleteCombo, updateCombo, getComboByName } =
  await import("../../src/lib/db/combos.ts");
const { createApiKey, updateApiKeyPermissions } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
const { getUsageDb } = await import("../../src/lib/usage/usageHistory.ts");
const { BaseGuardrail, guardrailRegistry } = await import("../../src/lib/guardrails/index.ts");
const { setModelAlias } = await import("../../src/lib/db/models/aliases.ts");
const { invalidateAliasCache } = await import("../../src/lib/modelAliasResolver.ts");
const { createModelComboMapping } = await import("../../src/lib/db/modelComboMappings.ts");
const { upsertKeyQuotaLimits, incrementKeyQuotaCounter } =
  await import("../../src/lib/db/keyQuota.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { readDecisionAttempts, settleDecisionAttempt } =
  await import("../../src/lib/db/decisionAttempts.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { upsertTokenLimit } = await import("../../src/lib/db/tokenLimits.ts");
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const { currentApplicationAttempt } =
  await import("../../open-sse/services/decisionPolicy/applicationContext.ts");
// Test-private capability captured before dispatch; never emitted in artifacts or recovered from DB.
const dispatchedIdentities = new Map<
  string,
  import("../../src/lib/db/decisionAttempts.ts").AttemptIdentity
>();
const observations: Array<{ model: unknown; effort: unknown; emailMasked: boolean }> = [];
const events: Array<Record<string, unknown>> = [];
let validKey: string;
let baseUrl: string;
let primaryConnectionId: string;
let fixtureStatus = 200;
let fixtureCost: number | null = 0.002;
let fixtureRefusal = false;
let fixtureReasoning: number | null = null;
let fixtureInput: number = 8;
let fixtureOutput: number | null = 4;
let fixtureMalformed = false;
let fixtureOversize = false;
let fixtureGate: Promise<void> | null = null;
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  assert.equal(req.headers.authorization, "Bearer synthetic-local-provider-key");
  observations.push({
    model: body.model,
    effort: body.reasoning_effort ?? body.reasoning?.effort,
    emailMasked: !JSON.stringify(body).includes("synthetic.person@example.invalid"),
  });
  if (fixtureGate) await fixtureGate;
  res.writeHead(fixtureStatus, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "fixture-local-response",
      object: "chat.completion",
      model: body.model,
      choices: fixtureMalformed
        ? []
        : [
            {
              index: 0,
              message: {
                role: "assistant",
                content: fixtureRefusal
                  ? null
                  : fixtureOversize
                    ? "x".repeat(300000)
                    : "synthetic local response",
                ...(fixtureRefusal ? { refusal: "synthetic refusal" } : {}),
              },
              finish_reason: "stop",
            },
          ],
      usage: {
        prompt_tokens: fixtureInput,
        ...(fixtureOutput === null ? {} : { completion_tokens: fixtureOutput }),
        total_tokens: 12,
        ...(fixtureReasoning === null
          ? {}
          : {
              completion_tokens_details: { reasoning_tokens: fixtureReasoning },
              prompt_tokens_details: { cached_tokens: 2 },
            }),
        ...(fixtureCost === null ? {} : { cost: fixtureCost }),
      },
    })
  );
});
const originalFetch = globalThis.fetch;
class ObservePreparedBody extends BaseGuardrail {
  calls = 0;
  emailMasked = false;
  constructor() {
    super("fixture-prepared-body-observer", { priority: 1000 });
  }
  async preCall(payload: unknown) {
    this.calls++;
    this.emailMasked = !JSON.stringify(payload).includes("synthetic.person@example.invalid");
    return { block: false };
  }
}
const observer = new ObservePreparedBody();
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(
      new URL(url).hostname,
      "127.0.0.1",
      "only the local synthetic endpoint is allowed"
    );
    const attempt = currentApplicationAttempt();
    if (attempt)
      dispatchedIdentities.set(attempt.id, {
        ...attempt,
      } as unknown as import("../../src/lib/db/decisionAttempts.ts").AttemptIdentity);
    return proxyFetch(url, init);
  };
  await updateSettings({
    semanticCacheEnabled: false,
    memoryEnabled: false,
    compressionEnabled: false,
    globalFallbackModel: "openai/gpt-5.4",
    streamDefaultMode: "json",
  });
  primaryConnectionId = String(
    (
      await createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "synthetic-local-only",
        apiKey: "synthetic-local-provider-key",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { baseUrl },
      })
    ).id
  );
  await createCombo({
    name: "fixture-ordinary-combo",
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: {},
  });
  const decisionCombo = await createCombo({
    name: "fixture-decision-combo",
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: { decisionPolicy: { enabled: true, version: 1 } },
  });
  await createCombo({
    name: "fixture-empty-decision",
    models: [],
    config: { decisionPolicy: { enabled: true } },
  });
  await createCombo({
    name: "fixture-malformed-decision",
    models: [],
    config: { decisionPolicy: null },
  });
  await createCombo({
    name: "fixture-nested-parent",
    models: ["openai/gpt-5.4", { kind: "combo-ref", comboName: "fixture-decision-combo" }],
    strategy: "priority",
  });
  await createCombo({
    name: "fixture-disabled-control",
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: { decisionPolicy: { enabled: false } },
  });
  await setModelAlias("fixture-string-alias", "fixture-decision-combo");
  await setModelAlias("fixture-array-alias", ["fixture-decision-combo"]);
  await setModelAlias("fixture-object-alias", {
    provider: "combo",
    model: "fixture-decision-combo",
  });
  await createModelComboMapping({
    pattern: "fixture-mapped-*",
    comboId: String(decisionCombo.id),
    priority: 10,
    enabled: true,
  });
  validKey = (await createApiKey("synthetic-client-only", "synthetic-machine-only")).key;
  guardrailRegistry.register(observer);
});
after(async () => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  const journal = process.env.APPLICATION_EVIDENCE_PATH
    ? getDbInstance()
        .prepare(
          "SELECT a.id,a.candidate_id,a.provider,a.model,a.effort,a.state,a.http_status,a.application_status,a.input_tokens,a.output_tokens,a.reasoning_tokens,a.cache_read_tokens,a.cost_usd,a.selection_trace FROM decision_application_attempts a JOIN combos c ON c.id=a.combo_id WHERE c.name='fixture-permitted-combo' ORDER BY a.created_at"
        )
        .all()
        .map((value) => {
          const row = value as Record<string, unknown>;
          const { selection_trace, ...metadata } = row;
          return { ...metadata, trace: JSON.parse(String(selection_trace ?? "[]")) };
        })
    : [];
  assert.ok(!JSON.stringify(journal).includes(validKey));
  assert.ok(!JSON.stringify(journal).includes("synthetic.person@example.invalid"));
  resetDbInstance();
  if (process.env.APPLICATION_EVIDENCE_PATH)
    await writeFile(
      process.env.APPLICATION_EVIDENCE_PATH,
      JSON.stringify(
        {
          schemaVersion: 1,
          synthetic: true,
          qualityMeasured: false,
          observations,
          events,
          journal,
        },
        null,
        2
      ) + "\n"
    );
});
function request(
  model: string,
  key: string | null = validKey,
  extraHeaders: Record<string, string> = {}
) {
  return new Request("http://application.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      stream: false,
      reasoning_effort: "medium",
      max_completion_tokens: 100,
      messages: [
        { role: "user", content: "Explain a fixture for synthetic.person@example.invalid" },
      ],
    }),
  });
}

test("real route authentication rejects missing/invalid client key with zero local dispatch", async () => {
  const count = observations.length;
  for (const key of [null, "synthetic-invalid-client-key"]) {
    const response = await POST(request("fixture-decision-combo", key));
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.equal(observations.length, count);
  events.push({ case: "real-client-auth", passed: true, dispatches: 0 });
});

test("ordinary combo retains application auth, redaction, exact model/effort and usage recording", async () => {
  const count = observations.length;
  const response = await POST(request("fixture-ordinary-combo"));
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(observations.length, count + 1);
  assert.equal(observations.at(-1)?.model, "gpt-5.4");
  assert.equal(observations.at(-1)?.effort, "medium");
  assert.equal(observations.at(-1)?.emailMasked, true);
  assert.equal(observer.emailMasked, true);
  let usage = await getUsageDb();
  for (let n = 0; n < 100 && !JSON.stringify(usage).includes("gpt-5.4"); n++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    usage = await getUsageDb();
  }
  assert.ok(
    JSON.stringify(usage).includes("gpt-5.4"),
    "normal application usage must reach the temporary database"
  );
  resetDbInstance();
  const reopened = await getUsageDb();
  assert.ok(
    JSON.stringify(reopened).includes("gpt-5.4"),
    "successful control usage survives reopening SQLite"
  );
  events.push({
    case: "ordinary-combo-control",
    passed: true,
    dispatches: 1,
    usageObserved: true,
    redactionObserved: true,
  });
});

test("server-stored decision opt-in fails closed before guardrails or legacy/global fallback", async () => {
  const count = observations.length,
    calls = observer.calls;
  const response = await POST(request("fixture-decision-combo"));
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error.code, "decision_policy_application_unvalidated");
  assert.equal(observations.length, count);
  assert.equal(observer.calls, calls);
  assert.ok(!JSON.stringify(body).includes(validKey));
  assert.ok(!JSON.stringify(body).includes("synthetic.person@example.invalid"));
  events.push({ case: "unvalidated-opt-in", passed: true, dispatches: 0, guardrailsCalled: false });
});

for (const model of [
  "combo/fixture-decision-combo",
  "fixture-string-alias",
  "fixture-array-alias",
  "fixture-object-alias",
  "fixture-mapped-request",
  "fixture-empty-decision",
  "fixture-malformed-decision",
  "fixture-nested-parent",
  "no-think/fixture-decision-combo",
  "claude/combo/fixture-decision-combo",
  "fixture-decision-combo[500k]",
  "client-namespace/fixture-decision-combo",
]) {
  test(`real route blocks unavailable decision identity before provider work: ${model}`, async () => {
    const count = observations.length,
      calls = observer.calls;
    const response = await POST(request(model));
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.error.code, "decision_policy_application_unvalidated");
    assert.equal(observations.length, count);
    assert.equal(observer.calls, calls);
    events.push({ case: "identity-escape", model, dispatches: 0, passed: true });
  });
}

test("header override and per-key forced identity cannot route an opt-in through legacy dispatch", async () => {
  const count = observations.length;
  const header = await POST(
    request("fixture-ordinary-combo", validKey, { "x-route-model": "fixture-decision-combo" })
  );
  assert.equal(header.status, 409);
  await header.text();
  const forced = await createApiKey("synthetic-forced-client", "synthetic-machine-only");
  await updateApiKeyPermissions(forced.id, { forcedModel: "fixture-decision-combo" });
  const response = await POST(request("fixture-ordinary-combo", forced.key));
  assert.equal(response.status, 409);
  await response.text();
  assert.equal(observations.length, count);
});

test("self-hosted route diversion cannot bypass the stored decision gate", async () => {
  const count = observations.length;
  const prior = process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS;
  process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS = `providers:\n  - id: fixture\n    kind: openai\n    baseUrl: ${baseUrl.replace(/\/chat\/completions$/, "")}\n    model: fixture-model\n    apiKey: synthetic-local-provider-key`;
  try {
    for (const model of [
      "fixture-decision-combo",
      "fixture-decision-combo[500k]",
      "client-namespace/fixture-decision-combo",
    ]) {
      const response = await POST(request(model));
      assert.equal(response.status, 409, model);
      await response.text();
      assert.equal(observations.length, count);
    }
  } finally {
    if (prior === undefined) delete process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS;
    else process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS = prior;
  }
});

test("existing key quota/rate policy rejects before terminal feature response without a provider send", async () => {
  const count = observations.length;
  const limited = await createApiKey("synthetic-quota-client", "synthetic-machine-only");
  upsertKeyQuotaLimits(limited.id, { rpmLimit: 1 });
  incrementKeyQuotaCounter(limited.id, "rpm", 1, Date.now());
  const response = await POST(request("fixture-decision-combo", limited.key));
  assert.equal(response.status, 429, await response.text());
  assert.equal(observations.length, count);
});

test("stale alias cache cannot hide a new array alias to a decision combo", async () => {
  const count = observations.length;
  await setModelAlias("fixture-late-array-alias", ["fixture-decision-combo"]);
  const response = await POST(request("fixture-late-array-alias"));
  assert.equal(response.status, 409, await response.text());
  assert.equal(observations.length, count);
  invalidateAliasCache();
});

test("direct application handler entry also blocks before provider-capable guardrails", async () => {
  const count = observations.length,
    calls = observer.calls;
  const response = await handleChat(request("fixture-decision-combo"));
  assert.equal(response.status, 409);
  await response.text();
  assert.equal(observations.length, count);
  assert.equal(observer.calls, calls);
});

test("explicitly disabled decision policy keeps ordinary combo behavior", async () => {
  const count = observations.length;
  const response = await POST(request("fixture-disabled-control"));
  assert.equal(
    response.status,
    200,
    String(response.headers.get("x-omniroute-decision-reason")) + (await response.text())
  );
  assert.equal(observations.length, count + 1);
});

test("ordinary metadata mentioning a disabled feature is not a routing reference", async () => {
  await createCombo({
    name: "fixture-notes-control",
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: { notes: "fixture-decision-combo" },
  });
  const count = observations.length;
  const response = await POST(request("fixture-notes-control"));
  assert.equal(
    response.status,
    200,
    String(response.headers.get("x-omniroute-decision-reason")) + (await response.text())
  );
  assert.equal(observations.length, count + 1);
});

test("a bare flagged combo name cannot override a known provider/model pin", async () => {
  await createCombo({
    name: "gpt-5.4",
    models: ["openai/gpt-5.4"],
    config: { decisionPolicy: { enabled: true } },
  });
  const count = observations.length;
  const response = await POST(request("openai/gpt-5.4"));
  assert.equal(
    response.status,
    200,
    String(response.headers.get("x-omniroute-decision-reason")) + (await response.text())
  );
  assert.equal(observations.length, count + 1);
});

test("normal guardrail rerouting to a decision combo is rejected before its target expansion", async () => {
  class Reroute extends BaseGuardrail {
    constructor() {
      super("fixture-reroute-to-decision", { priority: 999 });
    }
    async preCall(payload: unknown) {
      return { modifiedPayload: { ...(payload as object), model: "fixture-decision-combo" } };
    }
  }
  const rule = new Reroute();
  guardrailRegistry.register(rule);
  const count = observations.length;
  try {
    const response = await POST(request("fixture-ordinary-combo"));
    assert.equal(response.status, 409, await response.text());
    assert.equal(observations.length, count);
  } finally {
    rule.enabled = false;
  }
});

test("bounded alias chains are checked before self-hosted diversion", async () => {
  await setModelAlias("fixture-chain-a", "fixture-chain-b");
  await setModelAlias("fixture-chain-b", "fixture-decision-combo");
  const count = observations.length;
  const prior = process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS;
  process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS = `providers:\n  - id: fixture\n    kind: openai\n    baseUrl: ${baseUrl.replace(/\/chat\/completions$/, "")}\n    model: fixture-model\n    apiKey: synthetic-local-provider-key`;
  try {
    const response = await POST(request("fixture-chain-a"));
    assert.equal(response.status, 409, await response.text());
    assert.equal(observations.length, count);
  } finally {
    if (prior === undefined) delete process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS;
    else process.env.OMNIROUTE_SELF_HOSTED_PROVIDERS = prior;
  }
});

test("ambiguous alias cycles fail closed without legacy fallback", async () => {
  await setModelAlias("fixture-cycle-a", "fixture-cycle-b");
  await setModelAlias("fixture-cycle-b", "fixture-cycle-a");
  const count = observations.length;
  const response = await POST(request("fixture-cycle-a"));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "decision_policy_metadata_unavailable");
  assert.equal(observations.length, count);
});

test("global fallback cannot reinterpret an exact marked combo identity as a physical model", async () => {
  const marked = await createCombo({
    name: "openai/gpt-5.4",
    models: ["openai/gpt-5.4"],
    config: { decisionPolicy: { enabled: true } },
  });
  await createCombo({
    name: "fixture-exhausted-parent",
    models: ["fixture-missing-provider/not-configured"],
    strategy: "priority",
  });
  const count = observations.length;
  try {
    const response = await POST(request("fixture-exhausted-parent"));
    assert.equal(response.status, 409, await response.text());
    assert.equal(observations.length, count);
    events.push({ case: "marked-global-fallback", passed: true, dispatches: 0 });
  } finally {
    await deleteCombo(String(marked.id));
  }
});

async function boundedRequest(
  key = validKey,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal
) {
  const body = await request("fixture-permitted-combo", key).json();
  delete body.reasoning_effort;
  return new Request("http://application.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ ...body, ...extra }),
    signal,
  });
}
async function ensurePermittedCombo() {
  if (await getComboByName("fixture-permitted-combo")) return;
  const candidate = (id: string, effort: string) => ({
    id,
    provider: "openai",
    model: "gpt-5.4",
    endpointKind: "direct",
    evidence: "synthetic fixture only; no live quality proof",
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
      evidence: "synthetic protocol profile",
    },
  });
  await createCombo({
    name: "fixture-permitted-combo",
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        connections: {
          light: primaryConnectionId,
          deep: primaryConnectionId,
          unknown: primaryConnectionId,
        },
        policy: {
          version: 1,
          candidates: [
            {
              ...candidate("unknown", "low"),
              capabilities: {
                text: null,
                images: false,
                tools: false,
                reasoning: null,
                contextTokens: null,
              },
            },
            candidate("light", "medium"),
            candidate("deep", "high"),
          ],
          taskOrder: {
            explanation: ["unknown", "light", "deep"],
            complex_code: ["deep", "light"],
            reasoning: ["deep"],
          },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: 0,
          maxExecutionAttempts: 1,
          timeoutMs: 3000,
        },
      },
    },
  });
}
test("permitted automatic combo selects an eligible model plus effort through the actual application", async () => {
  await ensurePermittedCombo();
  const count = observations.length;
  const response = await POST(await boundedRequest());
  assert.equal(
    response.status,
    200,
    String(response.headers.get("x-omniroute-decision-reason")) + (await response.text())
  );
  assert.equal(response.headers.get("x-omniroute-decision-candidate"), "light");
  assert.equal(observations.length, count + 1);
  assert.deepEqual(observations.at(-1), { model: "gpt-5.4", effort: "medium", emailMasked: true });
  const row = readDecisionAttempts(
    (await import("../../src/lib/db/apiKeys.ts")).getApiKeyMetadata
      ? String(
          (await (await import("../../src/lib/db/apiKeys.ts")).getApiKeyMetadata(validKey))!.id
        )
      : ""
  ).at(-1)!;
  assert.equal(row.state, "completed");
  assert.equal(row.cost_usd, 0.002);
  assert.equal(row.input_tokens, 8);
  assert.equal(row.output_tokens, 4);
  const ledger = getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM request_cost_ledger WHERE request_id=?")
    .get(row.id) as { n: number };
  assert.equal(ledger.n, 1);
  events.push({
    case: "permitted-actual-application",
    candidate: "light",
    effort: "medium",
    physicalCalls: 1,
    qualityMeasured: false,
  });
});
test("automatic reasoning selection sets its supported high effort without a client effort directive", async () => {
  const count = observations.length;
  const response = await POST(
    await boundedRequest(validKey, {
      messages: [{ role: "user", content: "Debug a complex code invariant" }],
    })
  );
  assert.equal(
    response.status,
    200,
    String(response.headers.get("x-omniroute-decision-reason")) + (await response.text())
  );
  assert.equal(response.headers.get("x-omniroute-decision-candidate"), "deep");
  assert.equal(observations.length, count + 1);
  assert.equal(observations.at(-1)?.effort, "high");
});
test("unsupported text/image/tool/effort inputs and unauthorized client cause zero automatic sends", async () => {
  const count = observations.length;
  for (const extra of [
    { stream: true },
    { reasoning_effort: "max" },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://fixture.invalid/private" } }],
        },
      ],
    },
    {
      tools: [{ type: "function", function: { name: "fixture", parameters: { type: "object" } } }],
    },
  ]) {
    const response = await POST(await boundedRequest(validKey, extra));
    assert.notEqual(response.status, 200);
    await response.text();
  }
  const denied = await POST(await boundedRequest("synthetic-invalid-key"));
  assert.equal(denied.status, 401);
  await denied.text();
  assert.equal(observations.length, count);
});
test("all applicable capped key types reject the unbounded-price lane before dispatch", async () => {
  const count = observations.length;
  for (const scope of ["global", "provider", "model"] as const) {
    const key = await createApiKey("synthetic-capped-" + scope, "synthetic");
    upsertTokenLimit({
      apiKeyId: key.id,
      scopeType: scope,
      scopeValue: scope === "provider" ? "openai" : scope === "model" ? "gpt-5.4" : "",
      tokenLimit: 100000,
    });
    const response = await POST(await boundedRequest(key.key));
    assert.notEqual(response.status, 200);
    await response.text();
  }
  for (const limits of [{ tpmLimit: 100000 }, { monthlyAmountUsd: 100 }]) {
    const key = await createApiKey("synthetic-capped-quota", "synthetic");
    upsertKeyQuotaLimits(key.id, limits);
    const response = await POST(await boundedRequest(key.key));
    assert.notEqual(response.status, 200);
    await response.text();
  }
  const key = await createApiKey("synthetic-capped-budget", "synthetic");
  (await import("../../src/domain/costRules.ts")).setBudget(key.id, { dailyLimitUsd: 100 });
  const response = await POST(await boundedRequest(key.key));
  assert.notEqual(response.status, 200);
  await response.text();
  assert.equal(observations.length, count);
});
test("first provider error/refusal cannot trigger account/model/global fallback", async () => {
  const count = observations.length;
  try {
    for (const status of [401, 403, 429, 503]) {
      fixtureStatus = status;
      const before = observations.length;
      const response = await POST(await boundedRequest());
      await response.text();
      assert.notEqual(response.status, 200);
      assert.equal(
        observations.length,
        before + 1,
        String(response.status) + ":" + response.headers.get("x-omniroute-decision-reason")
      );
      await resetConnectionBackoff(primaryConnectionId);
      (await import("../../open-sse/services/accountFallback.ts")).clearAllModelLockouts();
    }
    fixtureStatus = 200;
    fixtureRefusal = true;
    const refusal = await POST(await boundedRequest());
    await refusal.text();
    assert.equal(observations.length, count + 5);
  } finally {
    fixtureStatus = 200;
    fixtureRefusal = false;
  }
});
test("unknown provider cost remains null and uncapped requests may proceed; later capped traffic cannot call it free", async () => {
  const key = await createApiKey("synthetic-unknown-cost", "synthetic");
  fixtureCost = null;
  try {
    const response = await POST(await boundedRequest(key.key));
    assert.equal(
      response.status,
      200,
      String(response.headers.get("x-omniroute-decision-reason")) + (await response.text())
    );
    const row = readDecisionAttempts(key.id).at(-1)!;
    assert.equal(row.state, "completed");
    assert.equal(row.cost_usd, null);
    const second = await POST(await boundedRequest(key.key));
    assert.equal(second.status, 200, await second.text());
    upsertKeyQuotaLimits(key.id, { monthlyAmountUsd: 100 });
    const count = observations.length;
    const rejected = await POST(request("fixture-ordinary-combo", key.key));
    assert.equal(rejected.status, 429);
    await rejected.text();
    assert.equal(observations.length, count);
  } finally {
    fixtureCost = 0.002;
  }
});
test("uncapped native overlap leaves ordinary application traffic available", async () => {
  await ensurePermittedCombo();
  const key = await createApiKey("synthetic-concurrent", "synthetic");
  let release!: () => void;
  fixtureGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const count = observations.length;
  const pending = [
    POST(await boundedRequest(key.key)),
    POST(await boundedRequest(key.key)),
    POST(request("fixture-ordinary-combo", key.key)),
  ];
  try {
    for (let i = 0; i < 300 && observations.length < count + 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      observations.length,
      count + 3,
      "ordinary send arrives while both native sends remain pending"
    );
    assert.equal(readDecisionAttempts(key.id).filter((row) => row.state === "started").length, 2);
  } finally {
    release();
    fixtureGate = null;
  }
  const results = await Promise.all(pending);
  for (const response of results) assert.equal(response.status, 200, await response.text());
  assert.equal(readDecisionAttempts(key.id).filter((row) => row.state === "completed").length, 2);
});

test("actual application rejects reserve/start failures before any physical send", async () => {
  for (const stage of ["reserve", "start"]) {
    const key = await createApiKey("synthetic-fault-" + stage, "synthetic");
    const count = observations.length;
    const trigger =
      stage === "reserve"
        ? "BEFORE INSERT ON decision_application_attempts"
        : "BEFORE UPDATE OF state ON decision_application_attempts WHEN NEW.state='started'";
    getDbInstance().exec(
      `CREATE TEMP TRIGGER synthetic_attempt_failure ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`
    );
    try {
      const response = await POST(await boundedRequest(key.key));
      assert.notEqual(response.status, 200);
      await response.text();
      assert.equal(observations.length, count);
    } finally {
      getDbInstance().exec("DROP TRIGGER synthetic_attempt_failure");
    }
    assert.ok(readDecisionAttempts(key.id).every((row) => row.state === "cancelled"));
  }
});
test("actual settlement failure retains unknown liability, blocks capped traffic, and reconciles with the original owner after reopen", async () => {
  await ensurePermittedCombo();
  const key = await createApiKey("synthetic-settle-failure", "synthetic");
  const count = observations.length;
  getDbInstance().exec(
    "CREATE TEMP TRIGGER synthetic_usage_failure BEFORE INSERT ON usage_history BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
  );
  let row: Record<string, unknown>;
  try {
    const response = await POST(await boundedRequest(key.key));
    assert.notEqual(response.status, 200);
    await response.text();
    assert.equal(observations.length, count + 1);
    row = readDecisionAttempts(key.id)[0];
    assert.equal(row.state, "unknown");
    assert.equal(row.cost_usd, null);
    upsertKeyQuotaLimits(key.id, { monthlyAmountUsd: 100 });
    const rejected = await POST(await boundedRequest(key.key));
    assert.equal(rejected.status, 429);
    await rejected.text();
    assert.equal(observations.length, count + 1);
  } finally {
    getDbInstance().exec("DROP TRIGGER synthetic_usage_failure");
  }
  resetDbInstance();
  row = readDecisionAttempts(key.id)[0];
  assert.equal(row.state, "unknown");
  const identity = dispatchedIdentities.get(String(row.id));
  assert.ok(identity, "late callback retains its original internal owner capability");
  settleDecisionAttempt(identity, { status: 200, input: 8, output: 4, cost: 0.002 });
  settleDecisionAttempt(identity, { status: 200, input: 8, output: 4, cost: 0.002 });
  assert.equal(readDecisionAttempts(key.id)[0].state, "completed");
  const rows = getDbInstance()
    .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE decision_attempt_id=?")
    .get(row.id) as { n: number };
  assert.equal(rows.n, 1);
});
test("actual cancellation and configured deadline prevent follow-on attempts and retain unknown started cost", async () => {
  const prior = await getComboByName("fixture-permitted-combo");
  assert.ok(prior);
  for (const kind of ["caller", "deadline"]) {
    const key = await createApiKey("synthetic-abort-" + kind, "synthetic");
    const controller = new AbortController();
    let release!: () => void;
    fixtureGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (kind === "deadline")
      await updateCombo(String(prior.id), {
        config: {
          ...prior.config,
          decisionPolicy: {
            ...(prior.config.decisionPolicy as object),
            policy: {
              ...(prior.config.decisionPolicy as { policy: object }).policy,
              timeoutMs: 1000,
            },
          },
        },
      });
    const count = observations.length;
    const began = Date.now();
    const pending = POST(await boundedRequest(key.key, {}, controller.signal));
    try {
      for (let i = 0; i < 200 && observations.length === count; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(observations.length, count + 1);
      if (kind === "caller") controller.abort();
      const response = await pending;
      assert.notEqual(response.status, 200);
      await response.text();
      assert.ok(Date.now() - began < 2500);
      assert.equal(observations.length, count + 1);
      const row = readDecisionAttempts(key.id)[0];
      assert.equal(row.state, "unknown");
      assert.equal(row.cost_usd, null);
    } finally {
      release();
      fixtureGate = null;
      await updateCombo(String(prior.id), { config: prior.config });
    }
  }
  const count = observations.length;
  const controller = new AbortController();
  controller.abort();
  const response = await POST(await boundedRequest(validKey, {}, controller.signal));
  await response.text();
  assert.notEqual(response.status, 200);
  assert.equal(observations.length, count);
});
test("unsupported proxy and TLS policy reject before physical dispatch", async () => {
  const count = observations.length;
  for (const [name, value] of [
    ["HTTPS_PROXY", "http://synthetic-proxy.invalid:8888"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ["ENABLE_TLS_FINGERPRINT", "true"],
  ]) {
    const prior = process.env[name];
    process.env[name] = value;
    try {
      const response = await POST(await boundedRequest());
      assert.notEqual(response.status, 200);
      await response.text();
      assert.equal(observations.length, count);
    } finally {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
});
test("post-guardrail tool injection cannot widen supported capabilities", async () => {
  class AddTools extends BaseGuardrail {
    constructor() {
      super("synthetic-unsupported-tools", { priority: 998 });
    }
    async preCall(payload: unknown) {
      return {
        modifiedPayload: {
          ...(payload as object),
          tools: [
            { type: "function", function: { name: "synthetic", parameters: { type: "object" } } },
          ],
        },
      };
    }
  }
  const rule = new AddTools();
  guardrailRegistry.register(rule);
  const count = observations.length;
  try {
    const response = await POST(await boundedRequest());
    assert.notEqual(response.status, 200);
    await response.text();
    assert.equal(observations.length, count);
  } finally {
    rule.enabled = false;
  }
});
test("reasoning/cache breakdown and malformed token components preserve billed cost independently", async () => {
  const key = await createApiKey("synthetic-breakdown", "synthetic");
  fixtureReasoning = 3;
  try {
    const response = await POST(await boundedRequest(key.key));
    assert.equal(response.status, 200, await response.text());
    const row = readDecisionAttempts(key.id)[0];
    assert.equal(row.reasoning_tokens, 3);
    assert.equal(row.cache_read_tokens, 2);
    const usage = getDbInstance()
      .prepare("SELECT * FROM usage_history WHERE decision_attempt_id=?")
      .get(row.id) as Record<string, unknown>;
    assert.equal(usage.tokens_reasoning, 3);
    assert.equal(usage.tokens_output, 1);
    assert.equal(usage.tokens_cache_read, 2);
  } finally {
    fixtureReasoning = null;
  }
  for (const input of [1.5, -1]) {
    const key = await createApiKey("synthetic-malformed-token", "synthetic");
    fixtureInput = input;
    try {
      const response = await POST(await boundedRequest(key.key));
      await response.text();
      const row = readDecisionAttempts(key.id)[0];
      assert.equal(row.input_tokens, null);
      assert.equal(row.cost_usd, 0.002);
    } finally {
      fixtureInput = 8;
    }
  }
});

test("partial and inconsistent reasoning usage never discard a known billed cost", async () => {
  for (const output of [null, 2]) {
    const key = await createApiKey("synthetic-partial-reasoning", "synthetic");
    fixtureOutput = output;
    fixtureReasoning = 3;
    try {
      const response = await POST(await boundedRequest(key.key));
      await response.text();
      const row = readDecisionAttempts(key.id)[0];
      assert.equal(row.cost_usd, 0.002);
      assert.equal(row.reasoning_tokens, 3);
      assert.equal(row.output_tokens, output);
    } finally {
      fixtureOutput = 4;
      fixtureReasoning = null;
    }
  }
});
test("raw HTTP200 with malformed answer records failed application outcome and retains billed usage", async () => {
  const key = await createApiKey("synthetic-malformed-answer", "synthetic");
  fixtureMalformed = true;
  try {
    const response = await POST(await boundedRequest(key.key));
    await response.text();
    assert.notEqual(response.status, 200);
    const row = readDecisionAttempts(key.id)[0];
    assert.equal(row.http_status, 200);
    assert.equal(row.application_status, response.status);
    assert.equal(row.cost_usd, 0.002);
    const usage = getDbInstance()
      .prepare("SELECT success,status FROM usage_history WHERE decision_attempt_id=?")
      .get(row.id) as { success: number; status: string };
    assert.equal(usage.success, 0);
    assert.equal(Number(usage.status), response.status);
  } finally {
    fixtureMalformed = false;
  }
});
test("oversized provider response is cancelled and stays an unknown outcome without a follow-on send", async () => {
  const key = await createApiKey("synthetic-oversized-answer", "synthetic");
  fixtureOversize = true;
  const count = observations.length;
  try {
    const response = await POST(await boundedRequest(key.key));
    await response.text();
    assert.notEqual(response.status, 200);
    assert.equal(observations.length, count + 1);
    const row = readDecisionAttempts(key.id)[0];
    assert.equal(row.state, "unknown");
    assert.equal(row.cost_usd, null);
  } finally {
    fixtureOversize = false;
  }
});
test("known strict spend is included when a later domain budget is configured", async () => {
  const key = await createApiKey("synthetic-future-budget", "synthetic");
  const response = await POST(await boundedRequest(key.key));
  assert.equal(response.status, 200, await response.text());
  const { setBudget, checkBudget } = await import("../../src/domain/costRules.ts");
  setBudget(key.id, { dailyLimitUsd: 0.001 });
  assert.equal(checkBudget(key.id).allowed, false);
  const count = observations.length;
  const denied = await POST(request("fixture-ordinary-combo", key.key));
  assert.equal(denied.status, 429);
  await denied.text();
  assert.equal(observations.length, count);
});
test("final system prompt expansion cannot exceed the selected profile's context limit", async () => {
  const { setSystemPromptConfig, getSystemPromptConfig } =
    await import("../../open-sse/services/systemPrompt.ts");
  const prior = getSystemPromptConfig();
  const count = observations.length;
  setSystemPromptConfig({
    enabled: true,
    prefixPrompt: "synthetic-context ".repeat(20000),
    suffixPrompt: "",
  });
  try {
    const response = await POST(await boundedRequest());
    await response.text();
    assert.notEqual(response.status, 200);
    assert.equal(observations.length, count);
  } finally {
    setSystemPromptConfig(prior);
  }
});

test("bounded application deadline: policy timeout also bounds the actual executor queue", async () => {
  const { getComboByName, updateCombo } = await import("../../src/lib/db/combos.ts");
  const combo = await getComboByName("fixture-permitted-combo");
  assert.ok(combo);
  const old = structuredClone(combo.config);
  await updateCombo(String(combo.id), {
    config: {
      ...combo.config,
      decisionPolicy: {
        ...combo.config.decisionPolicy,
        policy: { ...combo.config.decisionPolicy.policy, timeoutMs: 1000 },
      },
    },
  });

  const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
  const { acquire } = await import("../../open-sse/services/accountSemaphore.ts");
  await updateProviderConnection(primaryConnectionId, { maxConcurrent: 1 });
  const release = await acquire(`openai:${primaryConnectionId}`, { maxConcurrency: 1 });
  const key = await createApiKey("independent-queue-deadline", "synthetic");
  const count = observations.length;
  const timer = setTimeout(release, 1600);
  const started = Date.now();
  try {
    const response = await POST(await boundedRequest(key.key));
    const text = await response.text();
    const elapsedMs = Date.now() - started;
    assert.equal(response.status, 504, text);
    assert.equal(observations.length, count);
    assert.ok(
      elapsedMs < 1300,
      JSON.stringify({ elapsedMs, policyTimeoutMs: 1000, status: response.status })
    );
  } finally {
    clearTimeout(timer);
    release();
    await updateProviderConnection(primaryConnectionId, { maxConcurrent: null });
    await updateCombo(String(combo.id), { config: old });
  }
});

test("secondary credential headers introduced by formatting are rejected before physical dispatch", async () => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const executor = await getExecutor("openai");
  const original = executor.buildHeaders;
  for (const name of ["x-api-key", "api-key"]) {
    const count = observations.length;
    executor.buildHeaders = function (...args: Parameters<typeof original>) {
      return { ...original.apply(this, args), [name]: "synthetic-secondary-secret" };
    };
    try {
      const response = await POST(await boundedRequest());
      const text = await response.text();
      assert.notEqual(response.status, 200);
      assert.equal(observations.length, count);
      assert.ok(!text.includes("synthetic-secondary-secret"));
    } finally {
      executor.buildHeaders = original;
    }
  }
});

test("unsupported shared-storage adapter rejects native sends while ordinary traffic remains available", async () => {
  await ensurePermittedCombo();
  const key = await createApiKey("synthetic-unsupported-storage", "synthetic");
  const db = getDbInstance();
  const descriptor = Object.getOwnPropertyDescriptor(db, "driver")!;
  const count = observations.length;
  Object.defineProperty(db, "driver", { ...descriptor, value: "sql.js" });
  try {
    const rejected = await POST(await boundedRequest(key.key));
    await rejected.text();
    assert.equal(rejected.status, 409);
    assert.equal(observations.length, count);
    assert.equal(readDecisionAttempts(key.id).length, 0);
    const ordinary = await POST(request("fixture-ordinary-combo", key.key));
    assert.equal(ordinary.status, 200, await ordinary.text());
    assert.equal(observations.length, count + 1);
  } finally {
    Object.defineProperty(db, "driver", descriptor);
  }
});
