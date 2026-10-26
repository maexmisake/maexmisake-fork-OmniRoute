import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { before, after, afterEach, test } from "node:test";
import { createCombo, getComboById } from "../../src/lib/db/combos.ts";
import { createProviderConnection, updateProviderConnection } from "../../src/lib/db/providers.ts";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";
import { GET as optionsGET } from "../../src/app/api/decision-routing/options/route.ts";
import {
  GET as policyGET,
  PUT as policyPUT,
} from "../../src/app/api/combos/[id]/decision-policy/route.ts";
import { PUT as tierPUT } from "../../src/app/api/decision-routing/connections/[id]/tier/route.ts";
import type { DecisionPolicyEditorValue } from "../../src/shared/decisionPolicy/configuration.ts";
import { readStoredDecisionSettings } from "../../src/lib/db/decisionPolicySettings.ts";
const oldFetch = globalThis.fetch;
let fetches = 0,
  sequence = 0,
  zen: string,
  openai: string,
  claude: string,
  inferenceKey: string,
  manageKey: string;
const secrets = [
  "synthetic-settings-zen-key",
  "synthetic-settings-openai-key",
  "synthetic-settings-claude-token",
  "synthetic-private-header",
  "private.account@example.invalid",
];
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (path: string) => `http://settings.invalid${path}`;
const session = (path: string, body?: unknown, signal?: AbortSignal) =>
  makeManagementSessionRequest(url(path), {
    method: body === undefined ? "GET" : "PUT",
    body,
  }).then((request) => (signal ? new Request(request, { signal }) : request));
