import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-recorded-cost-surfaces-"));
process.env.DATA_DIR = testDataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network disabled in accounting regression");
};

const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { updatePricing } = await import("../../src/lib/db/settings.ts");
const { updateDatabaseSettings, getUserDatabaseSettings } =
  await import("../../src/lib/db/databaseSettings.ts");
const { saveRequestUsage } = await import("../../src/lib/usage/usageHistory.ts");
const { getUsageStats, getConnectionSpendUsdSinceAdded } =
  await import("../../src/lib/usage/usageStats.ts");
const { rollupUsageHistoryBeforeDate } = await import("../../src/lib/usage/aggregateHistory.ts");
const { getProviderWindowCostBreakdown } =
  await import("../../src/lib/usage/providerWindowCosts.ts");
const analyticsRoute = await import("../../src/app/api/usage/analytics/route.ts");

const pricedModel = "recorded-cost-priced-model";
const unpricedModel = "recorded-cost-unpriced-model";

async function seed(timestamp = new Date(Date.now() - 1_000).toISOString()) {
  await updatePricing({ vercel: { [pricedModel]: { input: 0.2, output: 1 } } });
  for (const [index, entry] of [
    { model: unpricedModel, costUsd: 0.125 },
    { model: pricedModel, costUsd: 0.05 },
    { model: pricedModel, costUsd: 0 },
    { model: pricedModel },
  ].entries()) {
    await saveRequestUsage({
      ...entry,
      provider: "vercel",
      connectionId: "recorded-cost-account",
      apiKeyId: "recorded-cost-key",
      apiKeyName: "Recorded cost key",
      tokens: { input: 1_000_000, output: 0 },
      success: true,
      timestamp: new Date(Date.parse(timestamp) + index).toISOString(),
    });
  }
}

async function analytics(query = "range=all&presets=1d") {
  const response = await analyticsRoute.GET(
    new Request(`http://localhost/api/usage/analytics?${query}`)
  );
  assert.equal(response.status, 200);
  return response.json();
}

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

