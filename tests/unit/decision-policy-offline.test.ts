import { test } from "node:test";
import assert from "node:assert/strict";
import { runDecisionPolicy } from "../../open-sse/services/decisionPolicy/run.ts";
import { nativeDecisionClient } from "../../open-sse/services/decisionPolicy/nativeSelector.ts";
import type {
  Candidate,
  DecisionOutcome,
  PolicyDeps,
} from "../../open-sse/services/decisionPolicy/contract.ts";
import {
  fixtureConfig as config,
  fixtureRequest as request,
  fixtureSnapshot as snapshot,
  scenarios,
} from "../fixtures/decision-policy/scenarios.ts";
import { evaluateAll, evaluateScenario } from "../../scripts/router-eval/decisionPolicyOffline.ts";

const actual = (c: Candidate) => ({ provider: c.provider, model: c.model, effort: c.effort.value });
function deps(extra: Partial<PolicyDeps> = {}): PolicyDeps {
  return {
    snapshot: async () => structuredClone(snapshot),
    execute: async (c) => ({ status: "success", costUsd: 0, committed: false, actual: actual(c) }),
    ...extra,
  };
}
for (const scenario of scenarios)
  test(`offline fixture: ${scenario.id}`, async () => {
    await evaluateScenario(scenario);
  });

test("reports policy conformance, not quality, and never copies prompt/state into traces", async () => {
  const result = await evaluateAll();
  assert.equal(result.qualityMeasured, false);
  assert.equal(result.totals.passed, scenarios.length + 6);
  assert.ok(result.totals.noRoute > 0);
  assert.equal(JSON.stringify(result).includes(request.state), false);
});

test("no hard-excluded candidate is revived by execution or decision fallback", async () => {
  const invoked: string[] = [];
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      snapshot: async () =>
        Object.fromEntries(
          config.candidates.map((c) => [
            c.id,
            {
              authorized: c.id === "basic",
              available: true,
              quota: "available",
            },
          ])
        ),
      execute: async (c) => {
        invoked.push(c.id);
        return { status: "retryable", costUsd: 0, committed: false, actual: actual(c) };
      },
    })
  );
  assert.equal(result.status, "execution_failed");
  assert.deepEqual(invoked, ["basic"]);
});

test("rechecks can remove a candidate, but a newly eligible exclusion cannot join fallback", async () => {
  let reads = 0;
  const called: string[] = [];
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      snapshot: async () => {
        reads++;
        return Object.fromEntries(
          config.candidates.map((c) => [
            c.id,
            {
              authorized: reads === 1 ? c.id === "basic" : c.id !== "basic",
              available: true,
              quota: "available",
            },
          ])
        );
      },
      execute: async (c) => {
        called.push(c.id);
        return { status: "success", costUsd: 0, committed: false, actual: actual(c) };
      },
    })
  );
  assert.equal(result.status, "no_route");
  assert.deepEqual(called, []);
  assert.ok(result.trace.some((t) => t.phase === "recheck" && t.reason.includes("unauthorized")));
});

test("unknown profile/effort/capabilities never become inferred model knowledge", async () => {
  for (const patch of [
    { evidence: null },
    { endpointKind: "unknown" },
    { capabilities: { ...config.candidates[0].capabilities, text: null } },
    { effort: { ...config.candidates[0].effort, supported: null } },
    { effort: { ...config.candidates[0].effort, evidence: null } },
  ]) {
    const result = await runDecisionPolicy(
      {
        ...config,
        candidates: [{ ...config.candidates[0], ...patch }],
        taskOrder: { explanation: ["basic"] },
      },
      request,
      deps()
    );
    assert.equal(result.status, "no_route");
    assert.equal(result.ledger.length, 0);
  }
});

