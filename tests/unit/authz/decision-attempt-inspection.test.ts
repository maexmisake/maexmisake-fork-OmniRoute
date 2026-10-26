import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
const { GET } = await import("../../../src/app/api/decision-routing/attempts/route.ts");
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { createAccessToken } = await import("../../../src/lib/db/accessTokens.ts");
const { isAlwaysProtectedPath } = await import("../../../src/server/authz/routeGuard.ts");
const { runAuthzPipeline } = await import("../../../src/server/authz/pipeline.ts");
const ORIGIN = "https://dashboard.example.invalid";
const PATH = "/api/decision-routing/attempts";
const CANARY = "SYNTHETIC_PRIVATE_INSPECTION_VALUE";
let reads = 0;
let originalPrepare: ReturnType<typeof getDbInstance>["prepare"];
let blockedFetches = 0;
const originalFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = async () => {
    blockedFetches++;
    throw new Error("No outbound operations permitted");
  };
  await updateSettings({ requireLogin: false });
  const db = getDbInstance();
  originalPrepare = db.prepare;
  db.prepare = ((sql: string) => {
    if (/SELECT[\s\S]+FROM decision_application_attempts/i.test(sql)) reads++;
    return originalPrepare.call(db, sql);
  }) as typeof db.prepare;
});
after(() => {
  assert.equal(blockedFetches, 0);
  getDbInstance().prepare = originalPrepare;
  globalThis.fetch = originalFetch;
  resetDbInstance();
});

function seed(combo: string, patch: Record<string, unknown> = {}) {
  const row = {
    id: randomUUID(),
    api_key_id: CANARY,
    combo_id: combo,
    candidate_id: "deep",
    provider: "claude",
    model: "claude-opus-5-5",
    connection_id: CANARY,
    effort: "high",
    state: "completed",
    lane: "execution",
    request_id: randomUUID(),
    parent_attempt_id: null,
    http_status: 200,
    application_status: 200,
    decision_outcome: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    selection_trace: JSON.stringify([
      { phase: "selection", id: "deep", reason: "deterministic_no_decision", privateValue: CANARY },
    ]),
    selected_binding: null,
    lease_owner: CANARY,
    lease_expires_at: Date.now() - 10,
    created_at: "2026-10-26T20:00:00.000Z",
    updated_at: "2026-10-26T20:00:01.000Z",
    ...patch,
  };
  const keys = Object.keys(row);
  getDbInstance()
    .prepare(
      `INSERT INTO decision_application_attempts (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`
    )
    .run(...Object.values(row));
  return row;
}
const request = (query = "") => makeManagementSessionRequest(ORIGIN + PATH + query);

