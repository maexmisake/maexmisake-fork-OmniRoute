import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { DecisionPolicyEditorValue } from "../../../src/shared/decisionPolicy/configuration.ts";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
const { runAuthzPipeline } = await import("../../../src/server/authz/pipeline.ts");
const { isAlwaysProtectedPath } = await import("../../../src/server/authz/routeGuard.ts");
const { classifyRoute } = await import("../../../src/server/authz/classify.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { createAccessToken } = await import("../../../src/lib/db/accessTokens.ts");
const { inferRequiredScope } = await import("../../../src/server/authz/accessScopes.ts");
const { prepareAutomaticCombo } =
  await import("../../../src/lib/decisionPolicy/applicationCombo.ts");
const { createCombo } = await import("../../../src/lib/db/combos.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { readStoredDecisionSettings } =
  await import("../../../src/lib/db/decisionPolicySettings.ts");
const { GET: optionsGET } = await import("../../../src/app/api/decision-routing/options/route.ts");
const { GET: policyGET, PUT: policyPUT } =
  await import("../../../src/app/api/combos/[id]/decision-policy/route.ts");
const { PUT: tierPUT } =
  await import("../../../src/app/api/decision-routing/connections/[id]/tier/route.ts");
const origin = "https://dashboard.example.invalid";
const fixture = {
  enabled: false,
  applicationMode: "bounded-v1",
  selection: { mode: "deterministic" },
  connections: {},
  policy: {
    version: 1,
    candidates: [],
    taskOrder: {},
    unknownQuota: "reject",
    decisionFailure: "stop",
    maxDecisionAttempts: 0,
    maxExecutionAttempts: 1,
    timeoutMs: 1000,
  },
};
let inferenceKey: string;
let sequence = 0;
let unexpectedFetches = 0;
const unexpectedPaths: string[] = [];
const originalFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = async (input) => {
    unexpectedFetches++;
    try {
      const parsed = new URL(input instanceof Request ? input.url : String(input));
      unexpectedPaths.push(parsed.origin + parsed.pathname);
    } catch {
      unexpectedPaths.push("relative-or-invalid-url");
    }
    throw new Error("Synthetic management tests prohibit outbound calls");
  };
  await updateSettings({ requireLogin: false, cloudEnabled: true });
  inferenceKey = String((await createApiKey("synthetic-inference-only", "synthetic-machine")).key);
});
afterEach(() => assert.equal(unexpectedFetches, 0, JSON.stringify(unexpectedPaths)));
after(() => {
  globalThis.fetch = originalFetch;
  resetDbInstance();
});
const paths = [
  "/api/decision-routing/options",
  "/api/combos/synthetic-combo/decision-policy",
  "/api/decision-routing/connections/synthetic-connection/tier",
];
const context = (id: string) => ({ params: Promise.resolve({ id }) });

for (const path of paths) {
  test(`decision settings exact path is protected management: ${path}`, () => {
    assert.equal(classifyRoute(path).routeClass, "MANAGEMENT");
    assert.equal(isAlwaysProtectedPath(path), true);
    assert.equal(isAlwaysProtectedPath(`${path}/`), true);
  });
  test(`decision settings pipeline denies anonymous and inference-only credentials: ${path}`, async () => {
    const anonymous = await runAuthzPipeline(new NextRequest(origin + path), { enforce: true });
    assert.equal(anonymous.status, 401);
    const inference = await runAuthzPipeline(
      new NextRequest(origin + path, {
        headers: { authorization: `Bearer ${inferenceKey}` },
      }),
      { enforce: true }
    );
    assert.equal(inference.status, 403);
    const session = await makeManagementSessionRequest(origin + path);
    const accepted = await runAuthzPipeline(new NextRequest(session), { enforce: true });
    assert.equal(accepted.status, 200);
  });
}

test("nearby ordinary routes keep their original open-login classification", async () => {
  for (const path of [
    "/api/decision-routing/options-extra",
    "/api/decision-routing/options/extra",
    "/api/decision-routing/connections/synthetic-connection/tier-extra",
    "/api/decision-routing/connections/synthetic-connection/tier/extra",
    "/api/decision-routing/connections/synthetic-connection",
    "/api/combos/synthetic-combo/decision-policy-extra",
    "/api/combos/synthetic-combo/decision-policy/extra",
    "/api/combos/synthetic-combo",
    "/api/combos",
    "/api/providers/synthetic-connection",
  ]) {
    assert.equal(isAlwaysProtectedPath(path), false, path);
    const response = await runAuthzPipeline(new NextRequest(origin + path), { enforce: true });
    assert.equal(response.status, 200, path);
  }
});

