import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createApiKey } from "../../../src/lib/db/apiKeys.ts";
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import { getKeyQuotaStatus } from "../../../src/lib/db/keyQuota.ts";
import {
  reserveDecisionAttempt,
  startDecisionAttempt,
  settleDecisionAttempt,
  readDecisionAttempts,
  decisionAdmissionBlocked,
  cancelUnstartedDecision,
  type AttemptIdentity,
} from "../../../src/lib/db/decisionAttempts.ts";
async function identity(): Promise<AttemptIdentity> {
  const key = await createApiKey("synthetic-journal-key", "synthetic");
  return {
    id: randomUUID(),
    keyId: key.id,
    comboId: "synthetic-combo",
    candidateId: "fixture",
    provider: "openai",
    model: "gpt-5.4",
    connectionId: "synthetic-connection",
    effort: "medium",
  };
}
function count(table: string, keyId: string): number {
  const allowed = ["request_cost_ledger", "domain_cost_history", "usage_history"];
  assert.ok(allowed.includes(table));
  return Number(
    (
      getDbInstance()
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE api_key_id=?`)
        .get(keyId) as { n: number }
    ).n
  );
}
after(() => resetDbInstance());
test("bounded reservation and one physical start; duplicate settlement projects usage and cost once", async () => {
  const a = await identity();
  reserveDecisionAttempt(a);
  assert.equal(decisionAdmissionBlocked(a.keyId), false);
  startDecisionAttempt(a);
  assert.throws(() => startDecisionAttempt(a));
  const result = { status: 200, input: 8, output: 4, cost: 0.02 };
  settleDecisionAttempt(a, result);
  settleDecisionAttempt(a, result);
  for (const table of ["request_cost_ledger", "domain_cost_history", "usage_history"])
    assert.equal(count(table, a.keyId), 1);
  assert.equal(getKeyQuotaStatus(a.keyId).counters.rpmUsed, 1);
  assert.equal(getKeyQuotaStatus(a.keyId).counters.tpmUsed, 12);
  assert.equal(readDecisionAttempts(a.keyId)[0].state, "completed");
  assert.throws(() => settleDecisionAttempt(a, { ...result, cost: 0.03 }), /conflict/);
});
test("cancel before dispatch is known zero and creates no successful usage", async () => {
  const a = await identity();
  reserveDecisionAttempt(a);
  cancelUnstartedDecision(a.id, a.leaseOwner);
  assert.equal(readDecisionAttempts(a.keyId)[0].state, "cancelled");
  assert.equal(readDecisionAttempts(a.keyId)[0].cost_usd, 0);
  assert.equal(count("usage_history", a.keyId), 0);
  assert.equal(getKeyQuotaStatus(a.keyId).counters.rpmUsed, 0);
});
test("failure before journal/start commit rejects before granting a dispatch slot", async () => {
  const a = await identity();
  const db = getDbInstance();
  db.exec(
    "CREATE TEMP TRIGGER fail_decision_reserve BEFORE INSERT ON decision_application_attempts BEGIN SELECT RAISE(ABORT,'synthetic reserve failure'); END"
  );
  assert.throws(() => reserveDecisionAttempt(a));
  db.exec("DROP TRIGGER fail_decision_reserve");
  assert.equal(readDecisionAttempts(a.keyId).length, 0);
  reserveDecisionAttempt(a);
  db.exec(
    "CREATE TEMP TRIGGER fail_decision_start BEFORE UPDATE OF state ON decision_application_attempts WHEN NEW.state='started' BEGIN SELECT RAISE(ABORT,'synthetic start failure'); END"
  );
  assert.throws(() => startDecisionAttempt(a));
  db.exec("DROP TRIGGER fail_decision_start");
  assert.equal(readDecisionAttempts(a.keyId)[0].state, "reserved");
  assert.equal(getKeyQuotaStatus(a.keyId).counters.rpmUsed, 0);
});
test("settlement projection failure rolls back every write, remains pending across a new process, then retries once", async () => {
  const a = await identity();
  reserveDecisionAttempt(a);
  startDecisionAttempt(a);
  getDbInstance().exec(
    "CREATE TEMP TRIGGER fail_decision_usage BEFORE INSERT ON usage_history BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END"
  );
  assert.throws(() => settleDecisionAttempt(a, { status: 200, input: 8, output: 4, cost: 0.02 }));
  for (const table of ["request_cost_ledger", "domain_cost_history", "usage_history"])
    assert.equal(count(table, a.keyId), 0);
  assert.equal(readDecisionAttempts(a.keyId)[0].state, "started");
  resetDbInstance();
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "tests/fixtures/decisionPolicy/readAttempt.ts", a.keyId],
    { encoding: "utf8", timeout: 20000 }
  );
  const line = output.split("\n").find((row) => row.startsWith("DECISION_RECOVERY_EVIDENCE "))!;
  assert.deepEqual(JSON.parse(line.slice("DECISION_RECOVERY_EVIDENCE ".length)), {
    states: ["started"],
    blocked: false,
  });
  settleDecisionAttempt(a, { status: 200, input: 8, output: 4, cost: 0.02 });
  for (const table of ["request_cost_ledger", "domain_cost_history", "usage_history"])
    assert.equal(count(table, a.keyId), 1);
});
test("unknown outcome and late cost/token disclosure remain explicit and reconcile without duplicate projections", async () => {
  const a = await identity();
  reserveDecisionAttempt(a);
  startDecisionAttempt(a);
  settleDecisionAttempt(a, { status: null, input: null, output: null, cost: null });
  let row = readDecisionAttempts(a.keyId)[0];
  assert.equal(row.state, "unknown");
  assert.equal(row.cost_usd, null);
  settleDecisionAttempt(a, { status: 200, input: 8, output: 4, cost: null });
  row = readDecisionAttempts(a.keyId)[0];
  assert.equal(row.state, "completed");
  assert.equal(row.cost_usd, null);
  assert.equal(count("request_cost_ledger", a.keyId), 0);
  settleDecisionAttempt(a, { status: 200, input: 8, output: 4, cost: 0.01 });
  settleDecisionAttempt(a, { status: 200, input: 8, output: 4, cost: 0.01 });
  for (const table of ["request_cost_ledger", "domain_cost_history", "usage_history"])
    assert.equal(count(table, a.keyId), 1);
  assert.equal(getKeyQuotaStatus(a.keyId).counters.tpmUsed, 12);
  assert.equal(getKeyQuotaStatus(a.keyId).counters.rpmUsed, 1);
  assert.throws(() => settleDecisionAttempt(a, { status: 200, input: -1, output: 4, cost: 0.01 }));
});
