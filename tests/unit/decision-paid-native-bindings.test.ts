import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { nativeSelectionSchema } from "../../src/lib/decisionPolicy/applicationCombo.ts";
import { handleSystemOneProxy } from "../../open-sse/handlers/systemOne.ts";
import { validateSystemOneBackendBody } from "../../open-sse/services/typesafe/systemOneAnswers.ts";
import { SYSTEMONE_USER_AGENT } from "../../open-sse/handlers/systemOneTransport.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

// Official-contract-shaped synthetic fixtures, never captured provider responses.
const bindings = [
  {
    provider: "typesafe",
    model: "jev-1.14.0",
    url: "https://api.typesafe.ai/v1/systemone",
    cost: null,
  },
  {
    provider: "openrouter",
    model: "typesafe/jev-1.14-20261014",
    url: "https://openrouter.ai/api/v1/systemone",
    cost: 0.000001,
  },
  {
    provider: "vercel-ai-gateway",
    model: "typesafe-ai/jev",
    url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    cost: 0,
  },
] as const;
const selection = { mode: "native", connectionId: "fixture-selector", timeoutMs: 1000 };
const modes = [
  {
    name: "noul",
    question: { type: "noul", instructions: "Is the synthetic lamp on?" },
    answer: { type: "noul", noul: 0.9 },
  },
  {
    name: "choice",
    question: {
      type: "choice",
      instructions: "Select an offered synthetic label.",
      criteria: { light: "Light fixture", deep: "Deep fixture" },
    },
    answer: {
      type: "choice",
      choice: "deep",
      probabilities: { light: 0.2, deep: 0.8 },
      confidence: 0.6,
    },
  },
  {
    name: "score",
    question: {
      type: "score",
      instructions: "Rate the synthetic lamp.",
      criteria: ["off", "on"],
    },
    answer: {
      type: "score",
      score: 1,
      probabilities: { "0": 0, "1": 1 },
      legend: { "0": "off", "1": "on" },
      confidence: 1,
    },
  },
];

after(() => resetDbInstance());

for (const binding of bindings) {
  test(`native selection accepts only the explicit ${binding.provider} model pair`, () => {
    assert.equal(nativeSelectionSchema.safeParse({ ...selection, ...binding }).success, false);
    assert.equal(
      nativeSelectionSchema.safeParse({
        ...selection,
        provider: binding.provider,
        model: binding.model,
      }).success,
      true
    );
    for (const other of bindings.filter((row) => row.provider !== binding.provider)) {
      assert.equal(
        nativeSelectionSchema.safeParse({
          ...selection,
          provider: binding.provider,
          model: other.model,
        }).success,
        false
      );
    }
  });

  for (const mode of modes) {
    test(`synthetic ${binding.provider} ${mode.name} preserves native request and answer`, async () => {
      const body = {
        model: binding.model,
        state: "Synthetic lamp is on.",
        questions: { fixture_question: mode.question },
      };
      assert.deepEqual(validateSystemOneBackendBody(binding.provider, body), { ok: true });
      const payload = {
        model: binding.model,
        answers: { fixture_question: mode.answer },
        usage: {
          input_tokens: 4,
          output_tokens: 0,
          ...(binding.provider === "openrouter" ? { cost: binding.cost } : {}),
        },
        ...(binding.provider === "vercel-ai-gateway"
          ? { provider_metadata: { gateway: { cost: String(binding.cost) } } }
          : {}),
      };
      const receipts: Record<string, unknown>[] = [];
      let calls = 0;
      const response = await handleSystemOneProxy(
        {
          provider: binding.provider,
          canonicalModel: `${binding.provider}/${binding.model}`,
          credentials: { apiKey: "synthetic-contract-key", connectionId: "fixture-selector" },
          body,
        },
        {
          withCapacity: async (_options, _signal, run) => run(),
          fetchSystemOne: async (url, credentials, init) => {
            calls++;
            assert.equal(url, binding.url);
            assert.equal(credentials.apiKey, "synthetic-contract-key");
            assert.equal(init.method, "POST");
            const headers = new Headers(init.headers);
            assert.equal(headers.get("authorization"), "Bearer synthetic-contract-key");
            assert.equal(headers.get("user-agent"), SYSTEMONE_USER_AGENT);
            assert.deepEqual(JSON.parse(String(init.body)), body);
            return Response.json(payload);
          },
          saveCallLog: async () => {},
          saveRequestUsage: async (entry) => {
            receipts.push(entry);
          },
          calculateCost: async () => ({ priced: false, costUsd: 0 }),
          recordCost: () => {},
        }
      );
      assert.equal(response.status, 200);
      assert.equal(calls, 1);
      assert.deepEqual(await response.json(), payload);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].provider, binding.provider);
      assert.equal(receipts[0].model, binding.model);
      const tokens = receipts[0].tokens as Record<string, unknown>;
      assert.equal(tokens.prompt_tokens, 4);
      assert.equal(tokens.completion_tokens, 0);
      assert.equal(tokens.cost_usd, binding.cost ?? undefined);
      assert.equal(
        response.headers.get("x-omniroute-cost-status"),
        binding.cost === null ? "unknown" : "known"
      );
    });
  }
}

test("native selection accepts the exact Zen free pair with the existing bounded defaults", () => {
  assert.deepEqual(
    nativeSelectionSchema.parse({
      ...selection,
      provider: "opencode-zen",
      model: "jev-1.13-free",
    }),
    { ...selection, provider: "opencode-zen", model: "jev-1.13-free", maxCandidates: 32 }
  );
});

test("the existing Zen paid pair remains distinct and supported", () => {
  assert.deepEqual(
    nativeSelectionSchema.parse({
      ...selection,
      provider: "opencode-zen",
      model: "jev-1.13",
    }),
    { ...selection, provider: "opencode-zen", model: "jev-1.13", maxCandidates: 32 }
  );
});

test("Zen free selection cannot cross providers or use unreviewed model spellings", () => {
  for (const provider of ["typesafe", "openrouter", "vercel-ai-gateway"]) {
    assert.equal(
      nativeSelectionSchema.safeParse({ ...selection, provider, model: "jev-1.13-free" }).success,
      false
    );
  }
  for (const model of [
    "jev-free",
    "jev-1.13:free",
    "Jev-1.13-free",
    "jev-1.13-free-paid",
    "opencode-zen/jev-1.13-free",
    "jev-1.13-free ",
  ]) {
    assert.equal(
      nativeSelectionSchema.safeParse({ ...selection, provider: "opencode-zen", model }).success,
      false
    );
  }
});

test("Zen free selection rejects unknown properties instead of widening its contract", () => {
  for (const extra of [
    { tier: "paid" },
    { allowPaidFallback: true },
    { apiKey: "synthetic-unsupported-key" },
    { headers: { "User-Agent": "caller-selected-identity" } },
    { url: "https://opencode.ai/inference/systemone/v1/systemone" },
  ]) {
    assert.equal(
      nativeSelectionSchema.safeParse({
        ...selection,
        provider: "opencode-zen",
        model: "jev-1.13-free",
        ...extra,
      }).success,
      false
    );
  }
});

test("unreviewed selector aliases remain unsupported", () => {
  for (const [provider, model] of [
    ["typesafe", "jev-latest"],
    ["typesafe", "jev-1.14"],
    ["openrouter", "typesafe/jev-1.14"],
    ["openrouter", "~typesafe/jev-latest"],
    ["vercel-ai-gateway", "typesafe-ai/jev-1.14.0"],
  ]) {
    assert.equal(nativeSelectionSchema.safeParse({ ...selection, provider, model }).success, false);
  }
});