for (const kind of ["policy", "tier"] as const) {
  test(`foreign-origin cookie ${kind} mutation is rejected before actual handler persistence`, async () => {
    const combo = await createCombo({
      name: `management-origin-${++sequence}`,
      models: ["openai/synthetic-model"],
      config: { keep: true },
    });
    const id = String(combo.id);
    const before = readStoredDecisionSettings(id);
    const connection = await createProviderConnection({
      provider: "opencode-zen",
      authType: "apikey",
      apiKey: "synthetic-management-fixture-key",
      name: `management-origin-${sequence}`,
      isActive: true,
    });
    const optionRequest = await makeManagementSessionRequest(origin + paths[0]);
    const options = await (await optionsGET(optionRequest)).json();
    const row = options.connections.find((item: { id: string }) => item.id === connection.id);
    const path =
      kind === "policy"
        ? `/api/combos/${id}/decision-policy`
        : `/api/decision-routing/connections/${connection.id}/tier`;
    const body =
      kind === "policy"
        ? { action: "save", revision: before.revision, policy: fixture }
        : { revision: row.revision, tier: "free" };
    const cookieRequest = await makeManagementSessionRequest(origin + path, {
      method: "PUT",
      headers: { origin: "https://foreign.example.invalid", "sec-fetch-site": "cross-site" },
      body,
    });
    const request = new NextRequest(cookieRequest);
    const boundary = await runAuthzPipeline(request, { enforce: true });
    // Simulate the server dispatch only when the real middleware allowed it.
    const result =
      boundary.status >= 400
        ? boundary
        : kind === "policy"
          ? await policyPUT(request, context(id))
          : await tierPUT(request, context(String(connection.id)));
    assert.equal(result.status, 403);
    assert.equal(readStoredDecisionSettings(id).revision, before.revision);
    const final = await (await optionsGET(optionRequest)).json();
    assert.equal(
      final.connections.find((item: { id: string }) => item.id === connection.id).freeTier,
      false
    );
  });
}

test("same-origin session save passes actual middleware and local persistence without provider calls", async () => {
  const combo = await createCombo({
    name: `management-valid-${++sequence}`,
    models: ["openai/synthetic-model"],
    config: { keep: true },
  });
  const id = String(combo.id),
    before = readStoredDecisionSettings(id);
  const cookieRequest = await makeManagementSessionRequest(
    origin + `/api/combos/${id}/decision-policy`,
    {
      method: "PUT",
      headers: { origin, "sec-fetch-site": "same-origin" },
      body: { action: "save", revision: before.revision, policy: fixture },
    }
  );
  const request = new NextRequest(cookieRequest);
  const middleware = await runAuthzPipeline(request, { enforce: true });
  assert.equal(middleware.status, 200);
  const response = await policyPUT(request, context(id));
  assert.equal(response.status, 200);
  assert.deepEqual(readStoredDecisionSettings(id).rawPolicy, fixture);
});

