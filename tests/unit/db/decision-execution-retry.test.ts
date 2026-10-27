import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../../src/lib/db/apiKeys.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
import * as journal from "../../../src/lib/db/decisionAttempts.ts";
import type { AttemptIdentity } from "../../../src/lib/db/decisionAttempts.ts";

after(() => resetDbInstance());
async function parent(status: number | null = 429) {
  const key = await createApiKey("synthetic-retry-db", "synthetic");
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId: key.id,
    comboId: "synthetic-combo",
    candidateId: "primary",
    provider: "openai",
    model: "gpt-5.4",
    connectionId: "synthetic-a",
    effort: "medium",
  };
  journal.reserveDecisionAttempt(identity);
  journal.startDecisionAttempt(identity);
  journal.settleDecisionAttempt(identity, { status, input: null, output: null, cost: null });
  journal.finishDecisionApplication(identity.id, status ?? 409);
  return identity;
}
function child(previous: AttemptIdentity, id = "backup"): AttemptIdentity {
  return {
    ...previous,
    leaseOwner: undefined,
    id: randomUUID(),
    candidateId: id,
    connectionId: `synthetic-${id}`,
    model: "gpt-5.4-mini",
    lane: "execution",
    parentAttemptId: previous.id,
    requestId: previous.requestId ?? previous.id,
  };
}
test("execution retry atomically authorizes one child and counts one logical request", async () => {
  assert.equal(
    typeof journal.handoverExecutionRetry,
    "function",
    "durable execution handover is missing"
  );
  const a = await parent(),
    b = child(a);
  journal.handoverExecutionRetry(a, b, 3, { scope: "account-quota", status: 429, retryAt: 0 });
  journal.startDecisionAttempt(b);
  assert.throws(() =>
    journal.handoverExecutionRetry(a, child(a, "duplicate"), 3, {
      scope: "account-quota",
      status: 429,
      retryAt: 0,
    })
  );
  const rows = journal.readDecisionAttempts(a.keyId);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.reduce((n, row) => n + Number(row.logical_counted), 0),
    1
  );
  assert.equal(journal.readLogicalDecisionCost(a.id).unknownStages, 2);
});
test("unknown completion cannot authorize a retry even with an owner capability", async () => {
  assert.equal(typeof journal.handoverExecutionRetry, "function");
  const a = await parent(null);
  assert.throws(() =>
    journal.handoverExecutionRetry(a, child(a), 2, {
      scope: "account-quota",
      status: 429,
      retryAt: 0,
    })
  );
  assert.equal(journal.readDecisionAttempts(a.keyId).length, 1);
});
test("unknown owner and same account cannot rotate through account-quota permission", async () => {
  assert.equal(typeof journal.handoverExecutionRetry, "function");
  const a = await parent(),
    b = child(a);
  assert.throws(() =>
    journal.handoverExecutionRetry({ ...a, leaseOwner: "forged" }, b, 2, {
      scope: "account-quota",
      status: 429,
      retryAt: 0,
    })
  );
  assert.throws(() =>
    journal.handoverExecutionRetry(a, { ...b, connectionId: a.connectionId }, 2, {
      scope: "account-quota",
      status: 429,
      retryAt: 0,
    })
  );
  assert.equal(journal.readDecisionAttempts(a.keyId).length, 1);
});
test("the total execution ceiling spans descendants and preserves every unknown bill", async () => {
  const a = await parent(),
    b = child(a);
  const failure = { scope: "account-quota" as const, status: 429, retryAt: 0 };
  journal.handoverExecutionRetry(a, b, 2, failure);
  journal.startDecisionAttempt(b);
  journal.settleDecisionAttempt(b, { status: 429, input: null, output: null, cost: null });
  journal.finishDecisionApplication(b.id, 429);
  assert.throws(
    () => journal.handoverExecutionRetry(b, child(b, "third"), 2, failure),
    /exhausted/
  );
  const rows = journal.readDecisionAttempts(a.keyId);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.reduce((n, row) => n + Number(row.logical_counted), 0),
    1
  );
  assert.equal(journal.readLogicalDecisionCost(a.id).unknownStages, 2);
});
test("a retry cannot change the logical request, key or combo", async () => {
  const a = await parent();
  for (const patch of [
    { requestId: "foreign-root" },
    { keyId: "foreign-key" },
    { comboId: "foreign-combo" },
  ]) {
    assert.throws(() =>
      journal.handoverExecutionRetry(a, { ...child(a), ...patch }, 2, {
        scope: "account-quota",
        status: 429,
        retryAt: 0,
      })
    );
  }
  assert.equal(journal.readDecisionAttempts(a.keyId).length, 1);
});
