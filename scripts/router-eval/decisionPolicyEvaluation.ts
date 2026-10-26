/** Offline preparation/conformance only. No credentials, transport, model calls or quality grades. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  policySchema,
  type PolicyConfig,
  type Trace,
} from "../../open-sse/services/decisionPolicy/contract.ts";
import { eligibleCandidates } from "../../open-sse/services/decisionPolicy/eligibility.ts";
import { nativeDecisionClient } from "../../open-sse/services/decisionPolicy/nativeSelector.ts";
import {
  boundedJson,
  extractRequestFacts,
} from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { runDecisionPolicy } from "../../open-sse/services/decisionPolicy/run.ts";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const object = z.record(z.string(), z.unknown());
const identity = z.number().int().min(1).max(100);
const evidenceLimits = {
  qualityMeasured: false,
  liveCompatibilityMeasured: false,
  locallyExecutedPhysicalAttempts: 0,
  fullRubricScore: null,
  promotionDecision: null,
} as const;
export const sourceSuites = {
  "gravewire-3.0-dev-v1": {
    sourceSuiteSha256: "15776b2dcfe9b365f5a475a77f687d3bdbfd8128b5942711c7c9928c7c6359a0",
    first: 1,
    count: 70,
    split: "development",
  },
  "gravewire-postdesign-synthetic-30-v1": {
    sourceSuiteSha256: "f568af2e670b58ba93db234f4827464ae0cdc1b5c47a75222e9ec19b5f84ff81",
    first: 71,
    count: 30,
    split: "postdesign_synthetic_unblinded",
  },
} as const;
const suiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteId: z.enum(["gravewire-3.0-dev-v1", "gravewire-postdesign-synthetic-30-v1"]),
    sourceSuiteSha256: sha,
    cases: z.array(z.object({ caseId: identity, payload: object }).strict()).max(100),
  })
  .strict();
const message = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z
      .union([z.string().max(200000), object])
      .nullable()
      .optional(),
    name: z.string().max(100).optional(),
    tool_call_id: z.string().max(200).optional(),
    tool_calls: z.array(z.unknown()).max(32).optional(),
  })
  .strict();
const control = z
  .object({
    max_tokens: z.number().int().positive().max(1000000).optional(),
    max_completion_tokens: z.number().int().positive().max(1000000).optional(),
    reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
  })
  .strict();

/** Canonical JSON hashes are identities, not authentication or proof of original authorship. */
export function digest(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry !== null && typeof entry === "object")
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)])
      );
    return entry;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
async function implementationIdentity() {
  const paths = [
    "contract.ts",
    "requestFacts.ts",
    "taskDifficulty.ts",
    "eligibility.ts",
    "run.ts",
    "nativeSelector.ts",
  ];
  const productionSeamSha256 = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(
            await readFile(
              new URL(`../../open-sse/services/decisionPolicy/${path}`, import.meta.url)
            )
          )
          .digest("hex"),
      ])
    )
  );
  return {
    productionSeamSha256,
    runnerSha256: createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex"),
  };
}
export async function original23Policy(): Promise<PolicyConfig> {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../tests/fixtures/decisionPolicy/original23-evaluation.json", import.meta.url),
      "utf8"
    )
  );
  const candidates = fixture.profiles.map(
    (row: { id: string; provider: string; model: string; effort: string; fixed: boolean }) => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      endpointKind: "direct",
      evidence: "SYNTHETIC original23 offline profile; live capability/entitlement unknown",
      capabilities: { ...fixture.syntheticCapabilities },
      effort: {
        mode: row.fixed ? "fixed" : "set",
        value: row.effort,
        supported: [row.effort],
        evidence: "Synthetic exact original effort declaration",
      },
    })
  );
  const order = candidates.map((row: { id: string }) => row.id);
  return policySchema.parse({
    version: 1,
    candidates,
    // Synthetic deterministic control, preserving user order; never a learned difficulty policy.
    taskOrder: Object.fromEntries(
      [
        "explanation",
        "complex_code",
        "reasoning",
        "long_context",
        "image",
        "tools",
        "continuation",
      ].map((task) => [task, order])
    ),
    unknownQuota: "reject",
    decisionFailure: "stop",
    maxDecisionAttempts: 1,
    maxExecutionAttempts: 1,
    timeoutMs: 1000,
  });
}

