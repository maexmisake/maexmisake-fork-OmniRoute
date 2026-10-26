/**
 * `POST /v1/systemone` and `GET /v1/systemone/models` at the route level.
 *
 * Drives the REAL route handlers against a throwaway database: real
 * authentication (`enforceClientApiRouteAuth`), real API-key policy
 * (`enforceApiKeyPolicy`, including the `systemone` endpoint category), real
 * envelope validation and real candidate resolution. Nothing is mocked except
 * `globalThis.fetch`, which is replaced by a tripwire — a decision route must
 * never reach an upstream in a unit test, and every assertion below is reached
 * before any credential exists to dispatch with.
 *
 * What this file is responsible for (the attempt loop itself is proven in
 * tests/unit/systemone-dispatch.test.ts):
 *  - the order of the gates: JSON → envelope → auth → key policy → routing;
 *  - a restricted key is actually stopped by the `systemone` category;
 *  - no response, at any gate, echoes the caller's `state`;
 *  - the catalog route answers read-only and uncached with the key's scope.
 *
 * Self-isolating: DATA_DIR points at a fresh temp dir BEFORE any `@/lib/db/*`
 * module loads, so this file never touches ~/.omniroute.
 *
 * Run with:
 *   node --import tsx/esm --test tests/unit/systemone-route.test.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "systemone-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "systemone-route-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const decisionRoute = await import("../../src/app/api/v1/systemone/route.ts");
const modelsRoute = await import("../../src/app/api/v1/systemone/models/route.ts");

/** The caller's own data. It must not appear in any error body. */
const STATE = "patient record: Jane Doe, flagged for review";

type ErrorBody = { error: { message: string; type?: string; code?: string } };

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
const originalRequireApiKey = process.env.REQUIRE_API_KEY;

before(() => {
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls++;
    throw new Error(`unit tests must not reach the network: ${String(input)}`);
  }) as typeof fetch;
  // Keyless/local mode unless a test opts into enforcement.
  delete process.env.REQUIRE_API_KEY;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = originalRequireApiKey;
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function decisionRequest(body: unknown, apiKey?: string, raw?: string) {
  return new Request("http://localhost:20128/v1/systemone", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: raw ?? JSON.stringify(body),
  });
}

