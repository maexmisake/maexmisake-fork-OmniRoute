/** Offline imported-result metrics only. No transport, credentials or selector inputs. */
import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const nonnegative = z.number().finite().min(0);
const observationSchema = z
  .object({
    caseId: z.number().int().min(1).max(100000),
    inputSha256: sha,
    responseSha256: sha.nullable(),
    candidateId: id.nullable(),
    outcome: z.enum(["completed", "failed", "unknown", "unrun"]),
    route: z.enum(["native", "deterministic-fallback", "pinned", "no-route", "unrun"]),
    // Forecast of task success, NOT a native Choice confidence/distribution.
    predictedSuccess: z.number().min(0).max(1).nullable(),
    decisionLatencyMs: nonnegative.nullable(),
    decisionCostUsd: nonnegative.nullable(),
    executionCostUsd: nonnegative.nullable(),
    decisionAttempts: z.number().int().min(0).max(3),
    executionAttempts: z.number().int().min(0).max(5),
    sessionId: z.string().min(1).max(128).nullable(),
    turn: z.number().int().positive().nullable(),
  })
  .strict();
const runSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteSha256: sha,
    policySha256: sha,
    declaredSplit: z.enum(["development", "held-out", "postdesign-synthetic"]),
    source: z.literal("externally-supplied-unverified"),
    forecastTarget: z.literal("task-success"),
    candidateIds: z.array(id).min(1).max(255),
    records: z.array(observationSchema).max(10000),
  })
  .strict();
const labelSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteSha256: sha,
    records: z
      .array(
        z
          .object({
            caseId: z.number().int().min(1).max(100000),
            inputSha256: sha,
            responseSha256: sha.nullable(),
            passed: z.boolean().nullable(),
            acceptableCandidateIds: z.array(id).min(1).max(255).nullable(),
            source: z.enum(["human-review", "executable-check", "synthetic"]),
          })
          .strict()
      )
      .max(10000),
  })
  .strict();
type Observation = z.infer<typeof observationSchema>;
type Label = z.infer<typeof labelSchema>["records"][number];

