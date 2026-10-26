import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  digest,
  original23Policy,
  prepareEvaluation,
  sourceSuites,
  syntheticConformance,
  validatePairedResults,
} from "../../scripts/router-eval/decisionPolicyEvaluation.ts";

const suiteId = "gravewire-postdesign-synthetic-30-v1";
function corpus() {
  return {
    schemaVersion: 1,
    suiteId,
    sourceSuiteSha256: sourceSuites[suiteId].sourceSuiteSha256,
    cases: Array.from({ length: 30 }, (_, i) => ({
      caseId: i + 71,
      payload: {
        suite_id: suiteId,
        case_id: i + 71,
        messages: [{ role: "user", content: `Explain synthetic request ${i}.` }],
        attachments: [],
        tools: [],
        category: "EVALUATOR_ONLY_CATEGORY",
        effort_target: "EVALUATOR_ONLY_TARGET",
        expected: "EVALUATOR_ONLY_ANSWER",
        acceptance_checks: ["EVALUATOR_ONLY_CHECK"],
        historical_candidates: ["EVALUATOR_ONLY_RANK"],
        title: "EVALUATOR_ONLY_TITLE",
      },
    })),
  };
}
type Prepared = Awaited<ReturnType<typeof prepareEvaluation>>;
function pairs(prepared: Prepared) {
  return {
    schemaVersion: 1,
    suiteSha256: prepared.suiteSha256,
    arms: { baseline: prepared.policySha256, candidate: "a".repeat(64) },
    records: (["baseline", "candidate"] as const).flatMap((arm) =>
      prepared.rows.map((row) => ({
        arm,
        caseId: row.caseId,
        inputSha256: row.inputSha256,
        policySha256: arm === "baseline" ? prepared.policySha256 : "a".repeat(64),
        outcome: "unrun",
        source: "not_run",
        responseSha256: null,
        physicalAttempts: 0,
        decisionCostUsd: null,
        executionCostUsd: null,
      }))
    ),
  };
}
test("frozen original23 identities, preference order and fixed effort flags survive without intelligence scores", async () => {
  const file = JSON.parse(
    await readFile(
      new URL("../fixtures/decisionPolicy/original23-evaluation.json", import.meta.url),
      "utf8"
    )
  );
  const historical = [
    "agy/claude-opus-4-6-thinking",
    "cc/claude-haiku-5-5-medium",
    "cx/gpt-6-luna-max",
    "cc/claude-haiku-5-5-high",
    "cx/gpt-5.6-sol-medium",
    "cx/gpt-6-sol-medium",
    "cc/claude-sonnet-5-5-medium",
    "agy/gemini-3.8-flash-high",
    "cc/claude-haiku-5-5-xhigh",
    "cx/gpt-5.6-sol-high",
    "cx/gpt-6-sol-high",
    "cc/claude-haiku-5-5-max",
    "cx/gpt-5.6-sol-xhigh",
    "cx/gpt-6-sol-xhigh",
    "cc/claude-sonnet-5-5-high",
    "cx/gpt-5.6-sol-max",
    "cx/gpt-6-sol-max",
    "cc/claude-opus-5-5-medium",
    "cc/claude-sonnet-5-5-xhigh",
    "cc/claude-opus-5-5-high",
    "cc/claude-opus-5-5-xhigh",
    "cc/claude-sonnet-5-5-max",
    "cc/claude-opus-5-5-max",
  ];
  assert.deepEqual(
    file.profiles.map((row: { historicalId: string }) => row.historicalId),
    historical
  );
  assert.equal(
    file.sourceSha256,
    "94ede7d46a28347417694ddee3cf8086117c7bf42a2c366e9bda1a763b2e7f27"
  );
  assert.equal(file.liveCapabilities, "unknown");
  assert.equal(JSON.stringify(file).includes('"intelligence"'), false);
  const policy = await original23Policy();
  assert.equal(policy.candidates.length, 23);
  assert.deepEqual(
    policy.candidates
      .map((row, index) => (row.effort.mode === "fixed" ? index + 1 : null))
      .filter(Boolean),
    [1, 3, 8]
  );
  assert.equal(policy.candidates[2].model, "gpt-6-luna");
  assert.equal(policy.candidates[2].effort.value, "max");
  assert.ok(policy.candidates.every((row) => row.evidence?.includes("SYNTHETIC")));
});
test("prepare defaults to zero calls/unknown quality and separates every evaluator-only label", async () => {
  const result = await prepareEvaluation(corpus());
  assert.equal(result.qualityMeasured, false);
  assert.equal(result.locallyExecutedPhysicalAttempts, 0);
  assert.equal(result.split, "postdesign_synthetic_unblinded");
  assert.equal(result.blinded, false);
  assert.equal(result.independent, false);
  assert.equal(result.authorExposed, true);
  assert.equal(JSON.stringify(result).includes("EVALUATOR_ONLY"), false);
  assert.equal(result.rows.length, 30);
  assert.ok(
    result.rows.every((row) => row.eligibleIds.length === 23 && row.status === "prepared_unrun")
  );
  const changed = corpus();
  changed.cases[0].payload.category = "OTHER_EVALUATOR";
  const next = await prepareEvaluation(changed);
  assert.equal(result.rows[0].inputSha256, next.rows[0].inputSha256);
  assert.notEqual(result.suiteSha256, next.suiteSha256);
});
test("user literal category/effort text remains unchanged; nested unknown message fields reject", async () => {
  const suite = corpus();
  suite.cases[0].payload.messages[0].content = "Explain literal category=high, effort_target=low.";
  assert.equal(
    (await prepareEvaluation(suite)).rows[0].modelInput?.messages[0].content,
    suite.cases[0].payload.messages[0].content
  );
  Object.assign(suite.cases[0].payload.messages[0], { expected: "private oracle" });
  await assert.rejects(prepareEvaluation(suite));
});
for (const fault of ["hash", "id", "boolean", "duplicate", "missing", "extra", "nestedIdentity"])
  test(`suite identity/cohort rejects ${fault}`, async () => {
    const suite = corpus();
    if (fault === "hash")
      suite.sourceSuiteSha256 = "0".repeat(64) as typeof suite.sourceSuiteSha256;
    if (fault === "id") suite.cases[0].caseId = 1;
    if (fault === "boolean") Object.assign(suite.cases[0], { caseId: true });
    if (fault === "duplicate") suite.cases[1] = suite.cases[0];
    if (fault === "missing") suite.cases.pop();
    if (fault === "extra") suite.cases.push(suite.cases[0]);
    if (fault === "nestedIdentity") suite.cases[0].payload.case_id = 72;
    await assert.rejects(prepareEvaluation(suite));
  });