test("inspection is protected even when dashboard login is disabled", async () => {
  assert.equal(isAlwaysProtectedPath(PATH), true);
  assert.equal(isAlwaysProtectedPath(PATH + "/"), true);
  assert.equal(isAlwaysProtectedPath(PATH + "-extra"), false);
  const beforeReads = reads;
  const response = await GET(new Request(ORIGIN + PATH));
  assert.equal(response.status, 401);
  assert.equal(reads, beforeReads);
  const middleware = await runAuthzPipeline(new NextRequest(ORIGIN + PATH), { enforce: true });
  assert.equal(middleware.status, 401);
});
test("forged trusted CLI identity headers are stripped by the real auth pipeline before inspection", async () => {
  const key = await createApiKey("synthetic-forged-inspection", "synthetic");
  for (const supplied of [null, key.key]) {
    const beforeReads = reads;
    const headers = new Headers({
      "x-omniroute-auth-kind": "management_key",
      "x-omniroute-auth-label": "local-cli-token",
      "x-omniroute-auth-scopes": "admin,manage",
    });
    if (supplied) headers.set("authorization", `Bearer ${supplied}`);
    const response = await runAuthzPipeline(new NextRequest(ORIGIN + PATH, { headers }), {
      enforce: true,
    });
    assert.equal(response.status, supplied ? 403 : 401);
    assert.equal(reads, beforeReads);
  }
});
test("all machine-key scopes and delegated admin tokens are refused before cross-key journal reads", async () => {
  seed("foreign-combo");
  for (const scopes of [[], ["manage"], ["admin"]]) {
    const key = await createApiKey("synthetic-inspection-machine", "synthetic", scopes);
    const beforeReads = reads;
    const response = await GET(
      new Request(ORIGIN + PATH + "?combo=foreign-combo", {
        headers: { authorization: `Bearer ${key.key}` },
      })
    );
    assert.ok([401, 403].includes(response.status));
    assert.equal(reads, beforeReads);
    assert.ok(!(await response.text()).includes(CANARY));
  }
  const token = createAccessToken({ name: "synthetic-inspection-admin", scope: "admin" });
  const beforeReads = reads;
  assert.equal(
    (
      await GET(
        new Request(ORIGIN + PATH, { headers: { authorization: `Bearer ${token.secret}` } })
      )
    ).status,
    403
  );
  assert.equal(reads, beforeReads);
});
test("malformed or cross-key filters reject before SQL and never echo request data", async () => {
  for (const query of [
    "?limit=101",
    "?cursor=-1",
    "?combo=x&combo=y",
    "?apiKeyId=foreign-key",
    "?since=invalid",
  ]) {
    const beforeReads = reads;
    const response = await GET(await request(query));
    assert.equal(response.status, 400, query);
    assert.equal(reads, beforeReads);
  }
});
test("signed-in operator gets actual unknown/zero/refused receipts without private fields or writes", async () => {
  const combo = randomUUID();
  seed(combo, {
    lane: "decision",
    decision_outcome: "refused",
    state: "completed",
    http_status: 200,
    application_status: 409,
  });
  seed(combo, { input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  const unknown = seed(combo, {
    state: "started",
    application_status: null,
    selected_binding: JSON.stringify(["deep", "claude", "claude-opus-5-5", "high", CANARY]),
  });
  const snapshot = () =>
    originalPrepare
      .call(
        getDbInstance(),
        "SELECT * FROM decision_application_attempts WHERE combo_id=? ORDER BY rowid"
      )
      .all(combo);
  const beforeRows = JSON.stringify(snapshot());
  const response = await GET(await request(`?combo=${combo}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const data = await response.json();
  assert.equal(data.rows.length, 3);
  assert.equal(data.rows[0].id, unknown.id);
  assert.equal(data.rows[0].state, "started");
  assert.equal(data.rows[0].lease, "expired");
  assert.equal(data.rows[0].costUsd, null);
  assert.equal(data.rows[1].costUsd, 0);
  assert.equal(data.rows[1].outputTokens, 0);
  assert.equal(data.rows[2].decisionOutcome, "refused");
  assert.ok(!JSON.stringify(data).includes(CANARY));
  for (const field of ["lease_owner", "api_key_id", "connection_id", "selected_binding"])
    assert.ok(!JSON.stringify(data).includes(field));
  assert.equal(JSON.stringify(snapshot()), beforeRows);
});
test("bounded keyset pages and UTC date filters do not mix combos or repeat rows", async () => {
  const combo = randomUUID();
  for (let i = 0; i < 105; i++) seed(combo);
  const first = await (await GET(await request(`?combo=${combo}&limit=100`))).json();
  assert.equal(first.rows.length, 100);
  assert.ok(first.nextCursor);
  const second = await (
    await GET(await request(`?combo=${combo}&limit=100&cursor=${first.nextCursor}`))
  ).json();
  assert.equal(second.rows.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 105);
  assert.equal(
    (await (await GET(await request(`?combo=${combo}&since=2026-10-27T00:00:00Z`))).json()).rows
      .length,
    0
  );
  const ranged = await (
    await GET(
      await request(
        `?combo=${combo}&since=2026-10-26T21:00:00%2B01:00&until=2026-10-26T20:00:00Z&limit=2`
      )
    )
  ).json();
  assert.equal(ranged.rows.length, 2);
});
test("explicit reload observes a late receipt without replay or lease mutation", async () => {
  const combo = randomUUID();
  const source = seed(combo, { state: "unknown", http_status: null, application_status: null });
  const before = await (await GET(await request(`?combo=${combo}`))).json();
  assert.equal(before.rows[0].costUsd, null);
  getDbInstance()
    .prepare(
      "UPDATE decision_application_attempts SET state='completed',http_status=200,application_status=200,input_tokens=4,output_tokens=2,cost_usd=0,updated_at=? WHERE id=?"
    )
    .run("2026-10-26T22:00:00.000Z", source.id);
  const after = await (await GET(await request(`?combo=${combo}`))).json();
  assert.equal(after.rows[0].id, source.id);
  assert.equal(after.rows[0].state, "completed");
  assert.equal(after.rows[0].costUsd, 0);
  assert.equal(after.rows[0].updatedAt, "2026-10-26T22:00:00.000Z");
});
test("journal read failures return a sanitized unavailable response without exposing stored or exception data", async () => {
  const db = getDbInstance();
  const prepare = db.prepare;
  db.prepare = ((sql: string) => {
    if (/FROM decision_application_attempts/i.test(sql)) throw new Error(CANARY);
    return prepare.call(db, sql);
  }) as typeof db.prepare;
  try {
    const response = await GET(await request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(!(await response.text()).includes(CANARY));
  } finally {
    db.prepare = prepare;
  }
});
test("aborted reads do not query or mutate the journal", async () => {
  const base = await request();
  const controller = new AbortController();
  controller.abort();
  const before = reads;
  const response = await GET(new Request(base, { signal: controller.signal }));
  assert.equal(response.status, 499);
  assert.equal(reads, before);
});