async function combo() {
  return createCombo({
    name: `settings-api-${++sequence}`,
    models: ["openai/fixture-model"],
    config: { untouched: { keep: true } },
  });
}
function policy(enabled = true): DecisionPolicyEditorValue {
  const candidate = (id: string, effort: "medium" | "high") => ({
    id,
    provider: "openai",
    model: "fixture-model",
    endpointKind: "direct" as const,
    evidence: null,
    capabilities: { text: true, tools: null, images: null, reasoning: null, contextTokens: 100000 },
    effort: { mode: "set" as const, value: effort, supported: [effort], evidence: null },
  });
  return {
    enabled,
    applicationMode: "bounded-v1",
    selection: {
      mode: "native",
      provider: "opencode-zen",
      model: "jev-1.13-free",
      connectionId: zen,
      timeoutMs: 500,
      maxCandidates: 32,
    },
    connections: { light: openai, deep: openai },
    policy: {
      version: 1,
      candidates: [candidate("light", "medium"), candidate("deep", "high")],
      taskOrder: { explanation: ["light", "deep"] },
      unknownQuota: "reject",
      decisionFailure: "stop",
      maxDecisionAttempts: 1,
      maxExecutionAttempts: 1,
      timeoutMs: 1000,
    },
  };
}
async function save(
  id: string,
  value: unknown,
  revision = readStoredDecisionSettings(id).revision,
  signal?: AbortSignal
) {
  return policyPUT(
    await session(
      `/api/combos/${id}/decision-policy`,
      { revision, action: "save", policy: value },
      signal
    ),
    context(id)
  );
}
before(async () => {
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("settings test forbids all network calls");
  };
  process.env.ALLOW_API_KEY_REVEAL = "true";
  await updateSettings({ requireLogin: false, cloudEnabled: true });
  zen = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic settings Zen",
        email: secrets[4],
        apiKey: secrets[0],
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  openai = String(
    (
      await createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "synthetic settings OpenAI",
        apiKey: secrets[1],
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    ).id
  );
  claude = String(
    (
      await createProviderConnection({
        provider: "claude",
        authType: "oauth",
        name: "synthetic settings Claude",
        accessToken: secrets[2],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    ).id
  );
  inferenceKey = String((await createApiKey("synthetic inference", "synthetic-machine")).key);
  manageKey = String(
    (await createApiKey("synthetic management", "synthetic-machine", ["manage"])).key
  );
});
afterEach(() => assert.equal(fetches, 0));
after(() => {
  globalThis.fetch = oldFetch;
  delete process.env.ALLOW_API_KEY_REVEAL;
  resetDbInstance();
});

test("every new settings route requires actual management credentials even with login disabled", async () => {
  const c = await combo(),
    id = String(c.id);
  const calls = [
    () => optionsGET(new Request(url("/api/decision-routing/options"))),
    () => policyGET(new Request(url(`/api/combos/${id}/decision-policy`)), context(id)),
    () =>
      policyPUT(
        new Request(url(`/api/combos/${id}/decision-policy`), { method: "PUT", body: "{}" }),
        context(id)
      ),
    () =>
      tierPUT(
        new Request(url(`/api/decision-routing/connections/${zen}/tier`), {
          method: "PUT",
          body: "{}",
        }),
        context(zen)
      ),
  ];
  for (const call of calls) assert.equal((await call()).status, 401);
  assert.equal((await optionsGET(undefined as unknown as Request)).status, 401);
  const header = { authorization: `Bearer ${inferenceKey}` };
  assert.equal(
    (await optionsGET(new Request(url("/api/decision-routing/options"), { headers: header })))
      .status,
    403
  );
  assert.equal(
    (await optionsGET(new Request(url(`/api/decision-routing/options?api_key=${manageKey}`))))
      .status,
    401
  );
  assert.equal(
    (
      await optionsGET(
        new Request(url("/api/decision-routing/options"), {
          headers: { authorization: `Bearer ${manageKey}` },
        })
      )
    ).status,
    200
  );
});

test("options are reveal-independent allowlisted metadata with no raw keys, emails, errors or PSD", async () => {
  await updateProviderConnection(zen, {
    lastError: secrets[3],
    providerSpecificData: {
      systemOneTier: "free",
      headers: { "X-Private": secrets[3] },
      fingerprints: ["private-fingerprint"],
    },
  });
  const response = await optionsGET(await session("/api/decision-routing/options")),
    text = await response.text(),
    view = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(view.bindings.length, 5);
  for (const secret of [...secrets, "private-fingerprint"]) assert.ok(!text.includes(secret));
  for (const item of view.connections)
    assert.deepEqual(
      Object.keys(item).sort(),
      [
        "id",
        "provider",
        "label",
        "active",
        "credentialPresent",
        "freeTier",
        "metadataCompatible",
        "revision",
      ].sort()
    );
  assert.equal(
    view.connections.find((item: { id: string }) => item.id === zen).metadataCompatible,
    false
  );
  assert.equal(
    view.connections.find((item: { id: string }) => item.id === claude).credentialPresent,
    true
  );
  await updateProviderConnection(zen, { providerSpecificData: { systemOneTier: "free" } });
});

test("local save/read/disable preserves sibling config with cloud sync enabled and no network", async () => {
  const c = await combo(),
    id = String(c.id);
  let response = await policyGET(await session(`/api/combos/${id}/decision-policy`), context(id));
  assert.equal((await response.json()).status, "unconfigured");
  response = await save(id, policy());
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.status, "enabled");
  assert.deepEqual((await getComboById(id))!.config?.untouched, { keep: true });
  resetDbInstance();
  response = await policyGET(await session(`/api/combos/${id}/decision-policy`), context(id));
  assert.deepEqual((await response.json()).policy, saved.policy);
  response = await policyPUT(
    await session(`/api/combos/${id}/decision-policy`, {
      revision: saved.revision,
      action: "disable",
    }),
    context(id)
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "disabled");
});

test("disabled empty drafts persist, whereas enabled empty and single native candidate configurations reject", async () => {
  const c = await combo(),
    id = String(c.id),
    draft = policy(false);
  draft.policy.candidates = [];
  draft.policy.taskOrder = {};
  draft.connections = {};
  assert.equal((await save(id, draft)).status, 200);
  draft.enabled = true;
  assert.equal((await save(id, draft)).status, 400);
  const single = policy();
  single.policy.candidates.pop();
  single.policy.taskOrder = { explanation: ["light"] };
  delete single.connections.deep;
  assert.equal((await save(id, single)).status, 400);
});

