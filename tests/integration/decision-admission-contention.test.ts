import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import {
  reserveDecisionAttempt,
  startDecisionAttempt,
  settleDecisionAttempt,
  readDecisionAttempts,
  decisionAdmissionBlocked,
  type AttemptIdentity,
} from "../../src/lib/db/decisionAttempts.ts";
import { upsertKeyQuotaLimits, getKeyQuotaStatus } from "../../src/lib/db/keyQuota.ts";
process.env.REQUIRE_API_KEY = "true";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
const { POST } = await import("../../src/app/api/v1/responses/input_tokens/route.ts");
const oldFetch = globalThis.fetch;
let unexpectedFetches = 0;
globalThis.fetch = async () => {
  unexpectedFetches++;
  throw new Error("Contention fixture forbids every provider fetch");
};
const workers = new Set<ChildProcess>();
afterEach(() => {
  for (const child of workers) child.kill("SIGKILL");
  workers.clear();
});
after(() => {
  globalThis.fetch = oldFetch;
  resetDbInstance();
  assert.equal(unexpectedFetches, 0);
});
async function fixture() {
  const key = await createApiKey("synthetic-contention-" + randomUUID(), "synthetic");
  const request = () =>
    new Request("http://synthetic.invalid/api/v1/responses/input_tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", input: "Synthetic local token count" }),
    });
  // Warm all existing auth/policy/tokenizer lazy initialization before a concurrent writer.
  const warmed = await POST(request());
  assert.equal(warmed.status, 200, await warmed.text());
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId: key.id,
    comboId: "fixture-contention-combo",
    requestedModel: "fixture-contention-combo",
    candidateId: "fixture",
    provider: "openai",
    model: "gpt-5.4",
    connectionId: "synthetic-connection",
    effort: "medium",
  };
  return { key, request, identity };
}
type WriterEvent = {
  event: "locked" | "released";
  lockedAt?: number;
  durationMs?: number;
  journalMode?: string;
  busyTimeoutMs?: number;
};
async function writer(keyId: string) {
  const child = fork(
    "tests/fixtures/decisionPolicy/contentionWriter.ts",
    [getDbInstance().name, keyId],
    {
      execArgv: ["--import", "tsx/esm"],
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }
  );
  workers.add(child);
  child.stderr?.resume();
  let lockedResolve!: (value: WriterEvent) => void,
    releaseResolve!: (value: WriterEvent) => void,
    lockedReject!: (error: Error) => void,
    releaseReject!: (error: Error) => void;
  const locked = new Promise<WriterEvent>((resolve, reject) => {
    lockedResolve = resolve;
    lockedReject = reject;
  });
  const released = new Promise<WriterEvent>((resolve, reject) => {
    releaseResolve = resolve;
    releaseReject = reject;
  });
  void released.catch(() => {});
  const timer = setTimeout(() => {
    const error = new Error("Synthetic writer startup/hold timeout");
    lockedReject(error);
    releaseReject(error);
    child.kill("SIGKILL");
  }, 20_000);
  child.on("message", (value: WriterEvent) => {
    if (value.event === "locked") lockedResolve(value);
    else releaseResolve(value);
  });
  const exited = new Promise<void>((resolve, reject) =>
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      workers.delete(child);
      if (code === 0) resolve();
      else {
        const error = new Error(`Synthetic writer exit ${code}/${signal}`);
        lockedReject(error);
        releaseReject(error);
        reject(error);
      }
    })
  );
  void exited.catch(() => {});
  return { locked: await locked, released, exited };
}
test("ordinary uncapped actual handler reads through an unrelated SQLite writer without acquiring a write lock", async (context) => {
  const { key, request } = await fixture();
  const db = getDbInstance();
  const busyTimeoutMs = Number(db.pragma("busy_timeout", { simple: true }));
  assert.equal(busyTimeoutMs, 2000);
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  const held = await writer(key.id);
  const began = Date.now(),
    response = await POST(request()),
    elapsedMs = Date.now() - began;
  const payload = await response.text();
  const released = await held.released;
  await held.exited;
  context.diagnostic(
    JSON.stringify({
      synthetic: true,
      status: response.status,
      elapsedMs,
      busyTimeoutMs,
      writer: { ...held.locked, ...released },
      providerFetches: unexpectedFetches,
    })
  );
  assert.ok(released.durationMs! >= 3500, "writer really outlives the production busy timeout");
  assert.equal(response.status, 200, payload);
  assert.ok(elapsedMs < 1500, "ordinary read must not wait for the writer/busy timeout");
});
test("capped unknown liability remains rejected while the separate writer holds its transaction", async (context) => {
  const { key, request, identity } = await fixture();
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  upsertKeyQuotaLimits(key.id, { monthlyAmountUsd: 1 });
  const before = JSON.stringify(readDecisionAttempts(key.id));
  const held = await writer(key.id);
  const began = Date.now(),
    response = await POST(request()),
    elapsedMs = Date.now() - began;
  await response.text();
  const released = await held.released;
  await held.exited;
  context.diagnostic(
    JSON.stringify({
      synthetic: true,
      status: response.status,
      elapsedMs,
      writerDurationMs: released.durationMs,
      providerFetches: unexpectedFetches,
    })
  );
  assert.equal(response.status, 429);
  assert.ok(elapsedMs < 1500);
  assert.equal(JSON.stringify(readDecisionAttempts(key.id)), before);
});
test("ordinary admission is a read-only liability query and native atomic admission still repairs expiry", async () => {
  const { key, identity } = await fixture();
  const reserved = { ...identity, id: randomUUID() };
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  reserveDecisionAttempt(reserved);
  const db = getDbInstance();
  db.prepare("UPDATE decision_application_attempts SET lease_expires_at=? WHERE api_key_id=?").run(
    Date.now() - 1,
    key.id
  );
  const before = JSON.stringify(readDecisionAttempts(key.id));
  db.pragma("query_only = ON");
  try {
    assert.equal(decisionAdmissionBlocked(key.id), false);
  } finally {
    db.pragma("query_only = OFF");
  }
  assert.equal(JSON.stringify(readDecisionAttempts(key.id)), before);
  const next = { ...identity, id: randomUUID() };
  reserveDecisionAttempt(next);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.find((row) => row.id === identity.id)!.state, "unknown");
  assert.equal(rows.find((row) => row.id === identity.id)!.cost_usd, null);
  assert.equal(rows.find((row) => row.id === reserved.id)!.state, "cancelled");
  assert.equal(rows.find((row) => row.id === reserved.id)!.cost_usd, 0);
  assert.throws(() => startDecisionAttempt(identity));
  const usage = { status: 200, input: 7, output: 2, cost: 0.001 };
  settleDecisionAttempt(identity, usage);
  settleDecisionAttempt(identity, usage);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) n FROM request_cost_ledger WHERE request_id=?")
        .get(identity.id) as { n: number }
    ).n,
    1
  );
  assert.equal(getKeyQuotaStatus(key.id).counters.rpmUsed, 1);
  assert.equal(getKeyQuotaStatus(key.id).counters.tpmUsed, 9);
});

test("separate writer blocks BEGIN IMMEDIATE with SQLITE_BUSY but permits the ordinary WAL liability read", async (context) => {
  const { key } = await fixture();
  const db = getDbInstance(),
    held = await writer(key.id);
  let code: string | undefined;
  const started = Date.now();
  try {
    db.immediate(() => {});
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  const writerWaitMs = Date.now() - started;
  const readStarted = Date.now(),
    blocked = decisionAdmissionBlocked(key.id),
    readMs = Date.now() - readStarted;
  const released = await held.released;
  await held.exited;
  context.diagnostic(
    JSON.stringify({
      synthetic: true,
      code,
      writerWaitMs,
      readMs,
      writerDurationMs: released.durationMs,
      readInTransaction: db.inTransaction ?? null,
    })
  );
  assert.equal(code, "SQLITE_BUSY");
  assert.ok(writerWaitMs >= 1900);
  assert.ok(writerWaitMs < 3000);
  assert.equal(blocked, false);
  assert.ok(readMs < 1000);
});
