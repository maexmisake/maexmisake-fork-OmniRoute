import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createApiKey } from "../../../src/lib/db/apiKeys.ts";
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import { upsertKeyQuotaLimits, getKeyQuotaStatus } from "../../../src/lib/db/keyQuota.ts";
import {
  reserveDecisionAttempt,
  startDecisionAttempt,
  handoverNativeDecision,
  finishNativeDecision,
  settleDecisionAttempt,
  readDecisionAttempts,
  decisionAdmissionBlocked,
  type AttemptIdentity,
} from "../../../src/lib/db/decisionAttempts.ts";
const usage = { status: 200, input: 7, output: 2, cost: 0.001 };
async function identities() {
  const key = await createApiKey("synthetic-native-journal", "synthetic");
  const parent: AttemptIdentity = {
    id: randomUUID(),
    keyId: key.id,
    comboId: "fixture-combo",
    candidateId: "native-selector",
    provider: "opencode-zen",
    model: "jev-1.13",
    connectionId: "fixture-decision",
    effort: "native",
    lane: "decision",
  };
  parent.requestId = parent.id;
  const child: AttemptIdentity = {
    ...parent,
    id: randomUUID(),
    candidateId: "deep",
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    connectionId: "fixture-execution",
    lane: "execution",
    parentAttemptId: parent.id,
  };
  return { parent, child };
}
after(() => resetDbInstance());
test("atomic handover failure rolls back selection and projections; restart retains pending admission; retry is idempotent", async () => {
  const { parent, child } = await identities();
  upsertKeyQuotaLimits(parent.keyId, { rpmLimit: 1 });
  reserveDecisionAttempt(parent);
  startDecisionAttempt(parent);
  getDbInstance().exec(
    "CREATE TEMP TRIGGER fail_native_child BEFORE INSERT ON decision_application_attempts WHEN NEW.parent_attempt_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic child failure'); END"
  );
  assert.throws(() => handoverNativeDecision(parent, child, usage));
  let rows = readDecisionAttempts(parent.keyId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "started");
  assert.equal(rows[0].decision_outcome, null);
  assert.equal(rows[0].cost_usd, null);
  assert.equal(
    (
      getDbInstance()
        .prepare("SELECT COUNT(*) n FROM request_cost_ledger WHERE api_key_id=?")
        .get(parent.keyId) as { n: number }
    ).n,
    0
  );
  resetDbInstance();
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "tests/fixtures/decisionPolicy/readAttempt.ts", parent.keyId],
    { encoding: "utf8", timeout: 20000 }
  );
  const line = output.split("\n").find((row) => row.startsWith("DECISION_RECOVERY_EVIDENCE "))!;
  assert.deepEqual(JSON.parse(line.slice("DECISION_RECOVERY_EVIDENCE ".length)), {
    states: ["started"],
    blocked: true,
  });
  handoverNativeDecision(parent, child, usage);
  handoverNativeDecision(parent, child, usage);
  rows = readDecisionAttempts(parent.keyId);
  assert.equal(rows.length, 2);
  assert.equal(decisionAdmissionBlocked(parent.keyId), true);
  assert.equal(rows.find((r) => r.lane === "decision")!.decision_outcome, "selected");
  startDecisionAttempt(child);
  assert.throws(() => startDecisionAttempt(child));
  settleDecisionAttempt(child, { status: 200, input: 8, output: 4, cost: 0.002 });
  assert.equal(getKeyQuotaStatus(parent.keyId).counters.rpmUsed, 1);
  assert.equal(getKeyQuotaStatus(parent.keyId).counters.tpmUsed, 21);
  assert.equal(
    (
      getDbInstance()
        .prepare(
          "SELECT COUNT(*) n FROM usage_history WHERE api_key_id=? AND decision_attempt_id IS NOT NULL"
        )
        .get(parent.keyId) as { n: number }
    ).n,
    2
  );
});
test("a rejected selected binding cannot be replaced, duplicated, or started under another effort", async () => {
  const { parent, child } = await identities();
  reserveDecisionAttempt(parent);
  startDecisionAttempt(parent);
  handoverNativeDecision(parent, child, usage);
  assert.throws(() => startDecisionAttempt({ ...child, effort: "medium" }));
  assert.throws(() => reserveDecisionAttempt({ ...child, id: randomUUID() }));
  assert.throws(() => handoverNativeDecision(parent, { ...child, id: randomUUID() }, usage));
  assert.throws(() => finishNativeDecision(parent, usage, "invalid", 409));
  assert.equal(
    readDecisionAttempts(parent.keyId).find((r) => r.lane === "execution")!.state,
    "reserved"
  );
});
test("failed decision costs persist once with no child, late disclosure remains independent", async () => {
  const { parent } = await identities();
  reserveDecisionAttempt(parent);
  startDecisionAttempt(parent);
  finishNativeDecision(parent, { status: 401, input: null, output: null, cost: null }, "auth", 409);
  assert.equal(readDecisionAttempts(parent.keyId).length, 1);
  assert.equal(readDecisionAttempts(parent.keyId)[0].cost_usd, null);
  settleDecisionAttempt(parent, { status: 401, input: 7, output: 2, cost: 0.001 });
  settleDecisionAttempt(parent, { status: 401, input: 7, output: 2, cost: 0.001 });
  assert.equal(readDecisionAttempts(parent.keyId)[0].decision_outcome, "auth");
  assert.equal(getKeyQuotaStatus(parent.keyId).counters.rpmUsed, 1);
  assert.equal(
    (
      getDbInstance()
        .prepare("SELECT COUNT(*) n FROM request_cost_ledger WHERE api_key_id=?")
        .get(parent.keyId) as { n: number }
    ).n,
    1
  );
});