function modelsRequest(apiKey?: string) {
  return new Request("http://localhost:20128/v1/systemone/models", {
    method: "GET",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

async function post(body: unknown, apiKey?: string, raw?: string) {
  const response = await decisionRoute.POST(decisionRequest(body, apiKey, raw));
  return { response, body: (await response.clone().json()) as ErrorBody };
}

function noulRequest(model: string) {
  return {
    model,
    state: STATE,
    questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
  };
}

test("OPTIONS advertises the methods each System One route serves", async () => {
  const decision = await decisionRoute.OPTIONS();
  assert.match(decision.headers.get("Access-Control-Allow-Methods") || "", /POST/);
  assert.match(decision.headers.get("Access-Control-Allow-Methods") || "", /OPTIONS/);

  const models = await modelsRoute.OPTIONS();
  assert.match(models.headers.get("Access-Control-Allow-Methods") || "", /GET/);
  assert.match(models.headers.get("Access-Control-Allow-Methods") || "", /OPTIONS/);
});

test("a body that is not JSON is rejected before anything else runs", async () => {
  const { response, body } = await post(null, undefined, "{not json");
  assert.equal(response.status, 400);
  assert.match(body.error.message, /JSON/i);
});

test("the request envelope is validated and the failure names only the field", async () => {
  const missingState = await post({
    model: "jev",
    questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
  });
  assert.equal(missingState.response.status, 400);
  assert.match(missingState.body.error.message, /state/i);

  const noQuestions = await post({ model: "jev", state: STATE, questions: {} });
  assert.equal(noQuestions.response.status, 400);
  assert.match(noQuestions.body.error.message, /questions/i);

  const badQuestion = await post({
    model: "jev",
    state: STATE,
    questions: { urgent: { instructions: "is it urgent?" } },
  });
  assert.equal(badQuestion.response.status, 400);
  assert.match(badQuestion.body.error.message, /questions\.urgent\.type/);

  for (const probe of [missingState, noQuestions, badQuestion]) {
    assert.ok(
      !probe.body.error.message.includes(STATE),
      "a validation failure must not echo the caller's state"
    );
    assert.ok(!probe.body.error.message.includes("at /"), "no stack traces in error bodies");
  }
  assert.equal(fetchCalls, 0);
});

test("an unroutable model is rejected without selecting a credential", async () => {
  const unknown = await post(noulRequest("gpt-4o-mini"));
  assert.equal(unknown.response.status, 400);
  assert.match(unknown.body.error.message, /System One/);

  const wrongProvider = await post(noulRequest("anthropic/claude-sonnet-4"));
  assert.equal(wrongProvider.response.status, 400);
  assert.match(wrongProvider.body.error.message, /does not support System One/);

  const unsafe = await post(noulRequest("../../etc/passwd"));
  assert.equal(unsafe.response.status, 400);

  assert.equal(fetchCalls, 0);
});

test("a configured backend with no connection answers 400, never an upstream call", async () => {
  // openrouter requires a key, so there is no keyless fallback connection to
  // synthesize: the selector finds nothing and the route must say so.
  const { response, body } = await post(noulRequest("openrouter/typesafe/jev-1.13"));
  assert.equal(response.status, 400);
  assert.match(body.error.message, /openrouter/);
  assert.ok(!body.error.message.includes(STATE));
  assert.equal(fetchCalls, 0);
});

test("a bare alias with no configured backend names the backends to configure", async () => {
  // The fan-out is restricted to backends this installation actually has a
  // connection for, so an unconfigured install gets one actionable answer
  // instead of a per-provider "no connection" error from the last candidate.
  const { response, body } = await post(noulRequest("jev"));
  assert.equal(response.status, 400);
  assert.match(body.error.message, /Configure one of/i);
  assert.match(body.error.message, /opencode-zen/);
  assert.ok(!body.error.message.includes(STATE));
  assert.equal(fetchCalls, 0);
});

test("authentication is enforced before the key policy when keys are required", async () => {
  process.env.REQUIRE_API_KEY = "true";
  try {
    const anonymous = await post(noulRequest("openrouter/typesafe/jev-1.13"));
    assert.equal(anonymous.response.status, 401);

    const invalid = await post(noulRequest("openrouter/typesafe/jev-1.13"), "sk-not-a-real-key");
    assert.equal(invalid.response.status, 401);

    const models = await modelsRoute.GET(modelsRequest());
    assert.equal(models.status, 401);
  } finally {
    delete process.env.REQUIRE_API_KEY;
  }
  assert.equal(fetchCalls, 0);
});

test("a key without the systemone category cannot reach either route", async () => {
  const chatOnly = await apiKeysDb.createApiKey("systemone-chat-only", "machine-systemone-a", []);
  await apiKeysDb.updateApiKeyPermissions(chatOnly.id, { allowedEndpoints: ["chat"] });
  apiKeysDb.clearApiKeyCaches();

  const decision = await post(noulRequest("openrouter/typesafe/jev-1.13"), chatOnly.key);
  assert.equal(decision.response.status, 403);
  assert.match(decision.body.error.message, /systemone/);

  const models = await modelsRoute.GET(modelsRequest(chatOnly.key));
  assert.equal(models.status, 403);

  assert.equal(fetchCalls, 0);
});

test("a key scoped to systemone passes the category gate and reaches routing", async () => {
  const scoped = await apiKeysDb.createApiKey("systemone-scoped", "machine-systemone-b", []);
  await apiKeysDb.updateApiKeyPermissions(scoped.id, { allowedEndpoints: ["systemone"] });
  apiKeysDb.clearApiKeyCaches();

  const { response, body } = await post(noulRequest("openrouter/typesafe/jev-1.13"), scoped.key);
  assert.equal(response.status, 400);
  assert.match(body.error.message, /openrouter/);

  const models = await modelsRoute.GET(modelsRequest(scoped.key));
  assert.equal(models.status, 200);
  assert.equal(fetchCalls, 0);
});

test("the catalog answers read-only, uncached and honest about being unconfigured", async () => {
  const response = await modelsRoute.GET(modelsRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-OmniRoute-Catalog-Status"), "unconfigured");

  const body = (await response.json()) as { object: string; data: unknown[] };
  assert.equal(body.object, "list");
  assert.deepEqual(body.data, []);
  assert.equal(fetchCalls, 0);
});

test("both routes are dynamic so no decision is ever served from a build cache", async () => {
  assert.equal(decisionRoute.dynamic, "force-dynamic");
  assert.equal(modelsRoute.dynamic, "force-dynamic");
});

for (const header of ["X-OmniRoute-Lease-Owner", "X-OmniRoute-Lease-Generation"]) {
  test(`native routes reject unsupported explicit session context ${header} before dispatch`, async () => {
    const client = await apiKeysDb.createApiKey(
      "synthetic-native-lease-header",
      "synthetic-machine"
    );
    const postRequest = decisionRequest(
      noulRequest("opencode-zen/jev-1.13-free"),
      String(client.key)
    );
    postRequest.headers.set(header, "synthetic-context");
    const catalogRequest = modelsRequest(String(client.key));
    catalogRequest.headers.set(header, "synthetic-context");
    const count = fetchCalls;
    for (const response of [
      await decisionRoute.POST(postRequest),
      await modelsRoute.GET(catalogRequest),
    ]) {
      assert.equal(response.status, 409);
      const body = await response.text();
      assert.ok(body.includes("LEASE_UNSUPPORTED_ROUTE"));
      assert.ok(!body.includes("synthetic-context"));
    }
    assert.equal(fetchCalls, count);
  });
}

test("an exclusively leased native catalog connection is never probed", async () => {
  const providers = await import("../../src/lib/db/providers.ts");
  const { acquireExclusiveConnectionLease, releaseExclusiveConnectionLease } =
    await import("../../src/lib/db/exclusiveConnectionLeases.ts");
  const holder = await apiKeysDb.createApiKey(
    "synthetic-catalog-lease-holder",
    "synthetic-machine"
  );
  const connection = await providers.createProviderConnection({
    provider: "typesafe",
    authType: "apikey",
    name: "synthetic-leased-catalog",
    apiKey: "synthetic-catalog-key",
    isActive: true,
  });
  const owner = `vlo_${"b".repeat(43)}`;
  const claim = acquireExclusiveConnectionLease({
    leaseOwnerId: owner,
    apiKeyId: String(holder.id),
    provider: "typesafe",
    connectionId: String(connection.id),
  });
  assert.ok("lease" in claim && claim.kind === "ACQUIRED");
  const count = fetchCalls;
  try {
    const response = await modelsRoute.GET(modelsRequest());
    await response.text();
    assert.equal(
      fetchCalls,
      count,
      "catalog must not send any credential-bearing metadata request for the leased connection"
    );
  } finally {
    releaseExclusiveConnectionLease({
      leaseOwnerId: owner,
      apiKeyId: String(holder.id),
      generation: claim.lease.generation,
    });
    await providers.deleteProviderConnection(String(connection.id));
  }
});

test("managed exclusive keys cannot use native routes even without lease headers", async () => {
  const client = await apiKeysDb.createApiKey(
    "synthetic-managed-native-key",
    "synthetic-machine",
    ["lease:exclusive"],
    { allowedConnections: ["synthetic-unconfigured-connection"] }
  );
  const count = fetchCalls;
  for (const response of [
    await decisionRoute.POST(
      decisionRequest(noulRequest("typesafe/jev-1.14.0"), String(client.key))
    ),
    await modelsRoute.GET(modelsRequest(String(client.key))),
  ]) {
    assert.equal(response.status, 409);
    assert.ok((await response.text()).includes("LEASE_UNSUPPORTED_ROUTE"));
  }
  assert.equal(fetchCalls, count);
});

test("exclusive lease acquired in inbound native capacity queue causes no provider call or rotation", async () => {
  const providers = await import("../../src/lib/db/providers.ts");
  const { acquire, getStats } = await import("../../open-sse/services/accountSemaphore.ts");
  const { acquireExclusiveConnectionLease, releaseExclusiveConnectionLease } =
    await import("../../src/lib/db/exclusiveConnectionLeases.ts");
  const client = await apiKeysDb.createApiKey(
    "synthetic-native-queued-client",
    "synthetic-machine"
  );
  const holder = await apiKeysDb.createApiKey(
    "synthetic-native-queued-holder",
    "synthetic-machine"
  );
  const connection = await providers.createProviderConnection({
    provider: "typesafe",
    authType: "apikey",
    name: "synthetic-queued-native",
    apiKey: "synthetic-queued-native-key",
    isActive: true,
    maxConcurrent: 1,
  });
  const connectionId = String(connection.id),
    owner = `vlo_${"c".repeat(43)}`;
  const semaphore = `typesafe:${connectionId}`;
  const releaseCapacity = await acquire(semaphore, { maxConcurrency: 1 });
  const count = fetchCalls;
  const pending = decisionRoute.POST(
    decisionRequest(noulRequest("typesafe/jev-1.14.0"), String(client.key))
  );
  let generation: number | undefined;
  try {
    for (let n = 0; n < 200 && !getStats()[semaphore]?.queued; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      getStats()[semaphore]?.queued,
      1,
      "actual inbound native dispatch reaches capacity queue"
    );
    const claim = acquireExclusiveConnectionLease({
      leaseOwnerId: owner,
      apiKeyId: String(holder.id),
      provider: "typesafe",
      connectionId,
    });
    assert.ok("lease" in claim && claim.kind === "ACQUIRED");
    generation = claim.lease.generation;
    releaseCapacity();
    const response = await pending;
    assert.equal(response.status, 409, await response.clone().text());
    assert.ok((await response.text()).includes("LEASE_CAPACITY_UNAVAILABLE"));
    assert.equal(fetchCalls, count);
  } finally {
    releaseCapacity();
    if (generation !== undefined)
      releaseExclusiveConnectionLease({
        leaseOwnerId: owner,
        apiKeyId: String(holder.id),
        generation,
      });
    await providers.deleteProviderConnection(connectionId);
  }
});