test("invalid config, duplicate IDs and stale task references fail before dependencies", async () => {
  let reads = 0;
  for (const bad of [
    { ...config, version: 2 },
    { ...config, candidates: [{ ...config.candidates[0], id: "__proto__" }], taskOrder: {} },
    { ...config, candidates: [...config.candidates, config.candidates[0]] },
    { ...config, taskOrder: { explanation: ["missing"] } },
    { ...config, timeoutMs: 0 },
    { ...config, maxExecutionAttempts: 100 },
    { ...config, maxDecisionAttempts: 20 },
    { ...config, surprise: true },
  ]) {
    const result = await runDecisionPolicy(
      bad,
      request,
      deps({
        snapshot: async () => {
          reads++;
          return snapshot;
        },
      })
    );
    assert.equal(result.status, "invalid_config");
  }
  assert.equal(reads, 0);
});

test("invalid task facts and oversized state never dispatch", async () => {
  for (const patch of [
    { contextTokens: -1 },
    { state: "x".repeat(16385) },
    { reasoning: "true" },
  ]) {
    const result = await runDecisionPolicy(config, { ...request, ...patch }, deps());
    assert.equal(result.status, "invalid_request");
    assert.equal(result.ledger.length, 0);
  }
});

test("pre-aborted request never starts even ancillary dependencies", async () => {
  const c = new AbortController();
  c.abort();
  let calls = 0;
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      snapshot: async () => {
        calls++;
        return snapshot;
      },
    }),
    c.signal
  );
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 0);
});

for (const phase of ["snapshot", "decision", "execution"] as const) {
  for (const cancellation of ["caller", "timeout"] as const) {
    test(`${cancellation} stops ${phase}; late ancillary completion cannot trigger inference/fallback`, async () => {
      const controller = new AbortController();
      let signalStarted!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      let completed = 0,
        executions = 0,
        decisions = 0;
      const wait = async () => {
        signalStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        completed++;
      };
      const pending = runDecisionPolicy(
        { ...config, timeoutMs: cancellation === "timeout" ? 15 : 1000 },
        request,
        deps({
          snapshot: async () => {
            if (phase === "snapshot") await wait();
            return snapshot;
          },
          decisionClients: [
            {
              id: "fixture",
              select: async () => {
                decisions++;
                if (phase === "decision") await wait();
                return {
                  status: "selected",
                  optionId: "basic",
                  confidence: 1,
                  probabilities: { basic: 1, code_high: 0, code_medium: 0, multimodal: 0 },
                  costUsd: 0,
                };
              },
            },
          ],
          execute: async (c) => {
            executions++;
            if (phase === "execution") await wait();
            return { status: "retryable", costUsd: 0.01, committed: false, actual: actual(c) };
          },
        }),
        controller.signal
      );
      await started;
      if (cancellation === "caller") controller.abort();
      const keepAlive = setTimeout(() => {}, 1000);
      const result = await pending;
      clearTimeout(keepAlive);
      assert.equal(result.status, cancellation === "caller" ? "cancelled" : "timeout");
      assert.equal(completed, 0);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(completed, 1);
      assert.equal(executions, phase === "execution" ? 1 : 0);
      assert.equal(decisions, phase === "snapshot" ? 0 : 1);
      if (phase !== "snapshot") assert.equal(result.costs.total.totalUsd, null);
    });
  }
}

test("actual identity/effort change fails closed, retaining billed cost", async () => {
  let calls = 0;
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      execute: async (c) => {
        calls++;
        return {
          status: "success",
          costUsd: 0.01,
          committed: false,
          actual: { ...actual(c), effort: "high" },
        };
      },
    })
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "execution_failed");
  assert.equal(result.costs.execution.totalUsd, 0.01);
});

test("separate decision/execution attempt ledgers preserve exact zero, unknown and billed failures", async () => {
  let calls = 0;
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      decisionClients: [
        { id: "d1", select: async () => ({ status: "retryable", costUsd: 0.001 }) },
        {
          id: "d2",
          select: async () => ({
            status: "selected",
            optionId: "basic",
            confidence: 1,
            probabilities: { basic: 1, code_high: 0, code_medium: 0, multimodal: 0 },
            costUsd: 0,
          }),
        },
      ],
      execute: async (c) => ({
        status: ++calls === 1 ? "retryable" : "success",
        costUsd: calls === 1 ? null : 0.02,
        committed: false,
        actual: actual(c),
      }),
    })
  );
  assert.equal(result.status, "success");
  assert.deepEqual(result.costs.decision, {
    reportedUsd: 0.001,
    unknownAttempts: 0,
    totalUsd: 0.001,
  });
  assert.deepEqual(result.costs.execution, {
    reportedUsd: 0.02,
    unknownAttempts: 1,
    totalUsd: null,
  });
  assert.equal(result.costs.total.totalUsd, null);
  assert.equal(result.ledger.length, 4);
});

