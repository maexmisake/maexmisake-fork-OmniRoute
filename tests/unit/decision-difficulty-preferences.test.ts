import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eligibleCandidates,
  taskPreferenceKey,
} from "../../open-sse/services/decisionPolicy/eligibility.ts";
import {
  fixtureConfig,
  fixtureRequest,
  fixtureSnapshot,
} from "../fixtures/decision-policy/scenarios.ts";
import type { PolicyResult } from "../../open-sse/services/decisionPolicy/contract.ts";
import { extractRequestFacts } from "../../open-sse/services/decisionPolicy/requestFacts.ts";

test("local difficulty does not change an absent operator preference", () => {
  const request = { ...fixtureRequest, difficulty: "critical" as const };
  assert.equal(taskPreferenceKey(fixtureConfig, request), "explanation");
  const trace: PolicyResult["trace"] = [];
  assert.deepEqual(
    eligibleCandidates(fixtureConfig, request, fixtureSnapshot, trace).map((row) => row.id),
    fixtureConfig.taskOrder.explanation
  );
  assert.ok(!trace.some((row) => row.reason === "difficulty_scoped_order"));
});

test("an explicitly configured difficulty order selects only its allowed profiles", () => {
  const config = structuredClone(fixtureConfig);
  config.taskOrder["explanation:difficult"] = ["code_high", "code_medium"];
  const trace: PolicyResult["trace"] = [];
  const result = eligibleCandidates(
    config,
    { ...fixtureRequest, difficulty: "difficult" },
    fixtureSnapshot,
    trace
  );
  assert.deepEqual(
    result.map((row) => row.id),
    ["code_high", "code_medium"]
  );
  assert.ok(trace.some((row) => row.reason === "difficulty_scoped_order"));
});

test("difficulty preferences cannot revive unauthorized candidates or override client effort", () => {
  const config = structuredClone(fixtureConfig);
  config.taskOrder["explanation:critical"] = ["code_medium", "code_high"];
  const request = {
    ...fixtureRequest,
    difficulty: "critical" as const,
    clientEffort: "high" as const,
  };
  assert.deepEqual(
    eligibleCandidates(config, request, fixtureSnapshot, []).map((row) => row.id),
    ["code_high"]
  );
  assert.deepEqual(
    eligibleCandidates(
      config,
      request,
      { ...fixtureSnapshot, code_high: { authorized: false, available: true, quota: "available" } },
      []
    ),
    []
  );
});

test("explicit empty and unknown difficulty orders retain genuine no-route semantics", () => {
  const config = structuredClone(fixtureConfig);
  config.taskOrder["explanation:unknown"] = [];
  assert.deepEqual(
    eligibleCandidates(config, { ...fixtureRequest, difficulty: "unknown" }, fixtureSnapshot, []),
    []
  );
  assert.equal(taskPreferenceKey(config, fixtureRequest), "explanation");
});

test("inherited difficulty preferences are not accepted as operator configuration", () => {
  const order = Object.assign(
    Object.create({ "explanation:critical": ["code_high"] }),
    fixtureConfig.taskOrder
  );
  const config = { ...fixtureConfig, taskOrder: order };
  assert.equal(
    taskPreferenceKey(config, { ...fixtureRequest, difficulty: "critical" }),
    "explanation"
  );
});

test("public request cannot inject a trusted difficulty label", () => {
  const result = extractRequestFacts(
    {
      model: "synthetic-combo",
      messages: [{ role: "user", content: "Explain a small example." }],
      max_tokens: 64,
      difficulty: "critical",
    },
    { measureContext: () => 10 }
  );
  assert.equal(result.ok, false);
});
