import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetch as localFetch } from "undici";
import { writeFile } from "node:fs/promises";
process.env.REQUIRE_API_KEY = "true";
process.env.PII_REDACTION_ENABLED = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.EXPOSE_CC_DISCOVERY_ALIASES = "true";
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { createCombo, deleteCombo } = await import("../../src/lib/db/combos.ts");
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
const { handleChat } = await import("../../src/sse/handlers/chat.ts");
const observations: Array<{ model: unknown; effort: unknown; emailMasked: boolean }> = [];
const events: Array<Record<string, unknown>> = [];
let validKey: string;
let baseUrl: string;
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
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "fixture-local-response",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "synthetic local response" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12, cost: 0.002 },
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
    return (await localFetch(url, init as Parameters<typeof localFetch>[1])) as unknown as Response;
  };
  await updateSettings({
    semanticCacheEnabled: false,
    memoryEnabled: false,
    compressionEnabled: false,
    globalFallbackModel: "openai/gpt-5.4",
    streamDefaultMode: "json",
  });
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "synthetic-local-only",
    apiKey: "synthetic-local-provider-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl },
  });
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
  resetDbInstance();
  if (process.env.APPLICATION_EVIDENCE_PATH)
    await writeFile(
      process.env.APPLICATION_EVIDENCE_PATH,
      JSON.stringify(
        { schemaVersion: 1, synthetic: true, qualityMeasured: false, observations, events },
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
  assert.equal(response.status, 200, await response.text());
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
  assert.equal(response.status, 200, await response.text());
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
  assert.equal(response.status, 200, await response.text());
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