test("development70 exact source cohort remains separate from postdesign30", async () => {
  const id = "gravewire-3.0-dev-v1";
  const suite = corpus();
  const result = await prepareEvaluation({
    ...suite,
    suiteId: id,
    sourceSuiteSha256: sourceSuites[id].sourceSuiteSha256,
    cases: Array.from({ length: 70 }, (_, i) => ({
      caseId: i + 1,
      payload: { ...suite.cases[0].payload, suite_id: id, case_id: i + 1 },
    })),
  });
  assert.equal(result.rows.length, 70);
  assert.equal(result.split, "development");
  assert.notEqual(result.suiteSha256, (await prepareEvaluation(suite)).suiteSha256);
});
test("unsupported tools, continuations and images remain explicitly unrun without exposing partial selector inputs", async () => {
  const suite = corpus();
  Object.assign(suite.cases[0].payload, {
    tools: [{ name: "read_file", parameters: { type: "object" } }],
  });
  Object.assign(suite.cases[1].payload, {
    messages: [{ role: "tool", content: "Supplied transcript only", tool_call_id: "synthetic" }],
  });
  const content = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  Object.assign(suite.cases[2].payload, {
    attachments: [
      {
        encoding: "base64",
        media_type: "image/svg+xml",
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        content_base64: content.toString("base64"),
      },
    ],
  });
  const result = await prepareEvaluation(suite);
  for (const row of result.rows.slice(0, 3)) {
    assert.match(row.status, /unrun$/);
    assert.equal(row.modelInput, null);
    assert.equal(row.facts, null);
    assert.deepEqual(row.eligibleIds, []);
  }
  const synthetic = await syntheticConformance(result);
  assert.ok(synthetic.rows.slice(0, 3).every((row) => row.result === null));
});
test("actual text attachments are verified, consumed by extractor, and never mistaken for real token counts", async () => {
  const suite = corpus();
  const content = "Synthetic context. ".repeat(5000);
  Object.assign(suite.cases[0].payload, {
    attachments: [
      {
        encoding: "utf-8",
        media_type: "text/plain",
        content,
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  });
  const result = await prepareEvaluation(suite);
  assert.ok(String(result.rows[0].modelInput?.messages[0].content).includes(content));
  assert.match(result.contextMeasure, /not a provider tokenizer/);
  Object.assign(suite.cases[0].payload.attachments, [
    { encoding: "utf-8", media_type: "text/plain", content, bytes: 1, sha256: "0".repeat(64) },
  ]);
  await assert.rejects(prepareEvaluation(suite));
});
test("historical supplied tool-result objects remain unrun rather than crashing the whole cohort", async () => {
  const suite = corpus();
  Object.assign(suite.cases[0].payload, {
    messages: [
      { role: "user", content: "Read the synthetic file." },
      {
        role: "assistant",
        tool_calls: [{ name: "read_file", arguments: { path: "synthetic.txt" } }],
      },
      { role: "tool", name: "read_file", content: { error: "permission_denied" } },
    ],
  });
  const result = await prepareEvaluation(suite);
  assert.equal(result.rows.length, 30);
  assert.equal(result.rows[0].status, "non_text_transcript_unrun");
  assert.equal(result.rows[0].modelInput, null);
  assert.equal(result.rows[0].facts, null);
});
test("production extractor respects explicit effort and zero eligible remains a no-route", async () => {
  const suite = corpus();
  Object.assign(suite.cases[0].payload, { reasoning_effort: "none" });
  const result = await prepareEvaluation(suite);
  assert.equal(result.rows[0].facts?.clientEffort, "none");
  assert.equal(result.rows[0].status, "no_route");
  assert.deepEqual(result.rows[0].eligibleIds, []);
  assert.equal((await syntheticConformance(result)).rows[0].result, null);
});
test("synthetic native choice uses actual adapter/policy and can select original last pair with unknown costs", async () => {
  const prepared = await prepareEvaluation(corpus());
  const policy = await original23Policy();
  const selected = policy.candidates.at(-1)!;
  const report = await syntheticConformance(prepared, selected.id);
  assert.equal(report.locallyExecutedPhysicalAttempts, 0);
  assert.equal(report.qualityMeasured, false);
  for (const row of report.rows) {
    assert.equal(row.result?.selectedId, selected.id);
    assert.equal(row.result?.costs.total.totalUsd, null);
    assert.equal(row.result?.ledger.length, 2);
    assert.equal(row.result?.status, "success");
  }
  const invalid = await syntheticConformance(prepared, "not-offered");
  assert.ok(
    invalid.rows.every(
      (row) => row.result?.status === "decision_stopped" && row.result.ledger.length === 1
    )
  );
  const deterministic = await syntheticConformance(prepared);
  assert.ok(
    deterministic.rows.every(
      (row) => row.result?.selectedId === policy.candidates[0].id && row.result.ledger.length === 1
    )
  );
});
test("paired schema accepts complete unrun arms with unknown cost, never promotion or author quality grades", async () => {
  const prepared = await prepareEvaluation(corpus());
  const report = validatePairedResults(prepared, pairs(prepared));
  assert.equal(report.records, 60);
  assert.equal(report.qualityMeasured, false);
  assert.equal(report.promotionDecision, null);
});
for (const fault of [
  "missing",
  "duplicate",
  "suite",
  "case",
  "input",
  "policy",
  "fakeFree",
  "fakeSuccess",
  "grade",
])
  test(`paired schema rejects ${fault}`, async () => {
    const prepared = await prepareEvaluation(corpus());
    const paired = pairs(prepared);
    if (fault === "missing") paired.records.pop();
    if (fault === "duplicate") paired.records[1] = paired.records[0];
    if (fault === "suite") paired.suiteSha256 = "0".repeat(64);
    if (fault === "case") paired.records[0].caseId = 1;
    if (fault === "input") paired.records[0].inputSha256 = "0".repeat(64);
    if (fault === "policy") paired.records[0].policySha256 = "0".repeat(64);
    if (fault === "fakeFree") Object.assign(paired.records[0], { executionCostUsd: 0 });
    if (fault === "fakeSuccess") Object.assign(paired.records[0], { outcome: "completed" });
    if (fault === "grade") Object.assign(paired.records[0], { qualityScore: 100 });
    assert.throws(() => validatePairedResults(prepared, paired));
  });
test("unknown versus failed external outcomes stay distinct and unknown costs remain acceptable", async () => {
  const prepared = await prepareEvaluation(corpus());
  const paired = pairs(prepared);
  Object.assign(paired.records[0], {
    outcome: "unknown",
    source: "externally_supplied_unverified",
    physicalAttempts: 1,
  });
  Object.assign(paired.records[30], {
    outcome: "failed",
    source: "externally_supplied_unverified",
    physicalAttempts: 1,
    decisionCostUsd: 0,
  });
  const result = validatePairedResults(prepared, paired);
  assert.equal(result.records, 60);
  assert.equal(result.locallyExecutedPhysicalAttempts, 0);
  assert.equal(result.externallyReportedUnverifiedPhysicalAttempts, 2);
  assert.deepEqual(result.outcomeCounts, { unrun: 58, unknown: 1, failed: 1, completed: 0 });
  Object.assign(paired.records[0], { executionCostUsd: -1 });
  assert.throws(() => validatePairedResults(prepared, paired));
});
test("canonical hashes ignore property order but preserve case and array identities", () => {
  assert.equal(digest({ x: 1, y: 2 }), digest({ y: 2, x: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});
test("coordinated baseline arm and record policy substitution cannot replace the frozen control", async () => {
  const prepared = await prepareEvaluation(corpus());
  const paired = pairs(prepared);
  paired.arms.baseline = "b".repeat(64);
  for (const row of paired.records)
    if (row.arm === "baseline") row.policySha256 = paired.arms.baseline;
  assert.throws(() => validatePairedResults(prepared, paired), /Frozen baseline/);
});
test("prepared facts/input provenance cannot be silently mutated after label separation", async () => {
  const prepared = await prepareEvaluation(corpus());
  prepared.rows[0].facts!.state = "Injected evaluator oracle";
  await assert.rejects(syntheticConformance(prepared), /Prepared artifact hash/);
  assert.throws(() => validatePairedResults(prepared, pairs(prepared)), /Prepared artifact hash/);
});
test("unsupported caller controls are unrun rather than silently ignored to manufacture compatibility", async () => {
  for (const field of ["temperature", "reasoning", "max_output_tokens", "stream"]) {
    const suite = corpus();
    Object.assign(suite.cases[0].payload, { [field]: 1 });
    const prepared = await prepareEvaluation(suite);
    assert.equal(prepared.rows[0].status, "unsupported_control_unrun");
    assert.equal(prepared.rows[0].modelInput, null);
  }
});
