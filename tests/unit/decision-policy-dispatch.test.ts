import "./_helpers/modelValidationEnvironment.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { MockAgent } from "undici";
import {
  runGuardedDecisionRequest as dispatchRequest,
  type GuardedRequestOptions,
} from "../../src/lib/decisionPolicy/guardedRequest.ts";
import { strictTransport } from "../../src/lib/decisionPolicy/strictTransport.ts";
import {
  extractRequestFacts,
  boundedJson,
} from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { fixtureConfig } from "../fixtures/decision-policy/scenarios.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
after(() => resetDbInstance());

import { writeFile } from "node:fs/promises";
import { runWithDirectFetchContext } from "../../open-sse/utils/proxyFetch.ts";
import {
  recordLearnedReasoningEffort,
  getLearnedReasoningEffort,
  __test_resetLearnedReasoningEffortCaps,
} from "../../open-sse/services/learnedReasoningEffortCaps.ts";
const traces: unknown[] = [];
async function runGuardedDecisionRequest(input: GuardedRequestOptions) {
  const result = await dispatchRequest(input);
  traces.push({
    id: `synthetic-dispatch-${traces.length + 1}`,
    synthetic: true,
    rejection: result.rejection,
    policy: result.policy,
    physicalDispatches: result.physicalDispatches,
  });
  return result;
}
after(async () => {
  if (process.env.DISPATCH_EVIDENCE_PATH)
    await writeFile(
      process.env.DISPATCH_EVIDENCE_PATH,
      JSON.stringify({ schemaVersion: 1, qualityMeasured: false, traces }, null, 2) + "\n"
    );
});
const config = {
  ...structuredClone(fixtureConfig),
  candidates: fixtureConfig.candidates.map((candidate) => ({
    ...structuredClone(candidate),
    provider: "openai",
    model: `fixture-policy-${candidate.id}`,
  })),
  taskOrder: { ...fixtureConfig.taskOrder, reasoning: ["code_high", "code_medium"] },
};
function options(
  agent: MockAgent,
  patch: Partial<GuardedRequestOptions> = {}
): GuardedRequestOptions {
  return {
    config,
    routeModel: "fixture-route",
    body: {
      model: "fixture-route",
      messages: [{ role: "user", content: "Explain a synthetic example." }],
      max_completion_tokens: 100,
    },
    bindings: config.candidates.map((candidate) => ({
      candidateId: candidate.id,
      connectionId: `fixture-${candidate.id}`,
      apiKey: "synthetic-fixture-key",
    })),
    measureContext: () => 100,
    readState: () => ({ authorized: true, available: true, quota: "available" }),
    fixtureAgent: agent,
    ...patch,
  };
}
const ok = (cost: number | null = 0.01) => ({
  choices: [{ message: { content: "synthetic fixture response" } }],
  usage: { cost },
});
function intercept(agent: MockAgent, status = 200, data = ok()) {
  return agent
    .get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(status, data);
}

test("actual BaseExecutor formatter and synthetic undici transport dispatch exactly one fixture request", async () => {
  const agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  intercept(agent);
  const result = await runGuardedDecisionRequest(options(agent));
  assert.equal(result.rejection, null);
  assert.equal(result.policy?.status, "success", JSON.stringify(result));
  assert.equal(result.synthetic, true);
  assert.equal(result.physicalDispatches.length, 1);
  assert.equal(result.policy?.costs.execution.totalUsd, 0.01);
  assert.equal(agent.getCallHistory()?.calls().length, 1);
  await agent.close();
});

for (const status of [400, 401, 402, 403, 422])
  test(`first ${status} is terminal, never recovery or credential rotation`, async () => {
    const agent = new MockAgent({ enableCallHistory: true });
    agent
      .get("https://api.openai.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(status, {
        error: {
          message: "reasoning_effort must be one of low, medium; unexpected field chat_template",
        },
        usage: { cost: 0.003 },
      });
    const result = await runGuardedDecisionRequest(options(agent));
    assert.equal(result.policy?.status, "execution_failed");
    assert.equal(result.physicalDispatches.length, 1);
    assert.equal(result.physicalDispatches[0].status, status);
    assert.equal(agent.getCallHistory()?.calls().length, 1);
    assert.equal(result.policy?.costs.execution.totalUsd, 0.003);
    await agent.close();
  });

