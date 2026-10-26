import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { writeFile } from "node:fs/promises";
import type { Candidate } from "../../open-sse/services/decisionPolicy/contract.ts";

process.env.REQUIRE_API_KEY = "true";
process.env.PII_REDACTION_ENABLED = "true";
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { createCombo, updateCombo, getComboByName } = await import("../../src/lib/db/combos.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { readDecisionAttempts } = await import("../../src/lib/db/decisionAttempts.ts");

// Exact identities/efforts from the reviewed historical pool. All capability and
// health declarations below are synthetic fixtures, not live availability or quality evidence.
const codexIdentities = [
  ["codex-luna-max", "gpt-6-luna", "max", true],
  ["codex-56-sol-medium", "gpt-5.6-sol", "medium", false],
  ["codex-6-sol-medium", "gpt-6-sol", "medium", false],
  ["codex-56-sol-high", "gpt-5.6-sol", "high", false],
  ["codex-6-sol-high", "gpt-6-sol", "high", false],
  ["codex-56-sol-xhigh", "gpt-5.6-sol", "xhigh", false],
  ["codex-6-sol-xhigh", "gpt-6-sol", "xhigh", false],
  ["codex-56-sol-max", "gpt-5.6-sol", "max", false],
  ["codex-6-sol-max", "gpt-6-sol", "max", false],
] as const;
function profile(
  id: string,
  provider: string,
  model: string,
  effort: "medium" | "high" | "xhigh" | "max",
  fixed = false
): Candidate {
  return {
    id,
    provider,
    model,
    endpointKind: "direct",
    evidence: "Synthetic contract-eligibility profile; not live capability evidence",
    capabilities: {
      text: true,
      images: false,
      tools: false,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: {
      mode: fixed ? "fixed" : "set",
      value: effort,
      supported: [effort],
      evidence: "Synthetic fixture preserves the exact declared effort without aliases",
    },
  };
}
const codex = codexIdentities.map(([id, model, effort, fixed]) =>
  profile(id, "codex", model, effort, fixed)
);
const agyOpus = profile("agy-opus46-high", "agy", "claude-opus-4-6-thinking", "high", true);
const originalClaude = profile("claude-haiku55-medium", "claude", "claude-haiku-5-5", "medium");
const DECISION = "https://opencode.ai/inference/systemone/v1/systemone";
const EXECUTION = "https://api.anthropic.com/v1/messages?beta=true";
const MODEL = "synthetic-execution-contract-eligibility";
const credentials = {
  selector: "synthetic-free-jev-contract-key",
  claude: "synthetic-claude-contract-token",
};
const originalFetch = globalThis.fetch;
let POST: (request: Request) => Promise<Response>;
let comboId: string;
let key: Awaited<ReturnType<typeof createApiKey>>;
const connections: Record<string, string> = {};
let decisions = 0,
  executions = 0,
  unexpected = 0;
let configured: Candidate[] = [];
let configuredPolicy: unknown;
let configuredModels: unknown;
const offered: string[][] = [];
const observed: Array<{ provider: string; model: string; effort: string; cap: number }> = [];
const evidence: Array<Record<string, unknown>> = [];

before(async () => {
  // Initialize the application's fetch wrapper before installing the closed mock.
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init.method !== "POST" || ![DECISION, EXECUTION].includes(url)) {
      unexpected++;
      throw new Error("Closed contract fixture rejects any ancillary or substitute dispatch");
    }
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    if (url === DECISION) {
      decisions++;
      assert.equal(headers.get("authorization"), `Bearer ${credentials.selector}`);
      assert.equal(body.model, "jev-1.13-free");
      const ids = Object.keys(body.questions.route.criteria);
      offered.push(ids);
      assert.ok(ids.length >= 2);
      // A valid deterministic synthetic answer exposes premature selection; this
      // mock is not evidence that Jev prefers or can execute any offered model.
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: ids[0],
            confidence: 1,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === ids[0] ? 1 : 0])),
          },
        },
        usage: { input_tokens: 7, output_tokens: 1, cost: 0 },
      });
    }
    executions++;
    assert.equal(headers.get("authorization"), `Bearer ${credentials.claude}`);
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.output_config.effort, "medium");
    assert.equal(body.max_tokens, 64);
    assert.equal(body.stream, false);
    for (const name of ["temperature", "top_p", "top_k"]) assert.equal(body[name], undefined);
    observed.push({
      provider: "claude",
      model: body.model,
      effort: body.output_config.effort,
      cap: body.max_tokens,
    });
    return Response.json({
      id: "synthetic-contract-execution",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "Synthetic execution result" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cost: 0.002,
      },
    });
  };
  const closed = globalThis.fetch;
  ({ POST } = await import("../../src/app/api/v1/chat/completions/route.ts"));
  assert.equal(globalThis.fetch, closed);
  await updateSettings({
    memoryEnabled: false,
    semanticCacheEnabled: false,
    compressionEnabled: false,
    autoWebSearchEnabled: false,
    webSearchEnabled: false,
    streamDefaultMode: "json",
    globalFallbackModel: "openai/gpt-5.4",
  });
  for (const provider of ["codex", "agy", "claude"] as const) {
    connections[provider] = String(
      (
        await createProviderConnection({
          provider,
          authType: "oauth",
          name: `synthetic-contract-${provider}`,
          accessToken:
            provider === "claude" ? credentials.claude : `synthetic-contract-${provider}-token`,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          isActive: true,
          testStatus: "active",
          providerSpecificData: {},
        })
      ).id
    );
  }
  connections.selector = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-contract-free-selector",
        apiKey: credentials.selector,
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  // If ordinary global fallback ever escapes this lane, the closed mock rejects it.
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "synthetic-prohibited-substitute",
    apiKey: "synthetic-prohibited-substitute-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  comboId = String(
    (await createCombo({ name: MODEL, strategy: "priority", models: [], config: {} })).id
  );
});
beforeEach(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  key = await createApiKey("synthetic-contract-client", "synthetic");
  decisions = 0;
  executions = 0;
  unexpected = 0;
  offered.length = 0;
  observed.length = 0;
});
afterEach(async (context) => {
  assert.equal(unexpected, 0, "No ancillary, Codex, AGY or API-key substitute dispatch");
  const current = await getComboByName(MODEL);
  assert.deepEqual(
    current?.config,
    configuredPolicy,
    "The stored policy/preferences/bindings stay unchanged"
  );
  assert.deepEqual(current?.models, configuredModels, "The stored combo pool stays unchanged");
  assert.deepEqual(
    (current?.config as { decisionPolicy: { policy: { candidates: Candidate[] } } }).decisionPolicy
      .policy.candidates,
    configured
  );
  evidence.push({
    test: context.name,
    synthetic: true,
    configPoolUnchanged: true,
    configPreferencesAndBindingsUnchanged: true,
    decisions,
    executions,
    unexpected,
    offered: structuredClone(offered),
    observed: structuredClone(observed),
    receipts: readDecisionAttempts(key.id).map((row) => ({
      lane: row.lane,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      httpStatus: row.http_status,
      applicationStatus: row.application_status,
    })),
    liveCapabilityVerified: false,
    selectionQualityMeasured: false,
  });
});
after(async () => {
  if (process.env.NATIVE_EVIDENCE_PATH)
    await writeFile(process.env.NATIVE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  globalThis.fetch = originalFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
});
async function configure(candidates: Candidate[]) {
  configured = structuredClone(candidates);
  const ids = candidates.map((candidate) => candidate.id);
  await updateCombo(comboId, {
    models: candidates.map((candidate) => `${candidate.provider}/${candidate.model}`),
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        selection: {
          mode: "native",
          provider: "opencode-zen",
          model: "jev-1.13-free",
          connectionId: connections.selector,
          timeoutMs: 1000,
        },
        connections: Object.fromEntries(
          candidates.map((candidate) => [candidate.id, connections[candidate.provider]])
        ),
        policy: {
          version: 1,
          candidates,
          taskOrder: { explanation: ids },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: 1,
          maxExecutionAttempts: 1,
          timeoutMs: 5000,
        },
      },
    },
  });
  const stored = await getComboByName(MODEL);
  assert.ok(stored);
  configuredPolicy = structuredClone(stored.config);
  configuredModels = structuredClone(stored.models);
}
function request() {
  return new Request("http://application.invalid/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      max_completion_tokens: 64,
      messages: [{ role: "user", content: "Explain the synthetic execution contract." }],
    }),
  });
}
async function expectNoRoute() {
  const response = await POST(request());
  await response.text();
  assert.equal(
    decisions,
    0,
    "Unproven execution contracts must be excluded before native selection"
  );
  assert.equal(executions, 0);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "no-route");
  assert.equal(readDecisionAttempts(key.id).length, 0);
}
test("all nine original Codex identities are excluded before a native decision request", async () => {
  assert.equal(codex.length, 9);
  assert.equal(codex[0].model, "gpt-6-luna");
  assert.equal(codex[0].effort.mode, "fixed");
  assert.equal(codex[0].effort.value, "max");
  await configure(codex);
  await expectNoRoute();
});
test("unsupported AGY Opus and Codex cannot authorize a native decision or execution", async () => {
  await configure([agyOpus, codex[0]]);
  await expectNoRoute();
});
test("mixed pool preserves its original Claude pair as sole eligible without Jev or substitutes", async () => {
  await configure([agyOpus, originalClaude, ...codex]);
  const response = await POST(request());
  await response.text();
  assert.equal(decisions, 0, "Only proven execution contracts may be offered to the selector");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "sole-eligible");
  assert.equal(response.headers.get("x-omniroute-decision-status"), "no-decision");
  assert.equal(executions, 1);
  assert.deepEqual(observed, [
    { provider: "claude", model: "claude-haiku-5-5", effort: "medium", cap: 64 },
  ]);
  const receipts = readDecisionAttempts(key.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].lane, "execution");
  assert.equal(receipts[0].provider, "claude");
  assert.equal(receipts[0].model, "claude-haiku-5-5");
  assert.equal(receipts[0].effort, "medium");
  assert.equal(receipts[0].connection_id, connections.claude);
});
