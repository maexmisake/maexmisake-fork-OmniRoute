import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createCombo, getComboById } from "../../../src/lib/db/combos.ts";
import { createProviderConnection } from "../../../src/lib/db/providers.ts";
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import {
  readStoredDecisionSettings,
  compareAndSetDecisionPolicy,
  compareAndSetZenTier,
  readDecisionConnectionRows,
  connectionSettingsRevision,
} from "../../../src/lib/db/decisionPolicySettings.ts";
let sequence = 0;
const seedCombo = () =>
  createCombo({
    name: `settings-db-${++sequence}`,
    models: ["openai/fixture"],
    config: { unrelated: { value: 3 }, temperature: 0.3 },
  });
const seedConnection = (provider = "opencode-zen", metadata: Record<string, unknown> = {}) =>
  createProviderConnection({
    provider,
    authType: "apikey",
    name: `settings-db-${++sequence}`,
    apiKey: `synthetic-db-key-${sequence}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: metadata,
  });
const rawConnection = (id: string) =>
  getDbInstance().prepare("SELECT * FROM provider_connections WHERE id=?").get(id) as Record<
    string,
    unknown
  >;
const revision = (id: string) =>
  connectionSettingsRevision(readDecisionConnectionRows().find((row) => row.id === id)!);
after(resetDbInstance);

test("decision policy CAS changes only its subtree and preserves unrelated fields on reload", async () => {
  const combo = await seedCombo();
  const before = readStoredDecisionSettings(String(combo.id));
  compareAndSetDecisionPolicy({
    id: before.comboId,
    expectedRevision: before.revision,
    action: "save",
    policy: { enabled: false },
    validate: () => {},
  });
  const row = await getComboById(before.comboId);
  assert.deepEqual(row!.config, {
    unrelated: { value: 3 },
    temperature: 0.3,
    decisionPolicy: { enabled: false },
  });
  resetDbInstance();
  assert.deepEqual(readStoredDecisionSettings(before.comboId).rawPolicy, { enabled: false });
  assert.notEqual(readStoredDecisionSettings(before.comboId).revision, before.revision);
});

test("two writers with the same revision have exactly one winner and no lost sibling config", async () => {
  const combo = await seedCombo(),
    before = readStoredDecisionSettings(String(combo.id));
  const results = await Promise.allSettled(
    [1, 2].map((value) =>
      Promise.resolve().then(() =>
        compareAndSetDecisionPolicy({
          id: before.comboId,
          expectedRevision: before.revision,
          action: "save",
          policy: { enabled: false, value },
          validate: () => {},
        })
      )
    )
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.deepEqual((await getComboById(before.comboId))!.config?.unrelated, { value: 3 });
});

test("failed activation validation rolls back and cancellation immediately before SQL prevents write", async () => {
  const combo = await seedCombo(),
    before = readStoredDecisionSettings(String(combo.id));
  assert.throws(() =>
    compareAndSetDecisionPolicy({
      id: before.comboId,
      expectedRevision: before.revision,
      action: "save",
      policy: { enabled: true },
      validate: () => {
        throw new Error("fixture invalid");
      },
    })
  );
  assert.equal(readStoredDecisionSettings(before.comboId).revision, before.revision);
  const abort = new AbortController();
  assert.throws(
    () =>
      compareAndSetDecisionPolicy({
        id: before.comboId,
        expectedRevision: before.revision,
        action: "save",
        policy: {},
        signal: abort.signal,
        validate: () => abort.abort(),
      }),
    /cancelled/
  );
  assert.equal(readStoredDecisionSettings(before.comboId).revision, before.revision);
});

test("disable handles an owned null policy marker rather than leaving runtime opted in", async () => {
  const combo = await createCombo({
    name: `settings-db-null-${++sequence}`,
    models: ["openai/fixture"],
    config: { decisionPolicy: null, keep: 7 },
  });
  const before = readStoredDecisionSettings(String(combo.id));
  assert.equal(before.hasPolicy, true);
  compareAndSetDecisionPolicy({
    id: before.comboId,
    expectedRevision: before.revision,
    action: "disable",
    validate: () => assert.fail("disable cannot activate"),
  });
  assert.deepEqual(readStoredDecisionSettings(before.comboId).rawPolicy, { enabled: false });
  assert.equal((await getComboById(before.comboId))!.config?.keep, 7);
});

test("tier CAS preserves ciphertext, unsupported metadata, health and cooldown and paid removes only marker", async () => {
  const connection = await seedConnection("opencode-zen", {
    customHeaders: { "X-Secret": "synthetic-private-header" },
    retained: "synthetic-private-data",
  });
  const id = String(connection.id);
  getDbInstance()
    .prepare(
      "UPDATE provider_connections SET last_error=?,test_status=?,rate_limited_until=?,backoff_level=? WHERE id=?"
    )
    .run("synthetic health", "rate_limited", "2099-01-01T00:00:00Z", 4, id);
  const before = rawConnection(id);
  compareAndSetZenTier({ id, expectedRevision: revision(id), tier: "free" });
  const free = rawConnection(id);
  assert.equal(JSON.parse(String(free.provider_specific_data)).systemOneTier, "free");
  for (const field of Object.keys(before).filter(
    (field) => !["provider_specific_data", "updated_at"].includes(field)
  ))
    assert.deepEqual(free[field], before[field], field);
  assert.deepEqual(JSON.parse(String(free.provider_specific_data)).customHeaders, {
    "X-Secret": "synthetic-private-header",
  });
  compareAndSetZenTier({ id, expectedRevision: revision(id), tier: "paid" });
  const paid = rawConnection(id);
  assert.deepEqual(
    JSON.parse(String(paid.provider_specific_data)),
    JSON.parse(String(before.provider_specific_data))
  );
  assert.equal(paid.api_key, before.api_key);
});

test("tier revision detects same-timestamp credential and health changes; stale and cancelled writes do nothing", async () => {
  const connection = await seedConnection(),
    id = String(connection.id),
    token = revision(id);
  getDbInstance()
    .prepare("UPDATE provider_connections SET api_key=? WHERE id=?")
    .run("synthetic-different-key", id);
  assert.notEqual(revision(id), token);
  assert.throws(
    () => compareAndSetZenTier({ id, expectedRevision: token, tier: "free" }),
    /stale_revision/
  );
  const next = revision(id);
  getDbInstance()
    .prepare("UPDATE provider_connections SET last_error=? WHERE id=?")
    .run("new health", id);
  assert.throws(
    () => compareAndSetZenTier({ id, expectedRevision: next, tier: "free" }),
    /stale_revision/
  );
  const abort = new AbortController();
  abort.abort();
  assert.throws(
    () =>
      compareAndSetZenTier({
        id,
        expectedRevision: revision(id),
        tier: "free",
        signal: abort.signal,
      }),
    /cancelled/
  );
  assert.equal(rawConnection(id).provider_specific_data, null);
});

test("other providers cannot acquire a Zen tier marker", async () => {
  const connection = await seedConnection("openrouter"),
    id = String(connection.id);
  assert.throws(
    () => compareAndSetZenTier({ id, expectedRevision: revision(id), tier: "free" }),
    /unsupported_connection/
  );
});

test("identical writes still advance revisions when the prior timestamp is ahead of the wall clock", async () => {
  const combo = await seedCombo(),
    id = String(combo.id);
  const data = JSON.parse(
    String(
      (getDbInstance().prepare("SELECT data FROM combos WHERE id=?").get(id) as { data: string })
        .data
    )
  );
  data.updatedAt = "2099-01-01T00:00:00.000Z";
  data.config.decisionPolicy = { enabled: false };
  getDbInstance()
    .prepare("UPDATE combos SET data=?,updated_at=? WHERE id=?")
    .run(JSON.stringify(data), data.updatedAt, id);
  const original = readStoredDecisionSettings(id).revision;
  compareAndSetDecisionPolicy({
    id,
    expectedRevision: original,
    action: "save",
    policy: { enabled: false },
    validate: () => {},
  });
  assert.notEqual(readStoredDecisionSettings(id).revision, original);
  assert.throws(
    () =>
      compareAndSetDecisionPolicy({
        id,
        expectedRevision: original,
        action: "save",
        policy: { enabled: false },
        validate: () => {},
      }),
    /stale_revision/
  );
  const connection = await seedConnection("opencode-zen", { systemOneTier: "free" }),
    connectionId = String(connection.id);
  getDbInstance()
    .prepare("UPDATE provider_connections SET updated_at=? WHERE id=?")
    .run("2099-01-01T00:00:00.000Z", connectionId);
  const token = revision(connectionId);
  compareAndSetZenTier({ id: connectionId, expectedRevision: token, tier: "free" });
  assert.ok(
    Date.parse(String(rawConnection(connectionId).updated_at)) >
      Date.parse("2099-01-01T00:00:00.000Z"),
    "tier timestamp must advance rather than move backwards"
  );
  assert.notEqual(revision(connectionId), token);
  assert.throws(
    () => compareAndSetZenTier({ id: connectionId, expectedRevision: token, tier: "free" }),
    /stale_revision/
  );
});