for (const defect of [
  "missing-tier",
  "paid-tier",
  "extra-metadata",
  "inactive",
  "wrong-provider",
  "unsupported-effort",
  "missing-supported-efforts",
  "unknown-text",
  "foreign-model",
  "missing-connection",
  "recursive-model",
  "credential-field",
]) {
  test(`activation rejects ${defect} without mutation or provider calls`, async () => {
    const c = await combo(),
      id = String(c.id),
      value = policy();
    const original = readStoredDecisionSettings(id).revision;
    if (defect === "missing-tier")
      await updateProviderConnection(zen, { providerSpecificData: {} });
    else if (defect === "paid-tier")
      await updateProviderConnection(zen, { providerSpecificData: { systemOneTier: "paid" } });
    else if (defect === "extra-metadata")
      await updateProviderConnection(zen, {
        providerSpecificData: { systemOneTier: "free", headers: { "User-Agent": "fake" } },
      });
    else if (defect === "inactive") await updateProviderConnection(zen, { isActive: false });
    else if (defect === "wrong-provider")
      value.selection = {
        ...(value.selection as Extract<DecisionPolicyEditorValue["selection"], { mode: "native" }>),
        connectionId: openai,
      };
    else if (defect === "unsupported-effort") value.policy.candidates[0].effort.supported = ["low"];
    else if (defect === "missing-supported-efforts")
      value.policy.candidates[0].effort.supported = null;
    else if (defect === "unknown-text") value.policy.candidates[0].capabilities.text = null;
    else if (defect === "foreign-model")
      (value.selection as { model: string }).model = "typesafe/jev-1.14-20261014";
    else if (defect === "missing-connection") value.connections.light = "nonexistent";
    else if (defect === "recursive-model") value.policy.candidates[0].model = String(c.name);
    else Object.assign(value, { apiKey: secrets[0] });
    try {
      const response = await save(id, value);
      assert.equal(response.status, 400);
      const text = await response.text();
      for (const secret of secrets) assert.ok(!text.includes(secret));
      assert.equal(readStoredDecisionSettings(id).revision, original);
    } finally {
      await updateProviderConnection(zen, {
        isActive: true,
        providerSpecificData: { systemOneTier: "free" },
      });
    }
  });
}

test("both supported Claude effort profiles can activate through local contract validation", async () => {
  const c = await combo(),
    id = String(c.id),
    value = policy();
  for (const row of value.policy.candidates) {
    row.provider = "claude";
    row.model = "claude-opus-5-5";
    value.connections[row.id] = claude;
  }
  assert.equal((await save(id, value)).status, 200);
  value.policy.candidates[0].effort.value = "low";
  value.policy.candidates[0].effort.supported = ["low"];
  assert.equal((await save(id, value)).status, 400);
});

test("malformed stored policy is not echoed, can be disabled, and stale revisions return409", async () => {
  const c = await createCombo({
      name: `settings-api-invalid-${++sequence}`,
      models: ["openai/fixture"],
      config: { decisionPolicy: { credential: secrets[0] }, keep: 1 },
    }),
    id = String(c.id);
  const get = await policyGET(await session(`/api/combos/${id}/decision-policy`), context(id)),
    text = await get.text(),
    view = JSON.parse(text);
  assert.equal(view.status, "invalid");
  assert.equal(view.policy, null);
  assert.ok(!text.includes(secrets[0]));
  const response = await policyPUT(
    await session(`/api/combos/${id}/decision-policy`, {
      revision: view.revision,
      action: "disable",
    }),
    context(id)
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "disabled");
  assert.equal((await save(id, policy(), view.revision)).status, 409);
});

