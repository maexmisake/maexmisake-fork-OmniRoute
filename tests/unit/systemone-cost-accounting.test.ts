import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-systemone-cost-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.USAGE_LIMIT_IGNORE_UNPRICED = "false";

const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { updatePricing } = await import("../../src/lib/db/settings.ts");
const { saveRequestUsage } = await import("../../src/lib/usage/usageHistory.ts");
const { getApiKeyUsageLimitStatus } = await import("../../src/lib/usage/apiKeyUsageLimits.ts");

const NOW = Date.parse("2026-10-14T20:00:00.000Z");
const ENTRY = {
  provider: "vercel",
  model: "systemone-unpriced-test-model",
  apiKeyId: "systemone-cost-key",
  tokens: { input: 1_000_000, output: 0 },
  success: true,
  timestamp: "2026-10-14T19:00:00.000Z",
};

function getStatus() {
  return getApiKeyUsageLimitStatus(
    {
      id: ENTRY.apiKeyId,
      usageLimitEnabled: true,
      dailyUsageLimitUsd: 1,
      weeklyUsageLimitUsd: 2,
    },
    {
      now: () => NOW,
      getProviderConnectionById: async () => null,
      getProviderConnections: async () => [],
      getProviderLimitsCache: () => null,
      getAllProviderLimitsCache: () => ({}),
    }
  );
}

test.beforeEach(() => {
  getDbInstance().exec("DELETE FROM usage_history");
});

test.after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("recorded native USD cost satisfies quotas without a model pricing row", async () => {
  await saveRequestUsage({ ...ENTRY, costUsd: 0.000123 });

  const status = await getStatus();
  assert.equal(status.dailySpentUsd, 0.000123);
  assert.equal(status.weeklySpentUsd, 0.000123);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.weeklyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
  assert.equal(status.weeklyExceeded, false);
});

test("recorded zero cost is known and does not fail closed", async () => {
  await saveRequestUsage({ ...ENTRY, costUsd: 0 });

  const status = await getStatus();
  assert.equal(status.dailySpentUsd, 0);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});

test("recorded costs enforce both daily and weekly caps", async () => {
  await saveRequestUsage({ ...ENTRY, costUsd: 2 });

  const status = await getStatus();
  assert.equal(status.dailySpentUsd, 2);
  assert.equal(status.weeklySpentUsd, 2);
  assert.equal(status.dailyExceeded, true);
  assert.equal(status.weeklyExceeded, true);
});

test("mixed recorded and historical costs price only rows without a recorded cost", async () => {
  const model = "systemone-priced-test-model";
  await updatePricing({ vercel: { [model]: { input: 0.2, output: 1 } } });
  await saveRequestUsage({ ...ENTRY, model, costUsd: 0.05 });
  await saveRequestUsage({ ...ENTRY, model, timestamp: "2026-10-14T19:01:00.000Z" });
  await saveRequestUsage({ ...ENTRY, model, costUsd: 0, timestamp: "2026-10-14T19:02:00.000Z" });

  const status = await getStatus();
  assert.equal(status.dailySpentUsd, 0.25);
  assert.equal(status.weeklySpentUsd, 0.25);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});

test("a known cost cannot hide an unknown cost in the same provider and model group", async () => {
  await saveRequestUsage({ ...ENTRY, costUsd: 0.05 });
  await saveRequestUsage({ ...ENTRY, timestamp: "2026-10-14T19:01:00.000Z" });

  const status = await getStatus();
  assert.equal(status.dailySpentUsd, 0.05);
  assert.equal(status.weeklySpentUsd, 0.05);
  assert.equal(status.dailyHasUnpricedUsage, true);
  assert.equal(status.weeklyHasUnpricedUsage, true);
  assert.equal(status.dailyExceeded, true);
  assert.equal(status.weeklyExceeded, true);
});

test("invalid or missing native costs persist as unknown and fail closed", async () => {
  const invalidCosts = [undefined, null, -1, NaN, Infinity, -Infinity, "0.05"];
  for (const [index, costUsd] of invalidCosts.entries()) {
    await saveRequestUsage({
      ...ENTRY,
      costUsd: costUsd as number | null,
      timestamp: new Date(Date.parse(ENTRY.timestamp) + index).toISOString(),
    });
  }
  const rows = getDbInstance()
    .prepare("SELECT cost_usd FROM usage_history ORDER BY id")
    .all() as Array<{ cost_usd: number | null }>;
  assert.equal(rows.length, invalidCosts.length);
  assert.ok(rows.every((row) => row.cost_usd === null));

  const status = await getStatus();
  assert.equal(status.dailyHasUnpricedUsage, true);
  assert.equal(status.dailyExceeded, true);
});

test("duplicate callbacks enrich missing cost once without replacing a known zero", async () => {
  await saveRequestUsage(ENTRY);
  await saveRequestUsage({ ...ENTRY, costUsd: 0 });
  await saveRequestUsage({ ...ENTRY, costUsd: 0.5 });
  await saveRequestUsage(ENTRY);
  await saveRequestUsage({ ...ENTRY, costUsd: NaN });

  const rows = getDbInstance().prepare("SELECT cost_usd FROM usage_history").all() as Array<{
    cost_usd: number | null;
  }>;
  assert.deepEqual(rows, [{ cost_usd: 0 }]);
  const status = await getStatus();
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailySpentUsd, 0);
});

test("recorded costs exclude failures, other keys and rows before quota windows", async () => {
  await saveRequestUsage({ ...ENTRY, costUsd: 0.1 });
  await saveRequestUsage({
    ...ENTRY,
    costUsd: 5,
    success: false,
    timestamp: "2026-10-14T19:01:00.000Z",
  });
  await saveRequestUsage({ ...ENTRY, costUsd: 5, apiKeyId: "another-key" });
  await saveRequestUsage({ ...ENTRY, costUsd: 5, timestamp: "2026-10-01T19:00:00.000Z" });

  const status = await getStatus();
  assert.equal(status.dailySpentUsd, 0.1);
  assert.equal(status.weeklySpentUsd, 0.1);
  assert.equal(status.dailyExceeded, false);
  assert.equal(status.weeklyExceeded, false);
});
