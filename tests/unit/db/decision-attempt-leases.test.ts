import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../../src/lib/db/apiKeys.ts";
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import {
  decisionAdmissionBlocked,
  reserveDecisionAttempt,
  startDecisionAttempt,
  settleDecisionAttempt,
  releaseDecisionAttempt,
  readDecisionAttempts,
  assertDecisionLease,
  handoverNativeDecision,
  type AttemptIdentity,
} from "../../../src/lib/db/decisionAttempts.ts";

async function fixture(): Promise<AttemptIdentity> {
  const key = await createApiKey("synthetic-lease-key", "synthetic");
  return {
    id: randomUUID(),
    keyId: key.id,
    comboId: "fixture-combo",
    requestedModel: "fixture-combo",
    candidateId: "fixture",
    provider: "openai",
    model: "gpt-5.4",
    connectionId: "fixture-connection",
    effort: "medium",
  };
}
import { upsertKeyQuotaLimits, getKeyQuotaStatus } from "../../../src/lib/db/keyQuota.ts";
import { upsertTokenLimit } from "../../../src/lib/db/tokenLimits.ts";
after(() => resetDbInstance());
function expire(identity: AttemptIdentity) {
  getDbInstance()
    .prepare("UPDATE decision_application_attempts SET lease_expires_at=? WHERE id=?")
    .run(Date.now() - 1, identity.id);
}
type WorkerReply = { action: string; identity?: AttemptIdentity; reason?: string };
function reply(worker: ChildProcess): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture_worker_timeout")), 20_000);
    worker.once("message", (value: WorkerReply) => {
      clearTimeout(timer);
      resolve(value);
    });
    worker.once("error", reject);
  });
}
async function worker() {
  const child = fork("tests/fixtures/decisionPolicy/leaseWorker.ts", {
    execArgv: ["--import", "tsx/esm"],
    env: { ...process.env },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  assert.equal((await reply(child)).action, "ready");
  return child;
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

test("an uncapped key's pending native request does not block ordinary admission", async () => {
  const identity = await fixture();
  reserveDecisionAttempt(identity);
  assert.equal(decisionAdmissionBlocked(identity.keyId), false);
});
test("four independent native reservations are bounded without serializing the whole key", async () => {
  const identity = await fixture();
  for (let index = 0; index < 4; index++) reserveDecisionAttempt({ ...identity, id: randomUUID() });
  assert.throws(
    () => reserveDecisionAttempt({ ...identity, id: randomUUID() }),
    /decision_concurrency_exhausted/
  );
});

test("expired reserved work is known zero; a stale owner cannot start it or renew ownership", async () => {
  const identity = await fixture();
  reserveDecisionAttempt(identity);
  expire(identity);
  assert.throws(() => startDecisionAttempt(identity), /decision_lease_expired/);
  assert.throws(() => assertDecisionLease(identity), /decision_lease_expired/);
  const next = { ...identity, id: randomUUID() };
  reserveDecisionAttempt(next);
  const old = readDecisionAttempts(identity.keyId).find((row) => row.id === identity.id)!;
  assert.equal(old.state, "cancelled");
  assert.equal(old.cost_usd, 0);
  assert.equal(old.input_tokens, 0);
  assert.equal(Object.hasOwn(old, "lease_owner"), false);
  assert.throws(() => startDecisionAttempt(identity), /decision_lease_expired/);
});
test("started cancellation releases occupancy as unknown and exact-owner late receipts reconcile once", async () => {
  const identity = await fixture();
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  releaseDecisionAttempt(identity);
  let row = readDecisionAttempts(identity.keyId)[0];
  assert.equal(row.state, "unknown");
  assert.equal(row.cost_usd, null);
  assert.throws(() => startDecisionAttempt(identity));
  assert.throws(
    () =>
      settleDecisionAttempt(
        { ...identity, leaseOwner: randomUUID() },
        { status: 200, input: 7, output: 2, cost: 0.002 }
      ),
    /decision_lease_owner/
  );
  const usage = { status: 200, input: 7, output: 2, cost: 0.002 };
  settleDecisionAttempt(identity, usage);
  settleDecisionAttempt(identity, usage);
  row = readDecisionAttempts(identity.keyId)[0];
  assert.equal(row.state, "completed");
  assert.equal(row.cost_usd, 0.002);
  assert.equal(getKeyQuotaStatus(identity.keyId).counters.rpmUsed, 1);
  assert.equal(getKeyQuotaStatus(identity.keyId).counters.tpmUsed, 9);
  assert.equal(
    (
      getDbInstance()
        .prepare("SELECT COUNT(*) n FROM request_cost_ledger WHERE request_id=?")
        .get(identity.id) as { n: number }
    ).n,
    1
  );
  assert.throws(() => settleDecisionAttempt(identity, { ...usage, cost: 0.003 }), /conflict/);
});
test("unknown shared liabilities block only applicable token and financial scopes", async () => {
  const identity = await fixture();
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  releaseDecisionAttempt(identity);
  upsertTokenLimit({
    apiKeyId: identity.keyId,
    scopeType: "model",
    scopeValue: identity.model,
    tokenLimit: 100,
  });
  assert.equal(
    decisionAdmissionBlocked(identity.keyId, undefined, {
      provider: identity.provider,
      model: identity.model,
    }),
    true
  );
  assert.equal(
    decisionAdmissionBlocked(identity.keyId, undefined, {
      provider: "claude",
      model: "claude-opus-5-5",
    }),
    false
  );
  assert.equal(decisionAdmissionBlocked(identity.keyId), false);
  upsertTokenLimit({
    apiKeyId: identity.keyId,
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 100,
  });
  assert.equal(
    decisionAdmissionBlocked(identity.keyId, undefined, { provider: "openai", model: "other" }),
    true
  );
  assert.equal(
    decisionAdmissionBlocked(identity.keyId, undefined, { provider: "claude", model: "other" }),
    false
  );
  upsertKeyQuotaLimits(identity.keyId, { monthlyAmountUsd: 1 });
  assert.equal(
    decisionAdmissionBlocked(identity.keyId, undefined, { provider: "claude", model: "other" }),
    true
  );
  settleDecisionAttempt(identity, { status: 200, input: 7, output: 2, cost: 0 });
  assert.equal(
    decisionAdmissionBlocked(identity.keyId, undefined, { provider: "claude", model: "other" }),
    false
  );
});
test("independent worker processes enforce four slots, survive death and reconcile without replay", async () => {
  const identity = await fixture();
  const workers: ChildProcess[] = [];
  try {
    for (let index = 0; index < 7; index++) workers.push(await worker());
    const replies = await Promise.all(
      workers.map(async (child) => {
        const received = reply(child);
        child.send({ action: "reserve", identity: { ...identity, id: randomUUID() } });
        return received;
      })
    );
    const admitted = replies.filter((value) => value.action === "reserved");
    assert.equal(admitted.length, 4);
    assert.equal(
      replies.filter((value) => value.reason === "decision_concurrency_exhausted").length,
      3
    );
    assert.equal(decisionAdmissionBlocked(identity.keyId), false);
    for (let index = 0; index < workers.length; index++) {
      if (replies[index].action !== "reserved") continue;
      const received = reply(workers[index]);
      workers[index].send({ action: "start" });
      assert.equal((await received).action, "started");
    }
    await Promise.all(workers.map(kill));
    for (const admittedReply of admitted) expire(admittedReply.identity!);
    // Reopen the same on-disk DB, not a new test database.
    resetDbInstance();
    const replacement = { ...identity, id: randomUUID() };
    reserveDecisionAttempt(replacement);
    const old = readDecisionAttempts(identity.keyId).filter((row) => row.id !== replacement.id);
    assert.equal(old.length, 4);
    assert.ok(old.every((row) => row.state === "unknown" && row.cost_usd === null));
    assert.equal(getKeyQuotaStatus(identity.keyId).counters.rpmUsed, 4);
    const late = admitted[0].identity!;
    assert.throws(() => startDecisionAttempt(late));
    settleDecisionAttempt(late, { status: 200, input: 4, output: 1, cost: 0.001 });
    settleDecisionAttempt(late, { status: 200, input: 4, output: 1, cost: 0.001 });
    assert.equal(getKeyQuotaStatus(identity.keyId).counters.tpmUsed, 5);
    assert.equal(
      (
        getDbInstance()
          .prepare("SELECT COUNT(*) n FROM request_cost_ledger WHERE request_id=?")
          .get(late.id) as { n: number }
      ).n,
      1
    );
  } finally {
    await Promise.all(workers.map(kill));
  }
});

test("duplicate reservation cannot replace its owner's capability; unowned legacy writes fail closed", async () => {
  const identity = await fixture();
  reserveDecisionAttempt(identity);
  const owner = identity.leaseOwner;
  assert.throws(() => reserveDecisionAttempt(identity));
  assert.equal(identity.leaseOwner, owner);
  startDecisionAttempt(identity);
  getDbInstance()
    .prepare("UPDATE decision_application_attempts SET lease_owner=NULL WHERE id=?")
    .run(identity.id);
  assert.throws(
    () => settleDecisionAttempt(identity, { status: 200, input: 1, output: 1, cost: 0 }),
    /decision_lease_owner/
  );
  assert.throws(() => releaseDecisionAttempt(identity), /decision_lease_owner/);
});
test("expired or wrong-owner selector cannot hand over to an execution child", async () => {
  const base = await fixture();
  const parent: AttemptIdentity = { ...base, lane: "decision", requestId: base.id };
  reserveDecisionAttempt(parent);
  startDecisionAttempt(parent);
  const child: AttemptIdentity = {
    ...base,
    id: randomUUID(),
    lane: "execution",
    requestId: parent.id,
    parentAttemptId: parent.id,
  };
  const usage = { status: 200, input: 7, output: 2, cost: 0.001 };
  assert.throws(
    () => handoverNativeDecision({ ...parent, leaseOwner: randomUUID() }, child, usage),
    /decision_lease_owner/
  );
  expire(parent);
  assert.throws(() => handoverNativeDecision(parent, child, usage), /decision_lease_expired/);
  assert.equal(readDecisionAttempts(parent.keyId).length, 1);
  assert.equal(readDecisionAttempts(parent.keyId)[0].cost_usd, null);
  settleDecisionAttempt(parent, usage);
  assert.throws(() => handoverNativeDecision(parent, child, usage));
  assert.equal(readDecisionAttempts(parent.keyId).length, 1);
});

test("requested-combo caps reject before reserve and unknown receipts retain their original scope", async () => {
  const identity = await fixture();
  upsertTokenLimit({
    apiKeyId: identity.keyId,
    scopeType: "model",
    scopeValue: identity.requestedModel!,
    tokenLimit: 100,
  });
  assert.throws(
    () => reserveDecisionAttempt(identity),
    /decision_capped_configuration_unsupported/
  );
  assert.equal(readDecisionAttempts(identity.keyId).length, 0);
  const pending = await fixture();
  reserveDecisionAttempt(pending);
  startDecisionAttempt(pending);
  releaseDecisionAttempt(pending);
  upsertTokenLimit({
    apiKeyId: pending.keyId,
    scopeType: "model",
    scopeValue: pending.requestedModel!,
    tokenLimit: 100,
  });
  assert.equal(
    decisionAdmissionBlocked(pending.keyId, undefined, {
      requestedModel: pending.requestedModel,
      requestedCombo: true,
    }),
    true
  );
  assert.equal(
    decisionAdmissionBlocked(pending.keyId, undefined, {
      provider: "claude",
      model: "other",
      requestedModel: "claude/other",
    }),
    false
  );
  assert.equal(readDecisionAttempts(pending.keyId)[0].requested_model, pending.requestedModel);
  getDbInstance()
    .prepare("UPDATE decision_application_attempts SET requested_model=NULL WHERE id=?")
    .run(pending.id);
  assert.equal(
    decisionAdmissionBlocked(pending.keyId, undefined, {
      requestedModel: pending.requestedModel,
      requestedCombo: true,
    }),
    true
  );
  assert.equal(decisionAdmissionBlocked(pending.keyId), false);
});

test("unsupported adapter cannot reserve, start, hand over or settle a native attempt", async () => {
  const identity = await fixture();
  reserveDecisionAttempt(identity);
  const db = getDbInstance(),
    descriptor = Object.getOwnPropertyDescriptor(db, "driver")!;
  Object.defineProperty(db, "driver", { ...descriptor, value: "sql.js" });
  try {
    assert.throws(
      () => reserveDecisionAttempt({ ...identity, id: randomUUID() }),
      /decision_storage_unsupported/
    );
    assert.throws(() => startDecisionAttempt(identity), /decision_storage_unsupported/);
    assert.throws(
      () =>
        handoverNativeDecision(identity, identity, { status: 200, input: 1, output: 1, cost: 0 }),
      /decision_storage_unsupported/
    );
    assert.throws(
      () => settleDecisionAttempt(identity, { status: 200, input: 1, output: 1, cost: 0 }),
      /decision_storage_unsupported/
    );
    assert.equal(decisionAdmissionBlocked(identity.keyId), false);
  } finally {
    Object.defineProperty(db, "driver", descriptor);
  }
});
