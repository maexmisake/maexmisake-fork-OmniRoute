import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarizeRoutingEvaluation } from "../../scripts/router-eval/decisionPolicyMetrics.ts";

const hash = (character: string) => character.repeat(64);

test("documented local CLI consumes separate artifacts without inventing an evaluation", () => {
  const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      local("../../scripts/router-eval/decisionPolicyMetrics.ts"),
      local("../fixtures/decisionPolicy/metrics-example-run.json"),
      local("../fixtures/decisionPolicy/metrics-example-labels.json"),
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536 }
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.outcomes.unrun, 1);
  assert.equal(report.taskQuality.graded, 0);
  assert.equal(report.taskQuality.passRate, null);
  assert.equal(report.calibration.brierScore, null);
  assert.equal(report.counterfactualSavingsUsd, null);
  assert.equal(report.independenceVerified, false);
});
function fixture() {
  const record = (caseId: number) => ({
    caseId,
    inputSha256: hash(String(caseId)),
    responseSha256: hash(String(caseId + 4)),
    candidateId: caseId === 2 ? "b" : "a",
    outcome: "completed",
    route: caseId === 2 ? "deterministic-fallback" : "native",
    predictedSuccess: caseId === 2 ? 0.2 : 0.8,
    decisionLatencyMs: caseId * 10,
    decisionCostUsd: 0.01,
    executionCostUsd: 0.1,
    decisionAttempts: 1,
    executionAttempts: 1,
    sessionId: "synthetic-session",
    turn: caseId,
  });
  const rows = [record(1), record(2), record(3), record(4)];
  Object.assign(rows[1], { decisionCostUsd: null, executionCostUsd: 0.2 });
  Object.assign(rows[2], {
    outcome: "unknown",
    responseSha256: null,
    predictedSuccess: 0.5,
    decisionLatencyMs: null,
    executionCostUsd: null,
    turn: 4,
  });
  Object.assign(rows[3], {
    outcome: "unrun",
    route: "unrun",
    candidateId: null,
    responseSha256: null,
    predictedSuccess: null,
    decisionLatencyMs: null,
    decisionCostUsd: null,
    executionCostUsd: null,
    decisionAttempts: 0,
    executionAttempts: 0,
    sessionId: null,
    turn: null,
  });
  return {
    run: {
      schemaVersion: 1,
      suiteSha256: hash("a"),
      policySha256: hash("b"),
      declaredSplit: "postdesign-synthetic",
      source: "externally-supplied-unverified",
      forecastTarget: "task-success",
      candidateIds: ["a", "b"],
      records: rows,
    },
    labels: {
      schemaVersion: 1,
      suiteSha256: hash("a"),
      records: rows.slice(0, 2).map((row) => ({
        caseId: row.caseId,
        inputSha256: row.inputSha256,
        responseSha256: row.responseSha256,
        passed: row.caseId === 1,
        acceptableCandidateIds: ["a"],
        source: "synthetic",
      })),
    },
  };
}

test("offline metrics keep outcome coverage, calibration, spending and session churn distinct", () => {
  const { run, labels } = fixture();
  const result = summarizeRoutingEvaluation(run, labels);
  assert.deepEqual(result.outcomes, { completed: 2, failed: 0, unknown: 1, unrun: 1 });
  assert.deepEqual(result.taskQuality, {
    graded: 2,
    passed: 1,
    passRate: 0.5,
    cohortCoverage: 0.5,
  });
  assert.equal(result.calibration.gradedForecasts, 2);
  assert.equal(result.calibration.suppliedForecasts, 3);
  assert.equal(result.calibration.cohortCoverage, 0.5);
  assert.equal(result.spending.total.physicalAttempts, 6);
  assert.ok(Math.abs(result.calibration.brierScore! - 0.04) < 1e-12);
  assert.ok(Math.abs(result.calibration.expectedCalibrationError! - 0.2) < 1e-12);
  assert.deepEqual(result.routing, {
    routed: 3,
    fallbacks: 1,
    fallbackRate: 1 / 3,
    labelledRoutes: 2,
    misroutes: 1,
    misrouteRate: 0.5,
  });
  assert.deepEqual(result.decisionLatencyMs, { reported: 2, p50: 10, p95: 20 });
  assert.equal(result.spending.decision.totalUsd, null);
  assert.equal(result.spending.decision.unknownRows, 1);
  assert.ok(Math.abs(result.spending.total.reportedUsd - 0.32) < 1e-12);
  assert.equal(result.spending.total.totalUsd, null);
  assert.deepEqual(result.sessionChurn, { adjacentTransitions: 1, changes: 1, rate: 1 });
  assert.equal(result.counterfactualSavingsUsd, null);
  assert.equal(result.independenceVerified, false);
  assert.equal(result.promotionDecision, null);
});