test("tier edit changes only metadata marker, stale edit rejects, and unknown fields/other provider reject", async () => {
  const getOptions = async () =>
    (await (await optionsGET(await session("/api/decision-routing/options"))).json()).connections;
  const before = (await getOptions()).find((row: { id: string }) => row.id === zen);
  getDbInstance()
    .prepare("UPDATE provider_connections SET last_error=?,backoff_level=? WHERE id=?")
    .run("keep health", 3, zen);
  assert.equal(
    (
      await tierPUT(
        await session(`/api/decision-routing/connections/${zen}/tier`, {
          revision: before.revision,
          tier: "paid",
        }),
        context(zen)
      )
    ).status,
    409
  );
  const fresh = (await getOptions()).find((row: { id: string }) => row.id === zen);
  const response = await tierPUT(
    await session(`/api/decision-routing/connections/${zen}/tier`, {
      revision: fresh.revision,
      tier: "paid",
    }),
    context(zen)
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.freeTier, false);
  assert.equal(result.metadataCompatible, true);
  const row = getDbInstance()
    .prepare("SELECT last_error,backoff_level FROM provider_connections WHERE id=?")
    .get(zen);
  assert.deepEqual(row, { last_error: "keep health", backoff_level: 3 });
  assert.equal(
    (
      await tierPUT(
        await session(`/api/decision-routing/connections/${zen}/tier`, {
          revision: result.revision,
          tier: "free",
          apiKey: secrets[0],
        }),
        context(zen)
      )
    ).status,
    400
  );
  const other = (await getOptions()).find((row: { id: string }) => row.id === openai);
  assert.equal(
    (
      await tierPUT(
        await session(`/api/decision-routing/connections/${openai}/tier`, {
          revision: other.revision,
          tier: "free",
        }),
        context(openai)
      )
    ).status,
    400
  );
  await updateProviderConnection(zen, { providerSpecificData: { systemOneTier: "free" } });
});

test("malformed JSON, oversized bodies and cancellation prevent writes", async () => {
  const c = await combo(),
    id = String(c.id),
    initial = readStoredDecisionSettings(id).revision;
  for (const body of ["{", "x".repeat(65537)]) {
    const request = await makeManagementSessionRequest(url(`/api/combos/${id}/decision-policy`), {
      method: "PUT",
      body,
    });
    assert.equal((await policyPUT(request, context(id))).status, 400);
  }
  const abort = new AbortController();
  abort.abort();
  assert.equal((await save(id, policy(), initial, abort.signal)).status, 499);
  assert.equal(readStoredDecisionSettings(id).revision, initial);
});

test("abort while streamed request body is pending cancels body reader and never writes", async () => {
  const c = await combo(),
    id = String(c.id),
    initial = readStoredDecisionSettings(id).revision;
  const abort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const headers = (await session(`/api/combos/${id}/decision-policy`)).headers;
  const request = new Request(url(`/api/combos/${id}/decision-policy`), {
    method: "PUT",
    headers,
    body,
    signal: abort.signal,
    duplex: "half",
  } as RequestInit);
  const pending = policyPUT(request, context(id));
  await new Promise((resolve) => setTimeout(resolve, 20));
  abort.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(cancelled, true);
  assert.equal(readStoredDecisionSettings(id).revision, initial);
});

test("all five exact native bindings and deterministic selection persist only explicit profiles", async () => {
  const bindings = [
    { provider: "opencode-zen", model: "jev-1.13-free", connectionId: zen },
    {
      provider: "opencode-zen",
      model: "jev-1.13",
      connectionId: String(
        (
          await createProviderConnection({
            provider: "opencode-zen",
            name: "synthetic-paid-zen",
            authType: "apikey",
            apiKey: "synthetic-paid-zen-key",
            isActive: true,
            providerSpecificData: {},
          })
        ).id
      ),
    },
  ];
  for (const [provider, model] of [
    ["typesafe", "jev-1.14.0"],
    ["openrouter", "typesafe/jev-1.14-20261014"],
    ["vercel-ai-gateway", "typesafe-ai/jev"],
  ])
    bindings.push({
      provider,
      model,
      connectionId: String(
        (
          await createProviderConnection({
            provider,
            name: `synthetic-${provider}`,
            authType: "apikey",
            apiKey: `synthetic-${provider}-settings-key`,
            isActive: true,
            providerSpecificData: {},
          })
        ).id
      ),
    });
  for (const binding of bindings) {
    const c = await combo(),
      value = policy();
    Object.assign(value.selection!, binding);
    assert.equal(
      (await save(String(c.id), value)).status,
      200,
      binding.provider + "/" + binding.model
    );
  }
  const c = await combo(),
    value = policy();
  value.selection = { mode: "deterministic" };
  value.policy.maxDecisionAttempts = 0;
  assert.equal((await save(String(c.id), value)).status, 200);
});