test.beforeEach(() => {
  const db = getDbInstance();
  db.exec("DELETE FROM usage_history; DELETE FROM daily_usage_summary");
  updateDatabaseSettings({
    aggregation: { ...getUserDatabaseSettings().aggregation, enabled: false },
  });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const aggregation of [false, true]) {
  test(`stats preserve recorded costs and price only NULL costs (aggregation=${aggregation})`, async () => {
    await seed();
    updateDatabaseSettings({
      aggregation: { ...getUserDatabaseSettings().aggregation, enabled: aggregation },
    });
    const stats = await getUsageStats();
    close(stats.totalCost, 0.375);
    assert.equal(stats.totalRequests, 4);
    assert.equal(stats.totalPromptTokens, 4_000_000);
    close(stats.byProvider.vercel.cost, 0.375);
    close(
      Object.values(stats.byModel).reduce((sum, row) => sum + row.cost, 0),
      0.375
    );
    close(
      Object.values(stats.byAccount).reduce((sum, row) => sum + row.cost, 0),
      0.375
    );
    close(stats.byApiKey["id:recorded-cost-key"].cost, 0.375);
    close(
      stats.last10Minutes.reduce((sum, row) => sum + row.cost, 0),
      0.375
    );
  });
}

test("connection spend uses exact costs, including zero, and estimates only NULL", async () => {
  await seed();
  const result = await getConnectionSpendUsdSinceAdded("vercel", "recorded-cost-account");
  close(result.costUsd, 0.375);
  assert.equal(result.requests, 4);
});

for (const domainEntries of [0, 4, 5]) {
  test(`provider window preserves raw recorded costs with ${domainEntries} legacy cost entries`, async () => {
    getDbInstance().exec("DELETE FROM domain_cost_history");
    const timestamp = new Date(Date.now() - 600_000).toISOString();
    await seed(timestamp);
    if (domainEntries) {
      const insert = getDbInstance().prepare(
        "INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)"
      );
      for (let index = 0; index < domainEntries; index++) {
        insert.run("recorded-cost-key", 0.9, Date.parse(timestamp) + index);
      }
    }
    const result = await getProviderWindowCostBreakdown({ provider: "vercel" });
    // NULL row retains legacy matching; exact row costs always win over either source.
    close(result.totalCostUsd, domainEntries ? 1.075 : 0.375);
    assert.equal(result.rows[0].requests, 4);
    const models = result.rows[0].models;
    close(models.find((row) => row.model === unpricedModel)!.costUsd, 0.125);
    close(models.find((row) => row.model === pricedModel)!.costUsd, domainEntries ? 0.95 : 0.25);
  });
}

for (const costUsd of [0.125, 0]) {
  test(`provider window returns exact raw cost ${costUsd} rather than token price`, async () => {
    await updatePricing({ vercel: { [pricedModel]: { input: 0.2, output: 1 } } });
    await saveRequestUsage({
      provider: "vercel",
      model: pricedModel,
      costUsd,
      tokens: { input: 1_000_000, output: 0 },
      success: true,
    });
    close((await getProviderWindowCostBreakdown({ provider: "vercel" })).totalCostUsd, costUsd);
  });
}

test("mixed row and legacy costs stay exact across API key renames", async () => {
  getDbInstance().exec("DELETE FROM domain_cost_history");
  const timestamp = new Date(Date.now() - 600_000).toISOString();
  await seed(timestamp);
  getDbInstance()
    .prepare("UPDATE usage_history SET api_key_name = 'Renamed' WHERE cost_usd IS NULL")
    .run();
  await saveRequestUsage({
    provider: "vercel",
    model: pricedModel,
    apiKeyId: "recorded-cost-key",
    apiKeyName: "Original",
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: new Date(Date.parse(timestamp) + 120_000).toISOString(),
  });
  for (let index = 0; index < 4; index++) {
    getDbInstance()
      .prepare("INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)")
      .run("recorded-cost-key", 0.9, Date.parse(timestamp) + index);
  }
  const result = await getProviderWindowCostBreakdown({ provider: "vercel" });
  close(result.totalCostUsd, 1.275);
});

test("fully recorded provider windows stay aggregated even with legacy cost history", async () => {
  await seed();
  const db = getDbInstance();
  db.prepare("UPDATE usage_history SET cost_usd = 0.2 WHERE cost_usd IS NULL").run();
  db.prepare("INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES (?, ?, ?)").run(
    "recorded-cost-key",
    9,
    Date.now() - 1_000
  );
  const originalPrepare = db.prepare;
  const detailedQueries: string[] = [];
  db.prepare = (sql) => {
    if (/id as rowId|ORDER BY timestamp ASC, id ASC/i.test(sql)) detailedQueries.push(sql);
    return originalPrepare.call(db, sql);
  };
  try {
    close((await getProviderWindowCostBreakdown({ provider: "vercel" })).totalCostUsd, 0.375);
    assert.equal(detailedQueries.length, 0);
  } finally {
    db.prepare = originalPrepare;
  }
});

test("analytics totals, breakdowns and presets preserve mixed recorded and NULL costs", async () => {
  await seed();
  const body = await analytics();
  close(body.summary.totalCost, 0.375);
  assert.equal(body.summary.totalRequests, 4);
  assert.equal(body.summary.promptTokens, 4_000_000);
  for (const rows of [
    body.dailyTrend,
    body.byModel,
    body.byProvider,
    body.byAccount,
    body.byApiKey,
    body.byServiceTier,
  ]) {
    close(
      rows.reduce((sum, row) => sum + row.cost, 0),
      0.375
    );
  }
  close(body.presetSummaries["1d"].totalCost, 0.375);
  await saveRequestUsage({
    provider: "vercel",
    model: unpricedModel,
    apiKeyId: "other-key",
    costUsd: 9,
    tokens: { input: 10, output: 1 },
    success: true,
    timestamp: new Date().toISOString(),
  });
  const filtered = await analytics("range=all&apiKeyIds=recorded-cost-key");
  close(filtered.summary.totalCost, 0.375);
});

test("rollup preserves exact costs and known zero after raw history is removed", async () => {
  await seed("2024-01-01T12:00:00.000Z");
  await saveRequestUsage({
    provider: "vercel",
    model: "recorded-zero-priced-model",
    costUsd: 0,
    tokens: { input: 1_000_000, output: 0 },
    success: true,
    timestamp: "2024-01-01T12:01:00.000Z",
  });
  await updatePricing({ vercel: { "recorded-zero-priced-model": { input: 10, output: 10 } } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await rollupUsageHistoryBeforeDate("2024-02-01");
    assert.equal(result.errors, 0);
    const rows = getDbInstance()
      .prepare("SELECT total_cost FROM daily_usage_summary")
      .all() as Array<{ total_cost: number }>;
    close(
      rows.reduce((sum, row) => sum + row.total_cost, 0),
      0.375
    );
  }
  getDbInstance().exec("DELETE FROM usage_history");
  updateDatabaseSettings({
    aggregation: { ...getUserDatabaseSettings().aggregation, enabled: true },
  });
  close((await getUsageStats()).totalCost, 0.375);
  const body = await analytics("range=all&presets=all");
  close(body.summary.totalCost, 0.375);
  close(body.presetSummaries.all.totalCost, 0.375);
  const zero = body.byModel.find((row) => row.model === "recorded-zero-priced-model");
  assert.ok(zero);
  assert.equal(zero.cost, 0);
});