for (const status of [429, 503])
  test(`execution ${status} falls back once inside the initial eligible set with separate costs`, async () => {
    const agent = new MockAgent({ enableCallHistory: true });
    intercept(agent, status, ok(0.001));
    intercept(agent, 200, ok(0.002));
    const result = await runGuardedDecisionRequest(options(agent));
    assert.equal(result.policy?.status, "success", JSON.stringify(result));
    assert.deepEqual(
      result.physicalDispatches.map((row) => row.candidateId),
      ["basic", "code_medium"]
    );
    assert.equal(result.policy?.costs.execution.totalUsd, 0.003);
    assert.equal(agent.getCallHistory()?.calls().length, 2);
    await agent.close();
  });

for (const status of [307, 308])
  test(`redirect ${status} is never followed`, async () => {
    const agent = new MockAgent({ enableCallHistory: true });
    agent
      .get("https://api.openai.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(status, "", { headers: { location: "https://forbidden.invalid/route" } });
    const result = await runGuardedDecisionRequest(options(agent));
    assert.equal(result.physicalDispatches.length, 1);
    assert.equal(result.policy?.status, "execution_failed");
    assert.equal(result.policy?.costs.execution.totalUsd, null);
    assert.equal(agent.getCallHistory()?.calls().length, 1);
    await agent.close();
  });

test("native refusal/auth never becomes inference, even with deterministic fallback configured", async () => {
  for (const status of ["refused", "auth"] as const) {
    const agent = new MockAgent({ enableCallHistory: true });
    const result = await runGuardedDecisionRequest(
      options(agent, {
        config: { ...config, decisionFailure: "deterministic" },
        decisionClients: [
          { id: "fixture-decision", select: async () => ({ status, costUsd: 0.001 }) },
        ],
      })
    );
    assert.equal(result.policy?.status, "decision_stopped");
    assert.equal(result.physicalDispatches.length, 0);
    assert.equal(result.policy?.costs.decision.totalUsd, 0.001);
    assert.equal(agent.getCallHistory()?.calls().length ?? 0, 0);
    await agent.close();
  }
});

test("inference refusal remains terminal and keeps its reported charge", async () => {
  const agent = new MockAgent();
  agent
    .get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, {
      choices: [{ message: { refusal: "synthetic refusal" } }],
      usage: { cost: 0.004 },
    });
  const result = await runGuardedDecisionRequest(options(agent));
  assert.equal(result.policy?.status, "execution_failed");
  assert.equal(result.physicalDispatches.length, 1);
  assert.equal(result.policy?.costs.execution.totalUsd, 0.004);
  await agent.close();
});

test("zero eligible remains no route and cannot use any global/alias fallback", async () => {
  const agent = new MockAgent();
  const result = await runGuardedDecisionRequest(
    options(agent, {
      readState: () => ({ authorized: false, available: true, quota: "available" }),
    })
  );
  assert.equal(result.policy?.status, "no_route");
  assert.equal(result.physicalDispatches.length, 0);
  await agent.close();
});

test("unknown context, conflicting effort carriers, streaming and route identity fail before any provider call", async () => {
  const agent = new MockAgent();
  for (const patch of [
    { measureContext: () => null },
    {
      body: {
        ...(options(agent).body as object),
        reasoning_effort: "medium",
        reasoning: { effort: "high" },
      },
    },
    { body: { ...(options(agent).body as object), stream: true } },
    { body: { ...(options(agent).body as object), model: "unrequested-explicit-model" } },
    { body: { ...(options(agent).body as object), globalFallbackModel: "forbidden" } },
  ]) {
    const result = await runGuardedDecisionRequest(options(agent, patch));
    assert.ok(result.rejection);
    assert.equal(result.physicalDispatches.length, 0);
  }
  await agent.close();
});