function validateObservation(row: Observation, candidates: Set<string>): void {
  if (row.candidateId !== null && !candidates.has(row.candidateId))
    throw new Error("Unconfigured evaluation candidate");
  if ((row.sessionId === null) !== (row.turn === null))
    throw new Error("Session identity and turn must be paired");
  if (row.outcome === "unrun") {
    if (
      row.route !== "unrun" ||
      row.candidateId !== null ||
      row.responseSha256 !== null ||
      row.predictedSuccess !== null ||
      row.decisionLatencyMs !== null ||
      row.decisionCostUsd !== null ||
      row.executionCostUsd !== null ||
      row.decisionAttempts !== 0 ||
      row.executionAttempts !== 0
    )
      throw new Error("Unrun evaluation cannot invent physical evidence");
    return;
  }
  if (row.route === "unrun" || (row.route === "no-route") !== (row.candidateId === null))
    throw new Error("Inconsistent evaluation route");
  if (
    row.route === "no-route" &&
    (row.executionAttempts > 0 ||
      row.responseSha256 !== null ||
      row.outcome === "completed" ||
      row.predictedSuccess !== null)
  )
    throw new Error("No-route evaluation cannot invent execution evidence");
  if (row.outcome === "completed" && (!row.responseSha256 || !row.executionAttempts))
    throw new Error("Completed evaluation needs an execution response");
  if (
    (!row.decisionAttempts && row.decisionCostUsd !== 0) ||
    (!row.executionAttempts && row.executionCostUsd !== 0)
  )
    throw new Error("Zero physical attempts must have explicit zero cost");
}
function rate(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}
function spending(rows: Observation[], lane: "decision" | "execution") {
  const attempted = rows.filter((row) =>
    lane === "decision" ? row.decisionAttempts > 0 : row.executionAttempts > 0
  );
  const costs = attempted.map((row) =>
    lane === "decision" ? row.decisionCostUsd : row.executionCostUsd
  );
  const reportedUsd = costs.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const unknownRows = costs.filter((value) => value === null).length;
  return {
    attemptedRows: attempted.length,
    physicalAttempts: attempted.reduce(
      (sum, row) => sum + (lane === "decision" ? row.decisionAttempts : row.executionAttempts),
      0
    ),
    reportedUsd,
    unknownRows,
    totalUsd: unknownRows ? null : reportedUsd,
  };
}
function calibration(pairs: Array<{ row: Observation; label: Label }>, rows: Observation[]) {
  const graded = pairs.filter(
    (pair) => pair.row.predictedSuccess !== null && pair.label.passed !== null
  );
  const bins = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    predicted: 0,
    passed: 0,
  }));
  let squaredError = 0;
  for (const { row, label } of graded) {
    const probability = row.predictedSuccess!;
    const actual = label.passed ? 1 : 0;
    squaredError += (probability - actual) ** 2;
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count++;
    bin.predicted += probability;
    bin.passed += actual;
  }
  const expectedError = bins.reduce((sum, bin) => sum + Math.abs(bin.predicted - bin.passed), 0);
  return {
    target: "task-success" as const,
    gradedForecasts: graded.length,
    suppliedForecasts: rows.filter((row) => row.predictedSuccess !== null).length,
    cohortCoverage: rate(graded.length, rows.length),
    brierScore: rate(squaredError, graded.length),
    expectedCalibrationError: rate(expectedError, graded.length),
    bins: bins.map((bin) => ({
      lower: bin.lower,
      upper: bin.upper,
      count: bin.count,
      meanPredicted: rate(bin.predicted, bin.count),
      passRate: rate(bin.passed, bin.count),
    })),
  };
}
function sessionChurn(rows: Observation[]) {
  const sessions = new Map<string, Observation[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.sessionId !== null) {
      const key = JSON.stringify([row.sessionId, row.turn]);
      if (seen.has(key)) throw new Error("Duplicate evaluation session turn");
      seen.add(key);
    }
    if (row.sessionId === null || row.candidateId === null || row.outcome === "unrun") continue;
    const turns = sessions.get(row.sessionId) ?? [];
    turns.push(row);
    sessions.set(row.sessionId, turns);
  }
  let adjacentTransitions = 0,
    changes = 0;
  for (const turns of sessions.values()) {
    turns.sort((a, b) => a.turn! - b.turn!);
    for (let index = 1; index < turns.length; index++) {
      if (turns[index].turn !== turns[index - 1].turn! + 1) continue;
      adjacentTransitions++;
      if (turns[index].candidateId !== turns[index - 1].candidateId) changes++;
    }
  }
  return { adjacentTransitions, changes, rate: rate(changes, adjacentTransitions) };
}