test("unrun and ungraded cohorts never become zero-error or zero-dollar performance", () => {
  const { run, labels } = fixture();
  run.records = [run.records[3]];
  labels.records = [];
  const result = summarizeRoutingEvaluation(run, labels);
  assert.equal(result.taskQuality.passRate, null);
  assert.equal(result.calibration.brierScore, null);
  assert.equal(result.calibration.expectedCalibrationError, null);
  assert.equal(result.spending.total.attemptedRows, 0);
  assert.equal(result.counterfactualSavingsUsd, null);
});

test("a no-route record cannot invent successful execution or a positive task grade", () => {
  const { run, labels } = fixture();
  Object.assign(run.records[0], { candidateId: null, route: "no-route" });
  assert.throws(() => summarizeRoutingEvaluation(run, labels));
});

test("duplicate session turns reject even when one record has no route", () => {
  const { run, labels } = fixture();
  Object.assign(run.records[1], {
    candidateId: null,
    route: "no-route",
    outcome: "failed",
    responseSha256: null,
    predictedSuccess: null,
    executionAttempts: 0,
    executionCostUsd: 0,
    turn: 1,
  });
  labels.records = [];
  assert.throws(() => summarizeRoutingEvaluation(run, labels));
});

test("settled execution failures count as negative task outcomes in calibration", () => {
  const { run, labels } = fixture();
  Object.assign(run.records[0], { outcome: "failed", responseSha256: null });
  Object.assign(labels.records[0], { passed: false, responseSha256: null });
  const result = summarizeRoutingEvaluation(run, labels);
  assert.equal(result.taskQuality.graded, 2);
  assert.equal(result.taskQuality.passed, 0);
  assert.equal(result.calibration.gradedForecasts, 2);
  assert.ok(Math.abs(result.calibration.brierScore! - 0.34) < 1e-12);
});

for (const mismatch of [
  "suite",
  "input",
  "response",
  "duplicate-label",
  "unknown-case",
  "duplicate-case",
  "invented-candidate",
  "invented-cost",
  "choice-confidence-target",
])
  test(`rejects inconsistent imported evidence: ${mismatch}`, () => {
    const { run, labels } = fixture();
    if (mismatch === "suite") labels.suiteSha256 = hash("c");
    if (mismatch === "input") labels.records[0].inputSha256 = hash("c");
    if (mismatch === "response") labels.records[0].responseSha256 = hash("c");
    if (mismatch === "duplicate-label") labels.records.push(labels.records[0]);
    if (mismatch === "unknown-case") labels.records[0].caseId = 99;
    if (mismatch === "duplicate-case") run.records.push(run.records[0]);
    if (mismatch === "invented-candidate") run.records[0].candidateId = "not-configured";
    if (mismatch === "invented-cost") run.records[3].decisionCostUsd = 0;
    if (mismatch === "choice-confidence-target") run.forecastTarget = "choice-confidence";
    assert.throws(() => summarizeRoutingEvaluation(run, labels));
  });