test("input plus reserved output must fit, not input alone", async () => {
  const agent = new MockAgent();
  const result = await runGuardedDecisionRequest(
    options(agent, {
      measureContext: () => 127950,
      body: { ...(options(agent).body as object), max_completion_tokens: 1000 },
    })
  );
  assert.equal(result.policy?.status, "no_route");
  assert.equal(result.physicalDispatches.length, 0);
  await agent.close();
});

test("bounded fact extraction never copies raw secrets into decision state", () => {
  const secret = "synthetic-private-value-must-not-enter-trace";
  const result = extractRequestFacts(
    {
      model: "fixture-route",
      messages: [{ role: "user", content: `Derive a proof for ${secret}` }],
      max_completion_tokens: 100,
    },
    { measureContext: () => 50 }
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.facts.task, "reasoning");
    assert.equal(result.facts.contextTokens, 150);
    assert.ok(!result.facts.state.includes(secret));
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(boundedJson(cycle), false);
  assert.equal(boundedJson({ text: "x".repeat(262145) }), false);
  let read = false;
  const accessor = Object.defineProperty({}, "secret", {
    get() {
      read = true;
      return secret;
    },
  });
  assert.equal(boundedJson(accessor), false);
  assert.equal(read, false);
});

for (const payload of [
  {},
  { error: { message: "synthetic error" }, usage: { cost: 0.005 } },
  { choices: [] },
  { choices: [{ message: {} }] },
]) {
  test(`malformed success is terminal and keeps reported cost: ${JSON.stringify(payload)}`, async () => {
    const agent = new MockAgent({ enableCallHistory: true });
    agent
      .get("https://api.openai.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, payload);
    const result = await runGuardedDecisionRequest(options(agent));
    assert.equal(result.policy?.status, "execution_failed");
    assert.equal(result.physicalDispatches.length, 1);
    assert.equal(result.policy?.costs.execution.totalUsd, "usage" in payload ? 0.005 : null);
    await agent.close();
  });
}

test("socket reset is one underlying send with unknown spend and no replay", async () => {
  const agent = new MockAgent({ enableCallHistory: true });
  const error = Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" });
  agent
    .get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .replyWithError(error);
  const result = await runGuardedDecisionRequest(options(agent));
  assert.equal(result.policy?.status, "execution_failed");
  assert.equal(result.physicalDispatches.length, 1);
  assert.equal(result.policy?.costs.execution.totalUsd, null);
  assert.equal(agent.getCallHistory()?.calls().length, 1);
  await agent.close();
});

for (const kind of ["caller", "deadline"] as const)
  test(`${kind} stops actual pending undici request without later fallback`, async () => {
    const agent = new MockAgent({ enableCallHistory: true });
    const controller = new AbortController();
    intercept(agent, 503, ok(0.001)).delay(100);
    const timer = setTimeout(() => {
      if (kind === "caller") controller.abort();
    }, 15);
    const result = await runGuardedDecisionRequest(
      options(agent, {
        signal: controller.signal,
        config: { ...config, timeoutMs: kind === "deadline" ? 15 : 1000 },
      })
    );
    clearTimeout(timer);
    assert.equal(result.policy?.status, kind === "caller" ? "cancelled" : "timeout");
    assert.equal(result.physicalDispatches.length, 1);
    assert.equal(result.policy?.costs.execution.totalUsd, null);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(agent.getCallHistory()?.calls().length, 1);
    assert.equal(result.physicalDispatches[0].costUsd, null);
    await agent.close();
  });

test("pre-aborted and already-committed output make zero physical attempts and known zero spend", async () => {
  const agent = new MockAgent();
  const controller = new AbortController();
  controller.abort();
  for (const patch of [{ signal: controller.signal }, { isOutputCommitted: () => true }]) {
    const result = await runGuardedDecisionRequest(options(agent, patch));
    assert.equal(result.physicalDispatches.length, 0);
    assert.equal(result.policy?.costs.execution.totalUsd, 0);
  }
  await agent.close();
});

test("output committed after a failed response prohibits execution-model fallback", async () => {
  const agent = new MockAgent({ enableCallHistory: true });
  let committed = false;
  agent
    .get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(() => {
      committed = true;
      return { statusCode: 503, data: ok(0.002) };
    });
  const result = await runGuardedDecisionRequest(
    options(agent, { isOutputCommitted: () => committed })
  );
  assert.equal(result.physicalDispatches.length, 1);
  assert.equal(result.policy?.status, "execution_failed");
  assert.equal(result.policy?.costs.execution.totalUsd, 0.002);
  await agent.close();
});

test("final context recount and fresh authorization stop pre-dispatch changes", async () => {
  const agent = new MockAgent();
  let measurements = 0;
  const context = await runGuardedDecisionRequest(
    options(agent, { measureContext: () => (++measurements === 1 ? 100 : 101) })
  );
  assert.equal(context.physicalDispatches.length, 0);
  assert.equal(context.policy?.costs.execution.totalUsd, 0);
  let reads = 0;
  const auth = await runGuardedDecisionRequest(
    options(agent, {
      readState: () => ({ authorized: ++reads < 10, available: true, quota: "available" }),
    })
  );
  assert.equal(auth.physicalDispatches.length, 0);
  assert.equal(auth.policy?.costs.execution.totalUsd, 0);
  await agent.close();
});

test("configured proxy, explicit-direct sentinel and TLS configuration are rejected rather than bypassed", async (t) => {
  const agent = new MockAgent();
  const names = [
    "HTTPS_PROXY",
    "NO_PROXY",
    "ENABLE_TLS_FINGERPRINT",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ];
  const prior = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    })
  );
  process.env.HTTPS_PROXY = "http://fixture-proxy.invalid:8888";
  process.env.NO_PROXY = "";
  assert.equal((await runGuardedDecisionRequest(options(agent))).rejection, "egress_unsupported");
  const explicit = await runWithDirectFetchContext(() => runGuardedDecisionRequest(options(agent)));
  assert.equal(explicit.rejection, "egress_unsupported");
  process.env.HTTPS_PROXY = "";
  process.env.ENABLE_TLS_FINGERPRINT = "true";
  assert.equal((await runGuardedDecisionRequest(options(agent))).rejection, "egress_unsupported");
  process.env.ENABLE_TLS_FINGERPRINT = "false";
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  assert.equal((await runGuardedDecisionRequest(options(agent))).rejection, "egress_unsupported");
  await agent.close();
});