function payloadInput(raw: Record<string, unknown>) {
  if (!boundedJson(raw)) throw new Error("Invalid bounded rendered payload");
  // Only these explicit model-facing fields survive. Unknown evaluator metadata is never copied.
  const messages = z.array(message).min(1).max(128).parse(raw.messages);
  const controls = control.parse(
    Object.fromEntries(
      Object.keys(control.shape)
        .filter((key) => Object.hasOwn(raw, key))
        .map((key) => [key, raw[key]])
    )
  );
  const attachments = z
    .array(object)
    .max(8)
    .parse(raw.attachments ?? []);
  const tools = z
    .array(object)
    .max(64)
    .parse(raw.tools ?? []);
  let unsupported: string | null =
    tools.length || messages.some((row) => row.role === "tool" || row.tool_calls?.length)
      ? "tool_or_continuation_unrun"
      : null;
  if (
    [
      "temperature",
      "top_p",
      "top_k",
      "reasoning",
      "max_output_tokens",
      "tool_choice",
      "stream",
      "stream_options",
      "parallel_tool_calls",
    ].some((key) => Object.hasOwn(raw, key))
  )
    unsupported = "unsupported_control_unrun";
  if (
    messages.some(
      (row) => row.content !== null && row.content !== undefined && typeof row.content !== "string"
    )
  )
    unsupported = "non_text_transcript_unrun";
  const projected = messages.map((row) => ({
    ...structuredClone(row),
    content: row.content ?? null,
  }));
  for (const attachment of attachments) {
    if (
      attachment.encoding !== "utf-8" ||
      !["text/plain", "text/markdown"].includes(String(attachment.media_type))
    ) {
      const encoded = z.string().max(200000).parse(attachment.content_base64);
      const bytes = Buffer.from(encoded, "base64");
      if (
        bytes.toString("base64") !== encoded ||
        attachment.bytes !== bytes.length ||
        attachment.sha256 !== createHash("sha256").update(bytes).digest("hex")
      )
        throw new Error("Attachment bytes/hash mismatch");
      unsupported = "image_or_binary_attachment_unrun";
      continue;
    }
    const content = z.string().max(200000).parse(attachment.content);
    const bytes = Buffer.from(content, "utf8");
    if (
      attachment.bytes !== bytes.length ||
      attachment.sha256 !== createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("Attachment bytes/hash mismatch");
    const last = projected.findLast((row) => row.role === "user");
    if (!last) throw new Error("Attachment has no user message");
    if (last.content === null || typeof last.content === "string")
      last.content = (last.content ?? "") + "\n\n" + content;
    else unsupported = "non_text_transcript_unrun";
  }
  // This is an explicit synthetic context reservation, never a real provider ceiling.
  const body = {
    model: "synthetic-evaluation-only",
    messages: projected,
    ...controls,
    ...(controls.max_tokens === undefined && controls.max_completion_tokens === undefined
      ? { max_completion_tokens: 64 }
      : {}),
  };
  return { body, unsupported };
}
export async function prepareEvaluation(raw: unknown) {
  const suite = suiteSchema.parse(raw);
  const source = sourceSuites[suite.suiteId];
  if (suite.sourceSuiteSha256 !== source.sourceSuiteSha256)
    throw new Error("Frozen source suite hash mismatch");
  const expected = Array.from({ length: source.count }, (_, index) => index + source.first);
  const ids = suite.cases.map((row) => row.caseId).sort((a, b) => a - b);
  if (JSON.stringify(ids) !== JSON.stringify(expected))
    throw new Error("Missing/duplicate/out-of-suite cases");
  const policy = await original23Policy();
  const policySha256 = digest(policy);
  const rows = suite.cases
    .map(({ caseId, payload }) => {
      if (payload.case_id !== caseId || payload.suite_id !== suite.suiteId)
        throw new Error("Rendered case identity mismatch");
      const input = payloadInput(payload);
      // Fixed synthetic context estimate. No target labels or observed model performance enter it.
      const extracted = input.unsupported
        ? null
        : extractRequestFacts(input.body, {
            measureContext: (body) => Math.ceil(JSON.stringify(body.messages).length / 4),
          });
      const trace: Trace[] = [];
      const snapshot = Object.fromEntries(
        policy.candidates.map((row) => [
          row.id,
          { authorized: true, available: true, quota: "available" as const },
        ])
      );
      const eligible = extracted?.ok
        ? eligibleCandidates(policy, extracted.facts, snapshot, trace)
        : [];
      return {
        caseId,
        inputSha256: digest({
          body: input.body,
          tools: payload.tools ?? [],
          attachments: payload.attachments ?? [],
        }),
        modelInput: input.unsupported ? null : input.body,
        status:
          input.unsupported ??
          (extracted?.ok
            ? eligible.length
              ? "prepared_unrun"
              : "no_route"
            : "request_contract_unrun"),
        facts: extracted?.ok ? extracted.facts : null,
        eligibleIds: eligible.map((row) => row.id),
        trace,
        ...evidenceLimits,
      };
    })
    .sort((a, b) => a.caseId - b.caseId);
  const prepared = {
    schemaVersion: 1 as const,
    suiteId: suite.suiteId,
    sourceSuiteSha256: source.sourceSuiteSha256,
    suiteSha256: digest(suite),
    policySha256,
    split: source.split,
    independent: false,
    blinded: false,
    authorExposed: true,
    ...(await implementationIdentity()),
    contextMeasure: "synthetic-json-characters-divided-by-four; not a provider tokenizer",
    ...evidenceLimits,
    rows,
  };
  return { ...prepared, preparedSha256: digest(prepared) };
}
export type PreparedEvaluation = Awaited<ReturnType<typeof prepareEvaluation>>;

function validatePrepared(prepared: PreparedEvaluation): void {
  const { preparedSha256, ...content } = prepared;
  if (digest(content) !== preparedSha256) throw new Error("Prepared artifact hash mismatch");
}

/** Injected local choices/executions only. Success means synthetic contract success, never inference. */
export async function syntheticConformance(prepared: PreparedEvaluation, choiceId?: string) {
  validatePrepared(prepared);
  const implementation = await implementationIdentity();
  if (
    digest(implementation.productionSeamSha256) !== digest(prepared.productionSeamSha256) ||
    implementation.runnerSha256 !== prepared.runnerSha256
  )
    throw new Error("Prepared implementation identity mismatch");
  const policy = await original23Policy();
  if (digest(policy) !== prepared.policySha256) throw new Error("Prepared policy hash mismatch");
  const rows = [];
  for (const row of prepared.rows) {
    if (row.status !== "prepared_unrun" || !row.facts) {
      rows.push({ caseId: row.caseId, status: row.status, result: null });
      continue;
    }
    const snapshot = Object.fromEntries(
      policy.candidates.map((candidate) => [
        candidate.id,
        { authorized: true, available: true, quota: "available" as const },
      ])
    );
    const decisionClients =
      choiceId === undefined
        ? []
        : [
            nativeDecisionClient({
              id: "synthetic-local-choice",
              model: "synthetic-native-choice",
              call: async (body) => {
                const questions = body.questions as { route: { criteria: Record<string, string> } };
                const ids = Object.keys(questions.route.criteria);
                return {
                  status: 200,
                  body: {
                    answers: {
                      route: {
                        type: "choice",
                        choice: choiceId,
                        confidence: 1,
                        probabilities: Object.fromEntries(
                          ids.map((id) => [id, id === choiceId ? 1 : 0])
                        ),
                      },
                    },
                  },
                };
              },
            }),
          ];
    const result = await runDecisionPolicy(policy, row.facts, {
      snapshot: async () => snapshot,
      decisionClients,
      execute: async (candidate) => ({
        status: "success",
        committed: false,
        costUsd: null,
        actual: {
          provider: candidate.provider,
          model: candidate.model,
          effort: candidate.effort.value,
        },
      }),
    });
    rows.push({ caseId: row.caseId, status: "synthetic_policy_conformance_only", result });
  }
  return {
    suiteSha256: prepared.suiteSha256,
    policySha256: prepared.policySha256,
    selector: choiceId === undefined ? "deterministic_synthetic_order" : "synthetic_native_choice",
    ...evidenceLimits,
    rows,
  };
}

const resultSchema = z
  .object({
    arm: z.enum(["baseline", "candidate"]),
    caseId: identity,
    inputSha256: sha,
    policySha256: sha,
    outcome: z.enum(["unrun", "unknown", "failed", "completed"]),
    source: z.enum(["not_run", "externally_supplied_unverified"]),
    responseSha256: sha.nullable(),
    physicalAttempts: z.number().int().min(0).max(5),
    decisionCostUsd: z.number().finite().min(0).nullable(),
    executionCostUsd: z.number().finite().min(0).nullable(),
  })
  .strict();
const pairedSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteSha256: sha,
    arms: z.object({ baseline: sha, candidate: sha }).strict(),
    records: z.array(resultSchema).max(200),
  })
  .strict();
