import { after, test } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY_SECRET ||= "systemone-quota-fixture-secret";
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createApiKey, resetApiKeyState } = await import("../../src/lib/db/apiKeys.ts");
const { upsertTokenLimit } = await import("../../src/lib/db/tokenLimits.ts");
const { upsertKeyQuotaLimits, getKeyQuotaStatus } = await import("../../src/lib/db/keyQuota.ts");
const { checkTokenLimits, recordTokenUsage } =
  await import("../../open-sse/services/tokenLimitCounter.ts");
const { handleSystemOneProxy } = await import("../../open-sse/handlers/systemOne.ts");
const { dispatchSystemOne } = await import("../../src/app/api/v1/systemone/dispatch.ts");
const { resolveSystemOneCandidates } = await import("../../open-sse/config/systemOneRegistry.ts");
const { getApiKeyUsageLimitStatus } = await import("../../src/lib/usage/apiKeyUsageLimits.ts");

after(() => {
  resetApiKeyState();
  resetDbInstance();
});

const body = {
  model: "typesafe/jev-1.13",
  state: "one apple",
  questions: { fruit: { type: "noul", instructions: "Is this an apple?" } },
};

test("successful decisions advance real key token and request counters", async () => {
  const key = await createApiKey("Decision quota fixture", "systemone-quota-fixture");
  upsertTokenLimit({ apiKeyId: key.id, scopeType: "global", tokenLimit: 1 });
  upsertKeyQuotaLimits(key.id, { tpmLimit: 1, rpmLimit: 1 });
  assert.equal(checkTokenLimits(key.id), null);
  const response = await handleSystemOneProxy(
    {
      provider: "openrouter",
      canonicalModel: "openrouter/typesafe/jev-1.13",
      body,
      credentials: { apiKey: "fixture-only" },
      apiKeyInfo: { id: key.id },
    },
    {
      fetchSystemOne: async () =>
        Response.json({
          answers: { fruit: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 1, cost: 0 },
        }),
      recordCost: () => {},
    }
  );
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkTokenLimits(key.id)?.tokensUsed, 11);
  const quota = getKeyQuotaStatus(key.id);
  assert.equal(quota.counters.tpmUsed, 11);
  assert.equal(quota.counters.rpmUsed, 1);
});

test("resolved provider and upstream-model limits block before credential selection", async () => {
  for (const scopeType of ["provider", "model"] as const) {
    const key = await createApiKey(
      `Decision ${scopeType} fixture`,
      `systemone-${scopeType}-fixture`
    );
    upsertTokenLimit({
      apiKeyId: key.id,
      scopeType,
      scopeValue: scopeType === "provider" ? "openrouter" : "typesafe/jev-1.13",
      tokenLimit: 1,
    });
    recordTokenUsage(key.id, "openrouter", "typesafe/jev-1.13", 1);
    await new Promise((resolve) => setImmediate(resolve));
    let selections = 0;
    const response = await dispatchSystemOne(
      {
        candidates: resolveSystemOneCandidates("openrouter/typesafe/jev-1.13"),
        body,
        requestedModel: "openrouter/typesafe/jev-1.13",
        apiKeyInfo: { id: key.id },
      },
      {
        selectCredentials: async () => {
          selections++;
          return { apiKey: "fixture-only" };
        },
        dispatch: async () => Response.json({}),
      }
    );
    assert.equal(response.status, 429, scopeType);
    assert.equal(selections, 0, "exhausted limits must not spend a provider credential");
  }
});

test("a real decision usage write preserves reported spend for the next USD quota check", async () => {
  const key = await createApiKey("Decision USD fixture", "systemone-usd-fixture");
  const response = await handleSystemOneProxy(
    {
      provider: "vercel-ai-gateway",
      canonicalModel: "vercel-ai-gateway/typesafe-ai/jev",
      body: { ...body, model: "typesafe-ai/jev" },
      credentials: { apiKey: "fixture-only" },
      apiKeyInfo: { id: key.id },
    },
    {
      fetchSystemOne: async () =>
        Response.json({
          answers: { fruit: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 1 },
          provider_metadata: { gateway: { cost: "0.00001" } },
        }),
      recordCost: () => {},
    }
  );
  assert.equal(response.status, 200);
  const status = await getApiKeyUsageLimitStatus({
    id: key.id,
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 10,
  });
  assert.equal(status.dailySpentUsd, 0.00001);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});

test("the explicitly published Zen free model records known zero instead of blocking USD quotas", async () => {
  const key = await createApiKey("Decision free USD fixture", "systemone-free-usd-fixture");
  const response = await handleSystemOneProxy(
    {
      provider: "opencode-zen",
      canonicalModel: "opencode-zen/jev-1.13-free",
      tier: "free",
      body: { ...body, model: "jev-1.13-free" },
      credentials: { apiKey: "fixture-only", providerSpecificData: { systemOneTier: "free" } },
      apiKeyInfo: { id: key.id },
    },
    {
      fetchSystemOne: async () =>
        Response.json({
          answers: { fruit: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      recordCost: () => {},
    }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-OmniRoute-Cost-Status"), "known");
  const status = await getApiKeyUsageLimitStatus({
    id: key.id,
    usageLimitEnabled: true,
    dailyUsageLimitUsd: 10,
  });
  assert.equal(status.dailySpentUsd, 0);
  assert.equal(status.dailyHasUnpricedUsage, false);
  assert.equal(status.dailyExceeded, false);
});