test("learned effort clamping fails before dispatch, and first400 cannot learn a replacement", async () => {
  const agent = new MockAgent();
  __test_resetLearnedReasoningEffortCaps();
  recordLearnedReasoningEffort("openai", "fixture-policy-code_high", ["low", "medium"]);
  const result = await runGuardedDecisionRequest(
    options(agent, {
      body: {
        ...(options(agent).body as object),
        messages: [{ role: "user", content: "Debug a complex algorithm invariant." }],
      },
    })
  );
  assert.equal(result.physicalDispatches.length, 0);
  assert.equal(result.policy?.status, "execution_failed");
  __test_resetLearnedReasoningEffortCaps();
  agent
    .get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(400, {
      error: { message: "reasoning_effort must be one of low, medium" },
      usage: { cost: 0.003 },
    });
  await runGuardedDecisionRequest(options(agent));
  assert.equal(getLearnedReasoningEffort("openai", "fixture-policy-basic"), null);
  await agent.close();
});

test("tool continuation requires an explicit eligible pin and preserves offered tool pairs", async () => {
  const agent = new MockAgent();
  const body = {
    model: "fixture-route",
    max_completion_tokens: 100,
    messages: [
      { role: "user", content: "Use the fixture tool." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_fixture",
            type: "function",
            function: { name: "fixture_tool", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "synthetic result", tool_call_id: "call_fixture" },
    ],
  };
  assert.equal(
    (await runGuardedDecisionRequest(options(agent, { body }))).rejection,
    "continuation_unknown"
  );
  intercept(agent);
  const pinned = await runGuardedDecisionRequest(
    options(agent, { body, continuationCandidateId: "code_high" })
  );
  assert.equal(pinned.policy?.status, "success", JSON.stringify(pinned));
  assert.deepEqual(
    pinned.physicalDispatches.map((row) => row.candidateId),
    ["code_high"]
  );
  const denied = await runGuardedDecisionRequest(
    options(agent, {
      body,
      continuationCandidateId: "code_high",
      readState: (id) => ({ authorized: id !== "code_high", available: true, quota: "available" }),
    })
  );
  assert.equal(denied.policy?.status, "no_route");
  assert.equal(denied.physicalDispatches.length, 0);
  await agent.close();
});

test("decision-provider and execution fallback costs reconcile once across physical sends", async () => {
  const agent = new MockAgent();
  intercept(agent, 503, ok(0.003));
  intercept(agent, 200, ok(0.004));
  const probabilities = { basic: 1, code_high: 0, code_medium: 0, multimodal: 0 };
  const result = await runGuardedDecisionRequest(
    options(agent, {
      decisionClients: [
        {
          id: "synthetic-decision-a",
          select: async () => ({ status: "retryable", costUsd: 0.001 }),
        },
        {
          id: "synthetic-decision-b",
          select: async () => ({
            status: "selected",
            optionId: "basic",
            confidence: 1,
            probabilities,
            costUsd: 0.002,
          }),
        },
      ],
    })
  );
  assert.equal(result.policy?.status, "success");
  assert.equal(result.policy?.costs.decision.totalUsd, 0.003);
  assert.equal(result.policy?.costs.execution.totalUsd, 0.007);
  assert.equal(result.policy?.costs.total.totalUsd, 0.01);
  assert.equal(result.physicalDispatches.length, 2);
  await agent.close();
});

test("sparse arrays cannot defeat traversal bounds through tool schemas", () => {
  assert.equal(boundedJson(new Array(1000000)), false);
  assert.equal(boundedJson([,]), false);
});

test("unrecognized text keeps unresolved task instead of assuming a cheap explanation target", async () => {
  const agent = new MockAgent();
  const result = await runGuardedDecisionRequest(
    options(agent, {
      body: {
        ...(options(agent).body as object),
        messages: [{ role: "user", content: "Arbitrary unclassified fixture data." }],
      },
    })
  );
  assert.equal(result.policy?.status, "no_route");
  assert.equal(result.physicalDispatches.length, 0);
  await agent.close();
});

test("connection authorization is checked for the exact immutable binding before selection and dispatch", async () => {
  const agent = new MockAgent();
  const seen: Array<string | null> = [];
  const result = await runGuardedDecisionRequest(
    options(agent, {
      readState: (_id, connectionId) => {
        seen.push(connectionId);
        return {
          authorized: connectionId === "not-configured",
          available: true,
          quota: "available",
        };
      },
    })
  );
  assert.equal(result.policy?.status, "no_route");
  assert.equal(result.physicalDispatches.length, 0);
  assert.ok(seen.includes("fixture-basic"));
  assert.ok(seen.every((id) => id?.startsWith("fixture-")));
  await agent.close();
});

test("mutating original bindings cannot replace credentials on execution-model fallback", async () => {
  const agent = new MockAgent();
  const input = options(agent);
  const bindings = input.bindings as Array<{
    candidateId: string;
    connectionId: string;
    apiKey: string;
  }>;
  agent
    .get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(() => {
      bindings.forEach((binding) => {
        binding.apiKey = "changed-private-fixture";
        binding.connectionId = "forbidden";
      });
      return { statusCode: 503, data: ok(0.001) };
    });
  agent
    .get("https://api.openai.com")
    .intercept({
      path: "/v1/chat/completions",
      method: "POST",
      headers: { authorization: "Bearer synthetic-fixture-key" },
    })
    .reply(200, ok(0.002));
  const result = await runGuardedDecisionRequest(input);
  assert.equal(result.policy?.status, "success");
  assert.equal(result.physicalDispatches.length, 2);
  assert.equal(JSON.stringify(result.policy).includes("changed-private-fixture"), false);
  await agent.close();
});

test("production transport stays disabled until application auth/redaction/accounting are integrated", async () => {
  const agent = new MockAgent();
  assert.throws(() => strictTransport({}), /production_transport_unvalidated/);
  const input = options(agent);
  delete input.fixtureAgent;
  const result = await runGuardedDecisionRequest(input);
  assert.equal(result.rejection, "production_transport_unvalidated");
  assert.equal(result.physicalDispatches.length, 0);
  await agent.close();
});

test("content-filter outcomes retain refusal semantics even with partial content", async () => {
  const agent = new MockAgent();
  agent
    .get("https://api.openai.com")
    .intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, {
      choices: [
        { finish_reason: "content_filter", message: { content: "partial synthetic output" } },
      ],
      usage: { cost: 0.002 },
    });
  const result = await runGuardedDecisionRequest(options(agent));
  assert.equal(result.policy?.status, "execution_failed");
  assert.equal(result.physicalDispatches.length, 1);
  assert.equal(result.policy?.costs.execution.totalUsd, 0.002);
  await agent.close();
});