/** Identity/coverage validation only: no author grades, blended score or promotion verdict. */
export function validatePairedResults(prepared: PreparedEvaluation, raw: unknown) {
  validatePrepared(prepared);
  const paired = pairedSchema.parse(raw);
  if (paired.suiteSha256 !== prepared.suiteSha256) throw new Error("Paired suite mismatch");
  if (paired.arms.baseline !== prepared.policySha256)
    throw new Error("Frozen baseline policy mismatch");
  if (paired.records.length !== prepared.rows.length * 2)
    throw new Error("Incomplete paired cohort");
  const seen = new Set<string>();
  for (const record of paired.records) {
    const identity = `${record.arm}:${record.caseId}`;
    const expected = prepared.rows.find((row) => row.caseId === record.caseId);
    if (
      !expected ||
      seen.has(identity) ||
      expected.inputSha256 !== record.inputSha256 ||
      paired.arms[record.arm] !== record.policySha256
    )
      throw new Error("Duplicate/mismatched pair identity");
    seen.add(identity);
    if (record.outcome === "unrun") {
      if (
        record.source !== "not_run" ||
        record.physicalAttempts !== 0 ||
        record.responseSha256 !== null ||
        record.decisionCostUsd !== null ||
        record.executionCostUsd !== null
      )
        throw new Error("Unrun result cannot invent attempts, response or cost");
    } else if (
      record.source !== "externally_supplied_unverified" ||
      record.physicalAttempts < 1 ||
      (record.outcome === "completed") !== (record.responseSha256 !== null)
    )
      throw new Error("Outcome evidence inconsistent");
  }
  return {
    records: paired.records.length,
    ...evidenceLimits,
    externallyReportedUnverifiedPhysicalAttempts: paired.records.reduce(
      (sum, row) => sum + row.physicalAttempts,
      0
    ),
    outcomeCounts: Object.fromEntries(
      ["unrun", "unknown", "failed", "completed"].map((outcome) => [
        outcome,
        paired.records.filter((row) => row.outcome === outcome).length,
      ])
    ),
    notice:
      "Paired schema validated only; external results are unverified, no model quality or promotion measured.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, command = "prepare"] = process.argv.slice(2);
  if (!file || !["prepare", "synthetic"].includes(command))
    throw new Error("Usage: decisionPolicyEvaluation.ts rendered-suite.json [prepare|synthetic]");
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 20000000) throw new Error("Evaluation input too large");
  const prepared = await prepareEvaluation(JSON.parse(text));
  process.stdout.write(
    JSON.stringify(
      command === "prepare" ? prepared : await syntheticConformance(prepared),
      null,
      2
    ) + "\n"
  );
}