test("inference-only and URL-borne credentials cannot mutate policy or tier", async () => {
  const c = await combo(),
    id = String(c.id),
    initial = readStoredDecisionSettings(id).revision;
  for (const bearer of [false, true]) {
    const headers = {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${inferenceKey}` } : {}),
    };
    const suffix = bearer ? "" : `?api_key=${manageKey}`;
    const policyResponse = await policyPUT(
      new Request(url(`/api/combos/${id}/decision-policy${suffix}`), {
        method: "PUT",
        headers,
        body: JSON.stringify({ revision: initial, action: "save", policy: policy() }),
      }),
      context(id)
    );
    const tierResponse = await tierPUT(
      new Request(url(`/api/decision-routing/connections/${zen}/tier${suffix}`), {
        method: "PUT",
        headers,
        body: JSON.stringify({ revision: "a".repeat(64), tier: "paid" }),
      }),
      context(zen)
    );
    assert.equal(policyResponse.status, bearer ? 403 : 401);
    assert.equal(tierResponse.status, bearer ? 403 : 401);
  }
  assert.equal(readStoredDecisionSettings(id).revision, initial);
});

test("management API rejects unacknowledged or malformed native output policy without writes", async () => {
  const id = String((await combo()).id);
  const revision = readStoredDecisionSettings(id).revision;
  for (const nativeOutput of [
    undefined,
    { acknowledgeNoTokenCeiling: false, contextOutputTokens: 64 },
    { acknowledgeNoTokenCeiling: true },
    { acknowledgeNoTokenCeiling: true, contextOutputTokens: 0 },
    { acknowledgeNoTokenCeiling: true, contextOutputTokens: "64" },
    { acknowledgeNoTokenCeiling: true, contextOutputTokens: 1000001 },
    { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64, enforceCeiling: true },
  ]) {
    assert.equal(
      (
        await save(id, {
          ...policy(),
          applicationMode: "provider-native-output-v1",
          nativeOutput,
        })
      ).status,
      400
    );
    assert.equal(readStoredDecisionSettings(id).revision, revision);
  }
});

test("management API persists explicit native output acknowledgement and planning without inference", async () => {
  const id = String((await combo()).id);
  const value: DecisionPolicyEditorValue = {
    ...policy(),
    applicationMode: "provider-native-output-v1",
    nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64 },
  };
  assert.equal((await save(id, value)).status, 200);
  const response = await policyGET(await session(`/api/combos/${id}/decision-policy`), context(id));
  const view = await response.json();
  assert.equal(view.policy.applicationMode, "provider-native-output-v1");
  assert.deepEqual(view.policy.nativeOutput, value.nativeOutput);
  assert.deepEqual(view.policy.policy.candidates, value.policy.candidates);
  assert.equal(view.status, "enabled");
  for (const secret of secrets) assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(fetches, 0);
});

test("native execution profiles activate only through exact stored contract validation", async () => {
  for (const [provider, model, effort, fixed] of [
    ["codex", "gpt-6-luna", "max", true],
    ["codex", "gpt-6-sol", "max", false],
    ["agy", "claude-opus-4-6-thinking", "high", true],
    ["agy", "gemini-3.8-flash-high", "high", true],
  ] as const) {
    const connection = await createProviderConnection({
      provider,
      authType: "oauth",
      name: "synthetic native-output settings account",
      accessToken: "synthetic-native-output-settings-token",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData:
        provider === "codex"
          ? { workspaceId: "synthetic-workspace" }
          : { projectId: "synthetic-project" },
    });
    const value: DecisionPolicyEditorValue = {
      ...policy(),
      applicationMode: "provider-native-output-v1",
      nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64 },
    };
    value.policy.candidates[0] = {
      ...value.policy.candidates[0],
      provider,
      model,
      effort: {
        mode: fixed ? "fixed" : "set",
        value: effort,
        supported: [effort],
        evidence: "Synthetic original fixed/set profile",
      },
    };
    value.connections.light = String(connection.id);
    const id = String((await combo()).id);
    assert.equal((await save(id, value)).status, 200, provider + "/" + model);
    const bounded = { ...value, applicationMode: "bounded-v1", nativeOutput: undefined };
    if (model !== "gemini-3.8-flash-high") assert.equal((await save(id, bounded)).status, 400);
    assert.equal(fetches, 0);
  }
});