/** Imported labels are joined AFTER routing; hashes bind identities, not provenance. */
export function summarizeRoutingEvaluation(rawRun: unknown, rawLabels: unknown) {
  const run = runSchema.parse(rawRun),
    labels = labelSchema.parse(rawLabels);
  if (run.suiteSha256 !== labels.suiteSha256) throw new Error("Evaluation suite mismatch");
  const candidates = new Set(run.candidateIds);
  if (candidates.size !== run.candidateIds.length)
    throw new Error("Duplicate evaluation candidate");
  const records = new Map<number, Observation>();
  for (const row of run.records) {
    if (records.has(row.caseId)) throw new Error("Duplicate evaluation case");
    validateObservation(row, candidates);
    records.set(row.caseId, row);
  }
  const seen = new Set<number>();
  const pairs = labels.records.map((label) => {
    const row = records.get(label.caseId);
    if (
      !row ||
      seen.has(label.caseId) ||
      row.inputSha256 !== label.inputSha256 ||
      row.responseSha256 !== label.responseSha256 ||
      label.acceptableCandidateIds?.some((id) => !candidates.has(id))
    )
      throw new Error("Evaluation label identity mismatch");
    const failedExecution =
      row.outcome === "failed" &&
      row.executionAttempts > 0 &&
      row.candidateId !== null &&
      label.passed === false;
    if (label.passed !== null && row.outcome !== "completed" && !failedExecution)
      throw new Error("Task grade requires a completed response or failed execution");
    seen.add(label.caseId);
    return { row, label };
  });
  const graded = pairs.filter((pair) => pair.label.passed !== null);
  const passed = graded.filter((pair) => pair.label.passed).length;
  const labelledRoutes = pairs.filter(
    (pair) => pair.row.candidateId !== null && pair.label.acceptableCandidateIds !== null
  );
  const misroutes = labelledRoutes.filter(
    (pair) => !pair.label.acceptableCandidateIds!.includes(pair.row.candidateId!)
  ).length;
  const routed = run.records.filter((row) => row.candidateId !== null).length;
  const fallbacks = run.records.filter((row) => row.route === "deterministic-fallback").length;
  const latencies = run.records
    .flatMap((row) => (row.decisionLatencyMs === null ? [] : [row.decisionLatencyMs]))
    .sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    latencies.length ? latencies[Math.ceil(fraction * latencies.length) - 1] : null;
  const decision = spending(run.records, "decision"),
    execution = spending(run.records, "execution");
  const reportedUsd = decision.reportedUsd + execution.reportedUsd;
  const unknownRows = run.records.filter(
    (row) =>
      (row.decisionAttempts > 0 && row.decisionCostUsd === null) ||
      (row.executionAttempts > 0 && row.executionCostUsd === null)
  ).length;
  return {
    suiteSha256: run.suiteSha256,
    policySha256: run.policySha256,
    declaredSplit: run.declaredSplit,
    source: run.source,
    independenceVerified: false,
    promotionDecision: null,
    counterfactualSavingsUsd: null,
    outcomes: Object.fromEntries(
      ["completed", "failed", "unknown", "unrun"].map((status) => [
        status,
        run.records.filter((row) => row.outcome === status).length,
      ])
    ),
    taskQuality: {
      graded: graded.length,
      passed,
      passRate: rate(passed, graded.length),
      cohortCoverage: rate(graded.length, run.records.length),
    },
    calibration: calibration(pairs, run.records),
    routing: {
      routed,
      fallbacks,
      fallbackRate: rate(fallbacks, routed),
      labelledRoutes: labelledRoutes.length,
      misroutes,
      misrouteRate: rate(misroutes, labelledRoutes.length),
    },
    decisionLatencyMs: { reported: latencies.length, p50: percentile(0.5), p95: percentile(0.95) },
    spending: {
      decision,
      execution,
      total: {
        physicalAttempts: decision.physicalAttempts + execution.physicalAttempts,
        attemptedRows: run.records.filter((row) => row.decisionAttempts + row.executionAttempts > 0)
          .length,
        reportedUsd,
        unknownRows,
        totalUsd: unknownRows ? null : reportedUsd,
      },
    },
    sessionChurn: sessionChurn(run.records),
    labelSources: Object.fromEntries(
      ["human-review", "executable-check", "synthetic"].map((source) => [
        source,
        labels.records.filter((label) => label.source === source).length,
      ])
    ),
  };
}

async function inputFile(path: string) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const data = chunk as Buffer;
    bytes += data.byteLength;
    if (bytes > 20000000) throw new Error("Evaluation artifact exceeds byte bound");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runPath, labelsPath] = process.argv.slice(2);
  if (!runPath || !labelsPath)
    throw new Error("Usage: decisionPolicyMetrics.ts run.json labels.json");
  const result = summarizeRoutingEvaluation(await inputFile(runPath), await inputFile(labelsPath));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
