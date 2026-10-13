import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";

// The test runner must supply fresh DATA_DIR and TMPDIR under its scratch root
// before its setup imports run. App modules are loaded only after that setup.
const TEST_DATA_DIR = process.env.DATA_DIR;
assert.ok(TEST_DATA_DIR, "DATA_DIR must be set to an isolated scratch directory");

const core = await import("../../src/lib/db/core.ts");
const costLedger = await import("../../src/lib/db/costLedger.ts");
const usageLimits = await import("../../src/lib/usage/apiKeyUsageLimits.ts");
const { updatePricing } = await import("../../src/lib/db/settings.ts");
const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const { handleSystemOneProxy } = await import("../../open-sse/handlers/systemOne.ts");

const previousIgnoreUnpriced = process.env.USAGE_LIMIT_IGNORE_UNPRICED;
let keyCounter = 0;

function nextApiKeyId(): string {
  keyCounter += 1;
  return `systemone-budget-test-${keyCounter}`;
}

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR!, { recursive: true });
}

test.beforeEach(async () => {
  process.env.USAGE_LIMIT_IGNORE_UNPRICED = "false";
  await resetStorage();
});

test.after(async () => {
  await closeCallLogSaves(500).catch(() => {});
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousIgnoreUnpriced === undefined) delete process.env.USAGE_LIMIT_IGNORE_UNPRICED;
  else process.env.USAGE_LIMIT_IGNORE_UNPRICED = previousIgnoreUnpriced;
});

async function waitForLedger(apiKeyId: string, expectedRows: number) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = costLedger.listLedgerEntries(apiKeyId);
    if (rows.length >= expectedRows) return rows;
    await nextTurn();
  }
  return costLedger.listLedgerEntries(apiKeyId);
}

async function callSystemOne(args: {
  apiKeyId: string;
  upstreamModel: string;
  usage: Record<string, unknown>;
}) {
  const { apiKeyId, upstreamModel, usage } = args;
  const upstreamBody = {
    model: upstreamModel,
    answers: { decision: { type: "noul", noul: 0.9 } },
    usage,
  };
  return handleSystemOneProxy(
    {
      provider: "openrouter",
      body: {
        model: upstreamModel,
        state: { input: "fixture" },
        questions: { decision: { type: "noul" } },
      },
      canonicalModel: `openrouter/${upstreamModel}`,
      requestedModel: upstreamModel,
      credentials: { connectionId: "systemone-test-connection", apiKey: "fixture-only" },
      apiKeyInfo: { id: apiKeyId, name: "System One budget test" },
      correlationId: `systemone-test-request-${apiKeyId}`,
    },
    {
      fetchSystemOne: async () =>
        new Response(JSON.stringify(upstreamBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    }
  );
}

async function usageStatus(apiKeyId: string, dailyLimitUsd: number) {
  return usageLimits.getApiKeyUsageLimitStatus(
    {
      id: apiKeyId,
      usageLimitEnabled: true,
      dailyUsageLimitUsd: dailyLimitUsd,
      weeklyUsageLimitUsd: dailyLimitUsd,
      allowedConnections: [],
    },
    { now: () => Date.now() }
  );
}

test("persisted provider-reported System One cost is enforced at the per-key USD cap", async () => {
  const apiKeyId = nextApiKeyId();
  const response = await callSystemOne({
    apiKeyId,
    upstreamModel: "typesafe/jev-1.13",
    usage: { input_tokens: 357, output_tokens: 62, cost: 0.000014994 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-OmniRoute-Cost-Status"), "known");
  const rows = await waitForLedger(apiKeyId, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountUsd, 0.000014994);
  assert.equal(rows[0].serviceTier, "systemone");

  const status = await usageStatus(apiKeyId, 0.00001);
  assert.equal(status.dailySpentUsd, 0.000015);
  assert.equal(status.dailyExceeded, true);
  assert.equal(status.weeklyExceeded, true);
  assert.equal(status.dailyHasUnpricedUsage, false);
});

test("a known zero System One cost stays zero instead of being re-priced", async () => {
  await updatePricing({
    openrouter: {
      "typesafe/jev-1.13": {
        input: 100,
        cached: 100,
        output: 100,
        reasoning: 100,
        cache_creation: 100,
      },
      "jev-1.13": {
        input: 100,
        cached: 100,
        output: 100,
        reasoning: 100,
        cache_creation: 100,
      },
    },
  });
  const apiKeyId = nextApiKeyId();
  const response = await callSystemOne({
    apiKeyId,
    upstreamModel: "typesafe/jev-1.13",
    usage: { input_tokens: 357, output_tokens: 62, cost: 0 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-OmniRoute-Cost-Status"), "known");
  const rows = await waitForLedger(apiKeyId, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountUsd, 0);

  const status = await usageStatus(apiKeyId, 0.00001);
  assert.equal(status.dailySpentUsd, 0);
  assert.equal(status.weeklySpentUsd, 0);
  assert.equal(status.dailyExceeded, false);
  assert.equal(status.weeklyExceeded, false);
  assert.equal(status.dailyHasUnpricedUsage, false);
});

test("missing System One cost fails closed without fabricating a zero ledger charge", async () => {
  const apiKeyId = nextApiKeyId();
  const response = await callSystemOne({
    apiKeyId,
    upstreamModel: "typesafe/unlisted-budget-model",
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-OmniRoute-Cost-Status"), "unknown");
  assert.equal(costLedger.listLedgerEntries(apiKeyId).length, 0);

  const status = await usageStatus(apiKeyId, 0.00001);
  assert.equal(status.dailySpentUsd, 0);
  assert.equal(status.dailyHasUnpricedUsage, true);
  assert.equal(status.weeklyHasUnpricedUsage, true);
  assert.equal(status.dailyExceeded, true);
  assert.equal(status.weeklyExceeded, true);
});

test("operator pricing resolves a System One upstream model id and reaches the persisted cap", async () => {
  const upstreamModel = "typesafe/operator-priced-budget-model";
  await updatePricing({
    openrouter: {
      [upstreamModel]: {
        input: 2,
        cached: 2,
        output: 4,
        reasoning: 4,
        cache_creation: 4,
      },
    },
  });
  const apiKeyId = nextApiKeyId();
  const response = await callSystemOne({
    apiKeyId,
    upstreamModel,
    usage: { input_tokens: 1000, output_tokens: 500 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-OmniRoute-Cost-Status"), "known");
  assert.equal(response.headers.get("X-OmniRoute-Response-Cost"), "0.0040000000");
  const rows = await waitForLedger(apiKeyId, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountUsd, 0.004);
  assert.equal(rows[0].serviceTier, "systemone");

  const status = await usageStatus(apiKeyId, 0.003);
  assert.equal(status.dailySpentUsd, 0.004);
  assert.equal(status.dailyExceeded, true);
});