test("decision provider attempts bounded independently of execution attempts", async () => {
  let decisions = 0,
    executions = 0;
  const result = await runDecisionPolicy(
    { ...config, maxDecisionAttempts: 1 },
    request,
    deps({
      decisionClients: Array.from({ length: 3 }, (_, i) => ({
        id: `d${i}`,
        select: async () => {
          decisions++;
          return { status: "retryable" as const, costUsd: 0 };
        },
      })),
      execute: async (c) => {
        executions++;
        return { status: "success", costUsd: 0, committed: false, actual: actual(c) };
      },
    })
  );
  assert.equal(result.status, "decision_stopped");
  assert.equal(decisions, 1);
  assert.equal(executions, 0);
});

for (const outcome of [
  { status: "selected", optionId: "basic", confidence: 0, probabilities: null, costUsd: 0 },
  { status: "selected", optionId: "basic", confidence: null, probabilities: null, costUsd: 0 },
  {
    status: "selected",
    optionId: "basic",
    confidence: 0.7,
    probabilities: { basic: 0.8, code_medium: 0.1, code_high: 0.1 },
    costUsd: 0,
  },
  { status: "selected", optionId: "basic", probabilities: { basic: -1 }, costUsd: 0 },
] as DecisionOutcome[]) {
  test(`offered selection validates distribution without treating confidence ${outcome.confidence} as permission`, async () => {
    const result = await runDecisionPolicy(
      config,
      request,
      deps({ decisionClients: [{ id: "fixture", select: async () => outcome }] })
    );
    assert.equal(result.status, "decision_stopped");
  });
}

test("prototype-like tasks cannot select inherited order entries", async () => {
  const result = await runDecisionPolicy(config, { ...request, task: "__proto__" }, deps());
  assert.equal(result.status, "no_route");
  assert.equal(result.ledger.length, 0);
});

test("native selector constructs exact named choice; no credentials or ordinary chat parameters", async () => {
  let captured: Record<string, unknown> | undefined;
  const client = nativeDecisionClient({
    id: "synthetic",
    model: "explicit-native-id",
    call: async (body) => {
      captured = body;
      return {
        status: 200,
        body: {
          answers: {
            route: {
              type: "choice",
              choice: "basic",
              confidence: 0.7,
              probabilities: { basic: 0.8, code_high: 0.1, code_medium: 0.1 },
            },
          },
          usage: { cost: 0 },
        },
      };
    },
  });
  const response = await client.select(
    config.candidates.slice(0, 3),
    request,
    new AbortController().signal
  );
  assert.equal(response.status, "selected");
  assert.equal(response.confidence, 0.7);
  assert.deepEqual(Object.keys(captured!), ["model", "state", "questions"]);
  assert.equal(captured!.model, "explicit-native-id");
});

for (const status of [401, 402, 403, 429, 503, 200]) {
  test(`native response status ${status} retains auth/retry/refusal distinction`, async () => {
    const client = nativeDecisionClient({
      id: "fixture",
      model: "fixture",
      call: async () => ({ status, body: { answers: { route: { type: "refusal" } } } }),
    });
    const outcome = await client.select(config.candidates, request, new AbortController().signal);
    assert.equal(
      outcome.status,
      status === 401
        ? "auth"
        : [402, 403, 429].includes(status)
          ? "denied"
          : status === 200
            ? "refused"
            : "retryable"
    );
  });
}

for (const answer of [
  { type: "choice", choice: "basic" },
  { type: "choice", choice: "excluded", probabilities: { basic: 1 } },
  { type: "choice", choice: "basic", probabilities: {} },
])
  test(`native unknown/malformed output stays explicit: ${JSON.stringify(answer)}`, async () => {
    const client = nativeDecisionClient({
      id: "fixture",
      model: "fixture",
      call: async () => ({ status: 200, body: { answers: { route: answer } } }),
    });
    const outcome = await client.select(config.candidates, request, new AbortController().signal);
    assert.equal(outcome.status, "probabilities" in answer ? "invalid" : "unknown");
  });