test("reasoning facts cover every text part and all bounded text of the last user message", () => {
  for (const content of [
    [
      { type: "text", text: "Prove a complex algorithm invariant." },
      { type: "text", text: "Explain final result." },
    ],
    "Explain " + "x".repeat(4100) + " Prove a complex algorithm invariant.",
  ]) {
    const result = extractRequestFacts(
      { model: "fixture-route", max_completion_tokens: 100, messages: [{ role: "user", content }] },
      { measureContext: () => 100 }
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.facts.reasoning, true);
      assert.equal(result.facts.task, "complex_code");
    }
  }
});

test("unsupported transport/fixed profiles and unbound candidates are excluded before native selection", async () => {
  const agent = new MockAgent();
  let decisions = 0;
  for (const patch of [
    {
      config: {
        ...config,
        candidates: config.candidates.map((c) => ({ ...c, provider: "unverified-alias" })),
      },
    },
    {
      config: {
        ...config,
        candidates: config.candidates.map((c) => ({
          ...c,
          effort: { ...c.effort, mode: "fixed" },
        })),
      },
    },
    { bindings: [] },
  ]) {
    const result = await runGuardedDecisionRequest(
      options(agent, {
        ...patch,
        decisionClients: [
          {
            id: "fixture",
            select: async () => {
              decisions++;
              return { status: "refused", costUsd: 0.001 };
            },
          },
        ],
      })
    );
    assert.equal(result.policy?.status, "no_route");
    assert.equal(result.physicalDispatches.length, 0);
  }
  assert.equal(decisions, 0);
  await agent.close();
});

