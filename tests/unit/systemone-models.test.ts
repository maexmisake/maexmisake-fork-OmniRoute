/**
 * `GET /v1/systemone/models` — the decision-model catalog.
 *
 * The list is assembled from the configured provider connections only: a
 * backend with no usable connection is never advertised, ids stay
 * gateway-qualified (exactly what POST /v1/systemone accepts), price provenance
 * is explicit (upstream, operator override or unknown — never implied free), and
 * one broken backend does not hide the healthy ones.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleSystemOneModels,
  type SystemOneCatalogConnection,
  type SystemOneModelsDeps,
} from "../../open-sse/handlers/systemOneModels.ts";

const OPENROUTER_LIST = {
  data: [
    {
      id: "typesafe/jev-1.13",
      name: "TypeSafe: Jev 1.13",
      architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
      pricing: { prompt: "0.000000042", completion: "0" },
    },
    {
      id: "anthropic/claude-4",
      name: "Anthropic: Claude 4",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.000003", completion: "0.000015" },
    },
  ],
};

const ZEN_LIST = {
  data: [
    { id: "jev-1.13", name: "Jev 1.13" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free" },
    { id: "big-pickle", name: "Big Pickle" },
  ],
};

const VERCEL_LIST = {
  data: [{ id: "typesafe-ai/jev", name: "TypeSafe Jev" }],
};

function connection(
  provider: string,
  overrides: Partial<SystemOneCatalogConnection> = {}
): SystemOneCatalogConnection {
  return {
    id: `${provider}-conn`,
    provider,
    apiKey: "sk-test",
    accessToken: null,
    testStatus: null,
    rateLimitedUntil: null,
    providerSpecificData: null,
    ...overrides,
  };
}

function deps(
  connections: SystemOneCatalogConnection[],
  bodies: Record<string, unknown | (() => Promise<Response>)>,
  overrides: Partial<SystemOneModelsDeps> = {}
): SystemOneModelsDeps {
  return {
    listConnections: async () => connections,
    fetchSystemOne: async (url) => {
      const match = Object.keys(bodies).find((host) => url.includes(host));
      if (!match) throw new Error(`unexpected url ${url}`);
      const body = bodies[match];
      if (typeof body === "function") return (body as () => Promise<Response>)();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    getPricingForModel: async () => null,
    ...overrides,
  };
}

async function listed(response: Response) {
  const body = (await response.json()) as { object: string; data: Record<string, unknown>[] };
  return body.data;
}

test("with no configured connection nothing is advertised", async () => {
  const response = await handleSystemOneModels({}, deps([], {}));
  assert.equal(response.status, 200);
  assert.deepEqual(await listed(response), []);
  assert.equal(response.headers.get("X-OmniRoute-Catalog-Status"), "unconfigured");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("a provider without a System One backend is ignored entirely", async () => {
  const response = await handleSystemOneModels({}, deps([connection("anthropic")], {}));
  assert.deepEqual(await listed(response), []);
  assert.equal(response.headers.get("X-OmniRoute-Catalog-Status"), "unconfigured");
});

test("OpenRouter contributes only models whose output modality is decisions", async () => {
  const response = await handleSystemOneModels(
    {},
    deps([connection("openrouter")], { "openrouter.ai": OPENROUTER_LIST })
  );
  const models = await listed(response);
  assert.deepEqual(
    models.map((model) => model.id),
    ["openrouter/typesafe/jev-1.13"]
  );
  assert.equal(models[0].object, "model");
  assert.equal(models[0].owned_by, "openrouter");
  assert.equal(models[0].root, "typesafe/jev-1.13");
  assert.equal(models[0].type, "decision");
  assert.deepEqual(models[0].supported_endpoints, ["systemone"]);
  assert.equal(models[0].pricing_source, "upstream");
  assert.deepEqual(models[0].pricing, { prompt: "0.000000042", completion: "0" });
});

test("OpenRouter reads its public decisions filter", async () => {
  const urls: string[] = [];
  await handleSystemOneModels(
    {},
    deps(
      [connection("openrouter")],
      { "openrouter.ai": OPENROUTER_LIST },
      {
        fetchSystemOne: async (url) => {
          urls.push(url);
          return new Response(JSON.stringify(OPENROUTER_LIST), { status: 200 });
        },
      }
    )
  );
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models?output_modalities=decisions"]);
});

test("OpenCode Zen's shared model list is filtered to its decision models", async () => {
  const response = await handleSystemOneModels(
    {},
    deps([connection("opencode", { apiKey: null })], { "opencode.ai": ZEN_LIST })
  );
  const models = await listed(response);
  assert.deepEqual(
    models.map((model) => model.id),
    ["opencode/jev-1.13", "opencode/jev-1.13-free"]
  );
  // A chat model from the same list is not a decision model.
  assert.ok(!models.some((model) => String(model.id).includes("big-pickle")));
  assert.equal(models[0].pricing_status, "unknown");
  assert.equal(models[0].pricing, undefined);
  assert.equal(models[1].tier, "free");
});

test("a paid-only OpenCode account does not advertise the free-tier model", async () => {
  const response = await handleSystemOneModels(
    {},
    deps([connection("opencode", { apiKey: "sk-paid-zen" })], { "opencode.ai": ZEN_LIST })
  );
  const models = await listed(response);
  assert.deepEqual(
    models.map((model) => model.id),
    ["opencode/jev-1.13"]
  );
});

test("the Vercel AI Gateway contributes its TypeSafe model", async () => {
  const response = await handleSystemOneModels(
    {},
    deps([connection("vercel-ai-gateway")], { "ai-gateway.vercel.sh": VERCEL_LIST })
  );
  const models = await listed(response);
  assert.deepEqual(
    models.map((model) => model.id),
    ["vercel-ai-gateway/typesafe-ai/jev"]
  );
  assert.equal(models[0].root, "typesafe-ai/jev");
});

test("every configured backend contributes to one aggregated list", async () => {
  const response = await handleSystemOneModels(
    {},
    deps(
      [
        connection("openrouter"),
        connection("opencode", { apiKey: null }),
        connection("vercel-ai-gateway"),
      ],
      {
        "openrouter.ai": OPENROUTER_LIST,
        "opencode.ai": ZEN_LIST,
        "ai-gateway.vercel.sh": VERCEL_LIST,
      }
    )
  );
  assert.deepEqual((await listed(response)).map((model) => model.id).sort(), [
    "opencode/jev-1.13",
    "opencode/jev-1.13-free",
    "openrouter/typesafe/jev-1.13",
    "vercel-ai-gateway/typesafe-ai/jev",
  ]);
  assert.equal(response.headers.get("X-OmniRoute-Catalog-Status"), "complete");
});

test("an operator pricing row replaces the upstream price and is marked as such", async () => {
  const response = await handleSystemOneModels(
    {},
    deps(
      [connection("openrouter")],
      { "openrouter.ai": OPENROUTER_LIST },
      {
        getPricingForModel: async (provider, model) =>
          provider === "openrouter" && model === "typesafe/jev-1.13"
            ? { input: 1, output: 2 }
            : null,
      }
    )
  );
  const models = await listed(response);
  assert.equal(models[0].pricing_source, "operator");
  assert.deepEqual(models[0].pricing, { prompt: "0.000001", completion: "0.000002" });
});

test("a connection in cooldown or a terminal state does not advertise its backend", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  for (const overrides of [
    { rateLimitedUntil: future },
    { testStatus: "banned" },
    { testStatus: "expired" },
    { testStatus: "credits_exhausted" },
  ]) {
    const response = await handleSystemOneModels(
      {},
      deps([connection("openrouter", overrides)], { "openrouter.ai": OPENROUTER_LIST })
    );
    assert.deepEqual(await listed(response), [], JSON.stringify(overrides));
    assert.equal(response.headers.get("X-OmniRoute-Catalog-Status"), "unconfigured");
  }
});

test("an expired cooldown is eligible again", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const response = await handleSystemOneModels(
    {},
    deps([connection("openrouter", { rateLimitedUntil: past })], {
      "openrouter.ai": OPENROUTER_LIST,
    })
  );
  assert.equal((await listed(response)).length, 1);
});

test("a second key for the same provider is a fallback, not a duplicate listing", async () => {
  let calls = 0;
  const response = await handleSystemOneModels(
    {},
    deps(
      [connection("openrouter", { id: "or-1" }), connection("openrouter", { id: "or-2" })],
      {},
      {
        fetchSystemOne: async () => {
          calls++;
          if (calls === 1) return new Response("nope", { status: 500 });
          return new Response(JSON.stringify(OPENROUTER_LIST), { status: 200 });
        },
      }
    )
  );
  assert.equal(calls, 2, "the second connection retries the catalog read");
  assert.deepEqual(
    (await listed(response)).map((model) => model.id),
    ["openrouter/typesafe/jev-1.13"]
  );
});

test("one broken backend still lets the healthy ones list, reported as partial", async () => {
  const response = await handleSystemOneModels(
    {},
    deps([connection("openrouter"), connection("opencode", { apiKey: null })], {
      "openrouter.ai": OPENROUTER_LIST,
      "opencode.ai": async () => new Response("boom", { status: 500 }),
    })
  );
  assert.deepEqual(
    (await listed(response)).map((model) => model.id),
    ["openrouter/typesafe/jev-1.13"]
  );
  assert.equal(response.headers.get("X-OmniRoute-Catalog-Status"), "partial");
});

test("when every configured backend fails the catalog errors instead of looking empty", async () => {
  const response = await handleSystemOneModels(
    {},
    deps([connection("openrouter")], {
      "openrouter.ai": async () => new Response("boom", { status: 503 }),
    })
  );
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error?: { message?: string } };
  assert.doesNotMatch(String(body.error?.message), /sk-test/);
});

test("an upstream list that is not JSON or not a list is a failure, not an empty catalog", async () => {
  for (const payload of ["<html>", JSON.stringify({ unexpected: true })]) {
    const response = await handleSystemOneModels(
      {},
      deps([connection("openrouter")], {
        "openrouter.ai": async () => new Response(payload, { status: 200 }),
      })
    );
    assert.equal(response.status, 502, payload);
  }
});

test("the API key's model rules filter the list by its qualified id", async () => {
  const asked: string[] = [];
  const response = await handleSystemOneModels(
    {
      isModelAllowed: async (modelId) => {
        asked.push(modelId);
        return modelId !== "opencode/jev-1.13-free";
      },
    },
    deps([connection("opencode", { apiKey: null })], { "opencode.ai": ZEN_LIST })
  );
  assert.deepEqual(
    (await listed(response)).map((model) => model.id),
    ["opencode/jev-1.13"]
  );
  assert.deepEqual(asked.sort(), ["opencode/jev-1.13", "opencode/jev-1.13-free"]);
});

test("the API key's connection allowlist narrows which connections are read", async () => {
  const response = await handleSystemOneModels(
    { allowedConnections: ["or-2"] },
    deps([connection("openrouter", { id: "or-1" }), connection("openrouter", { id: "or-2" })], {
      "openrouter.ai": OPENROUTER_LIST,
    })
  );
  assert.equal((await listed(response)).length, 1);

  const none = await handleSystemOneModels(
    { allowedConnections: ["other-provider-conn"] },
    deps([connection("openrouter", { id: "or-1" })], { "openrouter.ai": OPENROUTER_LIST })
  );
  assert.deepEqual(await listed(none), []);
});

test("a caller cancellation is answered as a cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await handleSystemOneModels(
    { signal: controller.signal },
    deps([connection("openrouter")], { "openrouter.ai": OPENROUTER_LIST })
  );
  assert.equal(response.status, 499);
});