test("native supports 255 explicit choices; does not inherit OpenCodex's internal 26-option cap", async () => {
  let count = 0;
  const candidates = Array.from({ length: 255 }, (_, i) => ({
    ...config.candidates[0],
    id: `o${i}`,
    model: `m${i}`,
  }));
  const client = nativeDecisionClient({
    id: "fixture",
    model: "fixture",
    call: async (body) => {
      count = Object.keys(
        (body.questions as { route: { criteria: Record<string, string> } }).route.criteria
      ).length;
      return { status: 200, body: { answers: { route: { type: "refusal" } } } };
    },
  });
  assert.equal(
    (await client.select(candidates, request, new AbortController().signal)).status,
    "refused"
  );
  assert.equal(count, 255);
  assert.equal(
    (
      await client.select(
        [...candidates, { ...candidates[0], id: "too_many" }],
        request,
        new AbortController().signal
      )
    ).status,
    "invalid"
  );
});

for (const status of ["refused", "auth"] as const)
  test(`explicit deterministic fallback never overrides terminal ${status}`, async () => {
    let executions = 0;
    const result = await runDecisionPolicy(
      { ...config, decisionFailure: "deterministic" },
      request,
      deps({
        decisionClients: [{ id: "fixture", select: async () => ({ status, costUsd: 0.001 }) }],
        execute: async (c) => {
          executions++;
          return { committed: false, status: "success", costUsd: 0, actual: actual(c) };
        },
      })
    );
    assert.equal(result.status, "decision_stopped");
    assert.equal(executions, 0);
    assert.equal(result.costs.decision.totalUsd, 0.001);
  });

test("cancel immediately after callback settlement preserves reported bill but stops success/fallback", async () => {
  const controller = new AbortController();
  const queue = (depth: number, fn: () => void): void => {
    if (depth === 0) fn();
    else queueMicrotask(() => queue(depth - 1, fn));
  };
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      execute: async (c) => {
        queue(4, () => controller.abort());
        return { committed: false, status: "success", costUsd: 0.01, actual: actual(c) };
      },
    }),
    controller.signal
  );
  assert.equal(result.status, "cancelled");
  assert.equal(result.ledger.length, 1);
  assert.equal(result.costs.execution.totalUsd, 0.01);
});

test("output commitment prohibits execution fallback even on a retryable status", async () => {
  let calls = 0;
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      execute: async (c) => {
        calls++;
        return { committed: true, status: "retryable", costUsd: 0.02, actual: actual(c) };
      },
    })
  );
  assert.equal(calls, 1);
  assert.equal(result.status, "execution_failed");
});

test("native ties, zero confidence and candidate counts remain metadata rather than correctness thresholds", async () => {
  for (const count of [2, 3, 4]) {
    const candidates = config.candidates.slice(0, count);
    const probabilities = Object.fromEntries(
      candidates.map((candidate) => [candidate.id, 1 / count])
    );
    const client = nativeDecisionClient({
      id: "fixture",
      model: "fixture",
      call: async () => ({
        status: 200,
        body: {
          answers: { route: { type: "choice", choice: "basic", confidence: 0, probabilities } },
        },
      }),
    });
    const result = await runDecisionPolicy(
      { ...config, candidates, taskOrder: { explanation: candidates.map((c) => c.id) } },
      request,
      deps({ decisionClients: [client] })
    );
    assert.equal(result.status, "success");
    assert.equal(result.decisions[0].confidence, 0);
    assert.deepEqual(result.decisions[0].probabilities, probabilities);
  }
});

