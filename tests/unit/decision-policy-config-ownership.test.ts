import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createCombo, getComboById, updateCombo } from "../../src/lib/db/combos.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { POST } from "../../src/app/api/combos/route.ts";
import { PUT } from "../../src/app/api/combos/[id]/route.ts";
import {
  DecisionPolicyOwnershipError,
  preserveManagedDecisionPolicy,
} from "../../src/lib/combos/decisionPolicyOwnership.ts";
import {
  decisionPolicyEditorSchema,
  nativeSelectionSchema,
  NATIVE_DECISION_BINDINGS,
} from "../../src/shared/decisionPolicy/configuration.ts";

after(() => resetDbInstance());

test("dashboard schema admits disabled explicit drafts without enabling or inventing candidates", () => {
  const draft = {
    enabled: false,
    applicationMode: "bounded-v1",
    selection: { mode: "deterministic" },
    policy: {
      version: 1,
      candidates: [],
      taskOrder: {},
      unknownQuota: "reject",
      decisionFailure: "stop",
      maxDecisionAttempts: 0,
      maxExecutionAttempts: 1,
      timeoutMs: 10000,
    },
    connections: {},
  };
  const parsed = decisionPolicyEditorSchema.parse(draft);
  assert.equal(parsed.enabled, false);
  assert.deepEqual(parsed.policy.candidates, []);
  assert.equal(
    decisionPolicyEditorSchema.safeParse({ ...draft, apiKey: "fixture" }).success,
    false
  );
});

test("displayed bindings are exactly accepted provider-qualified selector contracts", () => {
  assert.equal(NATIVE_DECISION_BINDINGS.length, 5);
  for (const binding of NATIVE_DECISION_BINDINGS) {
    assert.equal(
      nativeSelectionSchema.safeParse({
        mode: "native",
        provider: binding.provider,
        model: binding.model,
        connectionId: "synthetic-connection",
        timeoutMs: 1000,
      }).success,
      true
    );
  }
  assert.equal(NATIVE_DECISION_BINDINGS.filter((row) => row.tier === "free").length, 1);
});

test("generic config omission preserves native settings while explicit changes reject", () => {
  const current = { decisionPolicy: { enabled: false }, unrelated: "old" };
  assert.deepEqual(preserveManagedDecisionPolicy(current, { unrelated: "new" }), {
    unrelated: "new",
    decisionPolicy: { enabled: false },
  });
  assert.deepEqual(preserveManagedDecisionPolicy(current, null), {
    decisionPolicy: { enabled: false },
  });
  assert.throws(
    () => preserveManagedDecisionPolicy(current, { decisionPolicy: { enabled: true } }),
    DecisionPolicyOwnershipError
  );
  assert.throws(
    () => preserveManagedDecisionPolicy({}, { decisionPolicy: { enabled: false } }),
    DecisionPolicyOwnershipError
  );
});

test("latest DB policy survives a generic write admitted before another editor's save", async () => {
  const first = { enabled: false, marker: "earlier-synthetic-draft" };
  const latest = { enabled: false, marker: "newer-synthetic-draft" };
  const combo = await createCombo({
    name: "ownership-interleave-fixture",
    models: ["openai/synthetic-model"],
    config: { decisionPolicy: first, retry: 1 },
  });
  const admitted = structuredClone(combo.config) as Record<string, unknown>;
  await updateCombo(String(combo.id), { config: { decisionPolicy: latest, retry: 1 } });
  await assert.rejects(
    updateCombo(String(combo.id), { config: admitted }, { preserveDecisionPolicy: true }),
    DecisionPolicyOwnershipError
  );
  const saved = await updateCombo(
    String(combo.id),
    { config: { retry: 2 } },
    { preserveDecisionPolicy: true }
  );
  assert.deepEqual(saved?.config, { decisionPolicy: latest, retry: 2 });
});

test("generic management handlers reject policy creation/stale edits and preserve omission", async () => {
  const create = await POST(
    new Request("http://localhost/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "generic-managed-policy-fixture",
        models: ["openai/synthetic-model"],
        config: { decisionPolicy: { enabled: false } },
      }),
    })
  );
  assert.equal(create.status, 409);
  const combo = await createCombo({
    name: "generic-managed-policy-existing-fixture",
    models: ["openai/synthetic-model"],
    config: { decisionPolicy: { enabled: false, marker: "new" } },
  });
  const put = (config: Record<string, unknown>) =>
    PUT(
      new Request(`http://localhost/api/combos/${combo.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      }),
      { params: Promise.resolve({ id: String(combo.id) }) }
    );
  assert.equal((await put({ decisionPolicy: { enabled: false, marker: "old" } })).status, 409);
  assert.equal((await put({ queueTimeoutMs: 2000 })).status, 200);
  assert.deepEqual((await getComboById(String(combo.id)))?.config, {
    decisionPolicy: { enabled: false, marker: "new" },
    queueTimeoutMs: 2000,
  });
});
