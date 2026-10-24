import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runDecisionPolicy } from "../../open-sse/services/decisionPolicy/run.ts";
import type {
  DecisionClient,
  PolicyResult,
} from "../../open-sse/services/decisionPolicy/contract.ts";
import {
  fixtureConfig,
  fixtureRequest,
  fixtureSnapshot,
  scenarios,
  type Scenario,
} from "../../tests/fixtures/decision-policy/scenarios.ts";

export async function evaluateScenario(scenario: Scenario) {
  const decisions: DecisionClient[] = (scenario.decision ?? []).map((outcome, i) => ({
    id: `synthetic_decision_${i}`,
    select: async () => structuredClone(outcome),
  }));
  let attempts = 0;
  const result = await runDecisionPolicy(
    { ...fixtureConfig, ...scenario.config },
    {
      ...fixtureRequest,
      ...scenario.request,
    },
    {
      snapshot: async () => ({ ...fixtureSnapshot, ...scenario.states }),
      decisionClients: decisions,
      execute: async (candidate) => ({
        status: scenario.executions?.[attempts++] ?? "success",
        costUsd: 0.01,
        committed: false,
        actual: {
          provider: candidate.provider,
          model: candidate.model,
          effort: candidate.effort.value,
        },
      }),
    }
  );
  assert.equal(result.status, scenario.expected, scenario.id);
  if (scenario.selected !== undefined)
    assert.equal(result.selectedId, scenario.selected, scenario.id);
  return { id: scenario.id, conformance: "pass", ...result };
}
export async function evaluateFaults() {
  const rows: Array<
    { id: string; conformance: string; lateCallbackCompleted: boolean } & PolicyResult
  > = [];
  for (const phase of ["snapshot", "decision", "execution"] as const) {
    for (const fault of ["cancelled", "timeout"] as const) {
      const controller = new AbortController();
      let signalStarted!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      let completed = false,
        executions = 0;
      const wait = async () => {
        signalStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        completed = true;
      };
      const pending = runDecisionPolicy(
        { ...fixtureConfig, timeoutMs: fault === "timeout" ? 15 : 1000 },
        fixtureRequest,
        {
          snapshot: async () => {
            if (phase === "snapshot") await wait();
            return fixtureSnapshot;
          },
          decisionClients:
            phase === "decision"
              ? [
                  {
                    id: "synthetic-decision",
                    select: async () => {
                      await wait();
                      return { status: "refused", costUsd: null };
                    },
                  },
                ]
              : [],
          execute: async (candidate) => {
            executions++;
            await wait();
            return {
              status: "retryable",
              committed: false,
              costUsd: 0.01,
              actual: {
                provider: candidate.provider,
                model: candidate.model,
                effort: candidate.effort.value,
              },
            };
          },
        },
        controller.signal
      );
      await started;
      if (fault === "cancelled") controller.abort();
      const keepAlive = setTimeout(() => {}, 1000);
      let result: PolicyResult;
      try {
        result = await pending;
      } finally {
        clearTimeout(keepAlive);
      }
      assert.equal(result.status, fault);
      assert.equal(completed, false);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(completed, true);
      assert.equal(executions, phase === "execution" ? 1 : 0);
      rows.push({
        id: `${fault}_${phase}`,
        conformance: "pass",
        lateCallbackCompleted: completed,
        ...result,
      });
    }
  }
  return rows;
}
export async function evaluateAll() {
  const results = [];
  for (const scenario of scenarios) results.push(await evaluateScenario(scenario));
  results.push(...(await evaluateFaults()));
  return {
    schemaVersion: 1,
    suite: "synthetic-policy-conformance-v1",
    qualityMeasured: false,
    notes:
      "Synthetic expectations test policy contracts, not model quality, calibrated confidence, physical provider attempts or entitlement. Historical corpus missing SVG fixtures is not repaired by this suite.",
    totals: {
      scenarios: results.length,
      passed: results.length,
      noRoute: results.filter((row) => row.status === "no_route").length,
      executionFallbacks: results.filter(
        (row) => row.ledger.filter((entry) => entry.lane === "execution").length > 1
      ).length,
      decisionProviderFallbacks: results.filter(
        (row) => row.ledger.filter((entry) => entry.lane === "decision").length > 1
      ).length,
    },
    results,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await evaluateAll();
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report.totals) + "\n");
}