test("forged selected status cannot bypass complete native evidence or highest-choice validation", async () => {
  for (const evidence of [
    { probabilities: { basic: 0, code_high: 1, code_medium: 0, multimodal: 0 }, confidence: 1 },
    { probabilities: { basic: 1, code_high: 0, code_medium: 0, multimodal: 0 }, confidence: null },
    { probabilities: null, confidence: 0 },
  ]) {
    const result = await runDecisionPolicy(
      config,
      request,
      deps({
        decisionClients: [
          {
            id: "fixture",
            select: async () => ({
              status: "selected",
              optionId: "basic",
              costUsd: 0.001,
              ...evidence,
            }),
          },
        ],
      })
    );
    assert.equal(result.status, "decision_stopped");
    assert.equal(result.costs.execution.totalUsd, 0);
  }
});

test("negative/non-finite cost stays unknown; explicit zero stays known", async () => {
  for (const cost of [0, null, -1, Infinity, NaN]) {
    const result = await runDecisionPolicy(
      config,
      request,
      deps({
        execute: async (c) => ({
          status: "success",
          committed: false,
          costUsd: cost,
          actual: actual(c),
        }),
      })
    );
    assert.equal(result.costs.total.totalUsd, cost === 0 ? 0 : null);
  }
});

test("callbacks cannot mutate offered profiles or task facts", async () => {
  let mutationFailures = 0;
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      decisionClients: [
        {
          id: "fixture",
          select: async (options, facts) => {
            try {
              options[0].model = "forbidden";
            } catch {
              mutationFailures++;
            }
            try {
              options[0].capabilities.images = true;
            } catch {
              mutationFailures++;
            }
            try {
              facts.reasoning = true;
            } catch {
              mutationFailures++;
            }
            return { status: "refused", costUsd: 0 };
          },
        },
      ],
    })
  );
  assert.equal(result.status, "decision_stopped");
  assert.equal(mutationFailures, 3);
  assert.equal(config.candidates[0].model, "basic");
  assert.equal(request.reasoning, false);
});

test("normalization tolerance never permits an individual probability above one", async () => {
  let executions = 0;
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      decisionClients: [
        {
          id: "forged",
          select: async () => ({
            status: "selected",
            optionId: "basic",
            confidence: 1,
            probabilities: { basic: 1.0000005, code_high: 0, code_medium: 0, multimodal: 0 },
            costUsd: 0,
          }),
        },
      ],
      execute: async (c) => {
        executions++;
        return { status: "success", committed: false, costUsd: 0, actual: actual(c) };
      },
    })
  );
  assert.equal(result.status, "decision_stopped");
  assert.equal(executions, 0);
});

test("cancellation between decisions cannot add a phantom unknown-cost attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const queue = (n: number): void => {
    if (n === 0) controller.abort();
    else queueMicrotask(() => queue(n - 1));
  };
  const result = await runDecisionPolicy(
    config,
    request,
    deps({
      decisionClients: [
        {
          id: "first",
          select: async () => {
            calls++;
            queue(5);
            return { status: "retryable", costUsd: 0.001 };
          },
        },
        {
          id: "second",
          select: async () => {
            calls++;
            return { status: "refused", costUsd: null };
          },
        },
      ],
    }),
    controller.signal
  );
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(result.ledger.length, calls);
  assert.equal(result.costs.decision.totalUsd, 0.001);
});

for (const status of [402, 403, 429]) {
  test(`native denial HTTP${status} cannot become deterministic or decision-provider fallback`, async () => {
    let first = 0,
      second = 0,
      executed = 0;
    const result = await runDecisionPolicy(
      { ...config, decisionFailure: "deterministic" },
      request,
      deps({
        decisionClients: [
          nativeDecisionClient({
            id: "denied",
            model: "fixture",
            call: async () => {
              first++;
              return {
                status,
                body: {
                  error: { name: "FreeUsageLimitError", message: "Free usage limit reached." },
                },
              };
            },
          }),
          {
            id: "must-not-run",
            select: async () => {
              second++;
              return { status: "unknown", costUsd: 0 };
            },
          },
        ],
        execute: async (candidate) => {
          executed++;
          return { status: "success", costUsd: 0, committed: false, actual: actual(candidate) };
        },
      })
    );
    assert.equal(first, 1);
    assert.equal(second, 0);
    assert.equal(executed, 0);
    assert.equal(result.status, "decision_stopped");
    assert.equal(result.costs.decision.totalUsd, null);
  });
}