test("image requirements use explicit fixture capability, never model-name inference", async () => {
  const agent = new MockAgent();
  const body = {
    ...(options(agent).body as object),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this fixture image." },
          { type: "image_url", image_url: { url: "https://synthetic-image.invalid/image.png" } },
        ],
      },
    ],
  };
  const unknown = await runGuardedDecisionRequest(
    options(agent, {
      body,
      config: {
        ...config,
        candidates: config.candidates.map((c) => ({
          ...c,
          capabilities: { ...c.capabilities, images: null },
        })),
      },
    })
  );
  assert.equal(unknown.policy?.status, "no_route");
  assert.equal(unknown.physicalDispatches.length, 0);
  intercept(agent);
  const known = await runGuardedDecisionRequest(options(agent, { body }));
  assert.equal(known.policy?.status, "success");
  assert.equal(known.physicalDispatches[0].candidateId, "multimodal");
  await agent.close();
});

for (const choice of [
  { message: { refusal: "synthetic refusal" } },
  { finish_reason: "content_filter", message: { content: "partial synthetic output" } },
])
  test(`explicit refusal remains terminal even on retryable503: ${JSON.stringify(choice)}`, async () => {
    const agent = new MockAgent({ enableCallHistory: true });
    agent
      .get("https://api.openai.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(503, { choices: [choice], usage: { cost: 0.001 } });
    const result = await runGuardedDecisionRequest(options(agent));
    assert.equal(result.policy?.status, "execution_failed");
    assert.equal(result.physicalDispatches.length, 1);
    assert.equal(agent.getCallHistory()?.calls().length, 1);
    assert.equal(result.policy?.costs.execution.totalUsd, 0.001);
    await agent.close();
  });
