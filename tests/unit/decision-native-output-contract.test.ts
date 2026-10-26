import { inspectToolRequest } from "../../open-sse/services/decisionPolicy/toolContract.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDecisionTextRequest,
  extractRequestFacts,
} from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import {
  boundedDecisionConfigurationSchema,
  decisionPolicyEditorSchema,
} from "../../src/shared/decisionPolicy/configuration.ts";
import { boundedDecisionEnabled } from "../../open-sse/services/decisionPolicy/applicationGate.ts";

const input = () => ({
  model: "synthetic-native-output-combo",
  messages: [{ role: "user", content: "Explain the synthetic state." }],
  stream: true,
  reasoning_effort: "max",
});
const planning = { contextOutputTokens: 64 };
const bounded = () => ({
  enabled: true,
  applicationMode: "bounded-v1",
  policy: {
    version: 1,
    candidates: [],
    taskOrder: {},
    unknownQuota: "reject",
    decisionFailure: "stop",
    maxDecisionAttempts: 0,
    maxExecutionAttempts: 1,
    timeoutMs: 1000,
  },
  connections: {},
});
const native = () => ({
  ...bounded(),
  applicationMode: "provider-native-output-v1",
  nativeOutput: { acknowledgeNoTokenCeiling: true, ...planning },
});

test("bounded defaults do not acquire a provider-native output policy", () => {
  const parsed = boundedDecisionConfigurationSchema.parse(bounded());
  assert.equal(parsed.applicationMode, "bounded-v1");
  assert.equal(parsed.nativeOutput, undefined);
  assert.equal(normalizeDecisionTextRequest(input()), null);
  assert.ok(normalizeDecisionTextRequest({ ...input(), max_tokens: 64 }));
});
test("native mode requires explicit stored acknowledgement and a planning allowance", () => {
  assert.ok(boundedDecisionConfigurationSchema.safeParse(native()).success);
  const { nativeOutput: _omitted, ...withoutAcknowledgement } = native();
  assert.equal(boundedDecisionConfigurationSchema.safeParse(withoutAcknowledgement).success, false);
  assert.equal(
    boundedDecisionConfigurationSchema.safeParse({
      ...native(),
      nativeOutput: { ...planning, acknowledgeNoTokenCeiling: false },
    }).success,
    false
  );
  assert.equal(
    boundedDecisionConfigurationSchema.safeParse({
      ...bounded(),
      nativeOutput: native().nativeOutput,
    }).success,
    false
  );
});
test("disabled native draft remains inactive and retains the same strict acknowledgement", () => {
  const draft = { ...native(), enabled: false };
  assert.ok(decisionPolicyEditorSchema.safeParse(draft).success);
  assert.equal(boundedDecisionEnabled({ config: { decisionPolicy: draft } }), false);
  assert.equal(
    decisionPolicyEditorSchema.safeParse({ ...draft, nativeOutput: undefined }).success,
    false
  );
});
for (const value of [0, -1, 1.5, "64", null, NaN, Infinity, 1000001]) {
  test(`invalid planning allowance ${String(value)} cannot activate native mode`, () => {
    assert.equal(
      boundedDecisionConfigurationSchema.safeParse({
        ...native(),
        nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: value },
      }).success,
      false
    );
    assert.equal(
      normalizeDecisionTextRequest(input(), { contextOutputTokens: value as number }),
      null
    );
  });
}
test("native canonical planning metadata never mutates the caller or claims a ceiling", () => {
  const raw = input();
  const before = JSON.stringify(raw);
  const facts = extractRequestFacts(raw, { measureContext: () => 100, nativeOutput: planning });
  assert.equal(facts.ok, true);
  assert.equal(JSON.stringify(raw), before);
  if (!facts.ok) return;
  assert.equal(facts.body.max_completion_tokens, 64);
  assert.equal(facts.facts.clientEffort, "max");
  assert.equal(facts.facts.contextTokens, 164);
  const state = JSON.parse(facts.facts.state);
  assert.equal(state.extractor, "provider-native-output-v1");
  assert.equal(state.reservedOutputTokens, null);
  assert.equal(state.contextOutputTokens, 64);
  assert.equal(state.providerEnforcedOutputLimit, false);
});
for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
  test(`native mode rejects explicit ${field} even when equal to the planning allowance`, () => {
    const raw = { ...input(), [field]: 64 };
    assert.equal(normalizeDecisionTextRequest(raw, planning), null);
    assert.equal(Object.hasOwn(raw, field), true);
  });
}
for (const extra of [
  { stream: false },
  { applicationMode: "provider-native-output-v1" },
  { nativeOutput: { acknowledgeNoTokenCeiling: true, ...planning } },
  { temperature: 0 },
  { tool_choice: "none" },
  { parallel_tool_calls: false },
]) {
  test(`unsupported native client control ${Object.keys(extra).join(",")} fails closed`, () => {
    assert.equal(normalizeDecisionTextRequest({ ...input(), ...extra }, planning), null);
  });
}

test("native flat function declarations enter the guarded tool contract without a caller cap", () => {
  const raw = {
    ...input(),
    tools: [{ type: "function", function: { name: "synthetic", parameters: { type: "object" } } }],
    tool_choice: "auto",
    parallel_tool_calls: false,
  };
  const normalized = normalizeDecisionTextRequest(raw, planning);
  assert.ok(normalized);
  assert.equal(normalized.max_completion_tokens, planning.contextOutputTokens);
  const inspected = inspectToolRequest(raw, planning);
  assert.ok(inspected);
  assert.deepEqual(inspected.body.tools, raw.tools);
  assert.equal(Object.hasOwn(raw, "max_tokens"), false);
  assert.equal(Object.hasOwn(raw, "max_completion_tokens"), false);
});