test("Zen tier mutations preserve provider-admin scope while nearby combo settings retain write scope", async () => {
  const path = "/api/decision-routing/connections/synthetic-id/tier";
  for (const method of ["PUT", "PATCH", "POST", "DELETE"]) {
    assert.equal(inferRequiredScope(method, path), "admin");
    assert.equal(inferRequiredScope(method, `${path}/`), "admin");
  }
  assert.equal(inferRequiredScope("GET", path), "read");
  assert.equal(inferRequiredScope("PUT", `${path}-extra`), "write");
  assert.equal(inferRequiredScope("PUT", `${path}/extra`), "write");
  assert.equal(inferRequiredScope("GET", "/api/decision-routing/options"), "read");
  assert.equal(inferRequiredScope("PUT", "/api/combos/synthetic-id/decision-policy"), "write");
  const connection = await createProviderConnection({
    provider: "opencode-zen",
    authType: "apikey",
    apiKey: "synthetic-admin-fixture-key",
    name: `management-scope-${++sequence}`,
    isActive: true,
  });
  const id = String(connection.id);
  const view = await (
    await optionsGET(await makeManagementSessionRequest(origin + paths[0]))
  ).json();
  const row = view.connections.find((item: { id: string }) => item.id === id);
  const actualPath = `/api/decision-routing/connections/${id}/tier`;
  const writer = createAccessToken({ name: "synthetic-write-scope", scope: "write" });
  const request = new NextRequest(origin + actualPath, {
    method: "PUT",
    headers: { authorization: `Bearer ${writer.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ revision: row.revision, tier: "free" }),
  });
  assert.equal((await runAuthzPipeline(request, { enforce: true })).status, 403);
  assert.equal((await tierPUT(request, context(id))).status, 403);
  const admin = createAccessToken({ name: "synthetic-admin-scope", scope: "admin" });
  const permitted = new NextRequest(origin + actualPath, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ revision: row.revision, tier: "free" }),
  });
  assert.equal((await runAuthzPipeline(permitted, { enforce: true })).status, 200);
  assert.equal((await tierPUT(permitted, context(id))).status, 200);
});

test("actual settings PUT and GET feed exact stored native configuration into application admission without inference", async () => {
  const selector = await createProviderConnection({
    provider: "opencode-zen",
    authType: "apikey",
    apiKey: "synthetic-saved-selector-key",
    name: `management-recognize-selector-${++sequence}`,
    isActive: true,
    providerSpecificData: { systemOneTier: "free" },
  });
  const execution = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "synthetic-saved-execution-key",
    name: `management-recognize-execution-${sequence}`,
    isActive: true,
    providerSpecificData: {},
  });
  const combo = await createCombo({
    name: `management-recognize-${sequence}`,
    models: ["openai/synthetic-model"],
    config: { keep: true },
  });
  const id = String(combo.id),
    key = await createApiKey("synthetic-recognition-client", "synthetic-machine");
  const candidate = (candidateId: string, effort: "medium" | "high") => ({
    id: candidateId,
    provider: "openai",
    model: "synthetic-model",
    endpointKind: "direct" as const,
    evidence: null,
    capabilities: { text: true, images: null, tools: null, reasoning: null, contextTokens: 100000 },
    effort: { mode: "set" as const, value: effort, supported: [effort], evidence: null },
  });
  const policy: DecisionPolicyEditorValue = {
    enabled: true,
    applicationMode: "bounded-v1",
    selection: {
      mode: "native",
      provider: "opencode-zen",
      model: "jev-1.13-free",
      connectionId: String(selector.id),
      timeoutMs: 500,
      maxCandidates: 32,
    },
    connections: { light: String(execution.id), deep: String(execution.id) },
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
  const path = origin + `/api/combos/${id}/decision-policy`;
  const response = await policyPUT(
    await makeManagementSessionRequest(path, {
      method: "PUT",
      body: { revision: readStoredDecisionSettings(id).revision, action: "save", policy },
    }),
    context(id)
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "enabled");
  const reloaded = await policyGET(await makeManagementSessionRequest(path), context(id));
  assert.deepEqual((await reloaded.json()).policy, policy);
  const body = {
    model: String(combo.name),
    messages: [{ role: "user", content: "Explain a variable." }],
    stream: false,
    max_completion_tokens: 64,
  };
  const plan = await prepareAutomaticCombo(String(combo.name), body, String(key.id));
  assert.ok(plan && !(plan instanceof Response));
  assert.deepEqual(plan.config.selection, policy.selection);
  const saved = readStoredDecisionSettings(id);
  for (const override of [
    { selection: { provider: "typesafe", connectionId: "unoffered-fixture" } },
    { decisionPolicy: { enabled: true } },
    { config: { decisionPolicy: { enabled: true } } },
    { connectionId: "unoffered-fixture" },
  ]) {
    const rejected = await prepareAutomaticCombo(
      String(combo.name),
      { ...body, ...override },
      String(key.id)
    );
    assert.ok(rejected instanceof Response);
    assert.equal(rejected.status, 409);
    assert.equal(readStoredDecisionSettings(id).revision, saved.revision);
    assert.deepEqual(readStoredDecisionSettings(id).rawPolicy, policy);
  }
});
