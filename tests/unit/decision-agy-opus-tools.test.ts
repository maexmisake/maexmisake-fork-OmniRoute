import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  RawGeminiToolCollector,
  validateGeminiToolParts,
} from "../../src/lib/decisionPolicy/geminiToolResponseProof.ts";
import {
  __clearGeminiToolReplayForTests,
  parseGeminiToolReplayGroup,
  restoreGeminiToolReplay,
  serializeGeminiToolReplay,
  storeGeminiToolReplay,
} from "../../src/lib/decisionPolicy/geminiToolReplay.ts";
import {
  buildGeminiToolWire,
  type GeminiToolJson,
} from "../../src/lib/decisionPolicy/geminiToolWire.ts";
import {
  createGeminiCorrelationNamespace,
  resolveGeminiClientCallId,
} from "../../src/lib/decisionPolicy/geminiToolIdentity.ts";
import {
  canonicalToolJSON,
  inspectToolRequest,
} from "../../open-sse/services/decisionPolicy/toolContract.ts";
import type { ChatPolicyBody } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { ApplicationGeminiTools } from "../../src/lib/decisionPolicy/applicationGeminiTools.ts";
import type { AutomaticPlan } from "../../src/lib/decisionPolicy/applicationCombo.ts";
import {
  withApplicationAttempt,
  type ApplicationAttempt,
  type ApplicationToolHooks,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.ts";

const model = "claude-opus-4-6-thinking";
const gemini = "gemini-3.8-flash-high";
const identity = {
  id: "01234567-89ab-4cde-8f01-23456789abcd",
  keyId: "synthetic-key",
  comboId: "synthetic-combo",
  provider: "agy",
  model,
  connectionId: "synthetic-account",
  effort: "high",
};
const namespace = createGeminiCorrelationNamespace(identity.id);
const project = "synthetic-project";
const names = new Set(["echo"]);
const body: ChatPolicyBody = {
  model: "synthetic-combo",
  stream: true,
  max_completion_tokens: 32,
  reasoning_effort: "high",
  messages: [{ role: "user", content: "Synthetic task" }],
  tools: [
    {
      type: "function",
      function: {
        name: "echo",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    },
  ],
};
const native = { functionCall: { name: "echo", args: { text: "synthetic" } } };
function frame(parts: GeminiToolJson[], finishReason?: string) {
  return {
    response: {
      candidates: [
        { content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) },
      ],
    },
  };
}
beforeEach(__clearGeminiToolReplayForTests);
after(() => {
  __clearGeminiToolReplayForTests();
  resetDbInstance();
});

test("Opus tool strategy requires native-mode acknowledgment and the bound planning allowance", () => {
  const inspected = inspectToolRequest(body);
  assert.ok(inspected);
  const config = {
    applicationMode: "provider-native-output-v1",
    nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 32 },
  };
  const source = { ...identity, candidateId: "historical_01" };
  const strategy = (change: Record<string, unknown> = {}) =>
    new ApplicationGeminiTools(
      { config: { ...config, ...change } } as unknown as AutomaticPlan,
      identity.keyId,
      inspected
    );
  assert.equal(typeof strategy().attach(source, "synthetic-authority").geminiRequest, "function");
  for (const change of [
    { applicationMode: "bounded-v1" },
    { nativeOutput: undefined },
    { nativeOutput: { acknowledgeNoTokenCeiling: false, contextOutputTokens: 32 } },
    { nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 31 } },
  ])
    assert.throws(() => strategy(change).attach(source, "synthetic-authority"));
});

test("exact private Opus response uses its own tool projection before ordinary translation", () => {
  let calls = 0;
  const expected = [{ syntheticPrivateProjection: true }];
  const attempt = {
    provider: "agy",
    model,
    effort: "high",
    executionContract: "agy-opus-fixed-native-output-v1",
    nativeOutput: { contextOutputTokens: 32 },
    signal: new AbortController().signal,
    tools: {
      geminiResponse: () => {
        calls++;
        return expected;
      },
    } as unknown as ApplicationToolHooks,
  } as ApplicationAttempt;
  const state = { toolCalls: new Map(), functionIndex: 0 };
  const result = withApplicationAttempt(attempt, () =>
    geminiToOpenAIResponse(frame([native], "STOP"), state)
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, expected);
});

test("Opus response hook requires the exact private context and respects cancellation", () => {
  let called = 0;
  const base = {
    provider: "agy",
    model,
    effort: "high",
    executionContract: "agy-opus-fixed-native-output-v1",
    nativeOutput: { contextOutputTokens: 32 },
    signal: new AbortController().signal,
    tools: {
      geminiResponse: () => {
        called++;
        return [];
      },
    } as unknown as ApplicationToolHooks,
  } as ApplicationAttempt;
  for (const mutation of [
    { provider: "antigravity" },
    { model: gemini },
    { effort: "medium" },
    { executionContract: undefined },
    { nativeOutput: undefined },
  ]) {
    withApplicationAttempt({ ...base, ...mutation }, () =>
      geminiToOpenAIResponse(frame([{ text: "Synthetic text" }], "STOP"), {
        toolCalls: new Map(),
        functionIndex: 0,
      })
    );
    assert.equal(called, 0);
  }
  const controller = new AbortController();
  controller.abort();
  assert.throws(() =>
    withApplicationAttempt({ ...base, signal: controller.signal }, () =>
      geminiToOpenAIResponse(frame([native], "STOP"), { toolCalls: new Map(), functionIndex: 0 })
    )
  );
  assert.equal(called, 0);
  assert.throws(() =>
    withApplicationAttempt({ ...base, tools: {} as ApplicationToolHooks }, () =>
      geminiToOpenAIResponse(frame([native], "STOP"), { toolCalls: new Map(), functionIndex: 0 })
    )
  );
});
test("fixed Opus text-only projection keeps tool-looking text literal", () => {
  const literal = "[Tool call: synthetic]\nArguments: {}";
  const context = {
    provider: "agy",
    model,
    effort: "high",
    executionContract: "agy-opus-fixed-native-output-v1",
    nativeOutput: { contextOutputTokens: 32 },
    signal: new AbortController().signal,
  } as ApplicationAttempt;
  const rows = withApplicationAttempt(context, () =>
    geminiToOpenAIResponse(frame([{ text: literal }], "STOP"), {
      toolCalls: new Map(),
      functionIndex: 0,
    })
  );
  const deltas = (rows ?? []).flatMap((row) => row.choices?.map((choice) => choice.delta) ?? []);
  assert.equal(deltas.flatMap((delta) => delta.tool_calls ?? []).length, 0);
  assert.equal(deltas.map((delta) => delta.content ?? "").join(""), literal);
});

test("exact Opus complete calls preserve absent signatures without a placeholder", () => {
  const raw = new RawGeminiToolCollector({
    model,
    allowedNames: names,
    allowToolUse: true,
    correlationNamespace: namespace,
    fixedNativeOpus: true,
  });
  const parts = [
    {
      text: "Synthetic thought",
      thought: true,
      thoughtSignature: "synthetic-opaque-text-signature",
    },
    native,
  ];
  raw.accept(frame(parts));
  raw.accept(frame([], "STOP"));
  const proof = raw.finish();
  assert.ok(proof);
  assert.deepEqual(proof.parts, parts);
  assert.equal(proof.parts[1].thoughtSignature, undefined);
  assert.equal(proof.calls[0].nativeId, null);
  assert.equal(proof.calls[0].id, resolveGeminiClientCallId(null, namespace, 0));
});
test("Gemini defaults still require signature and cannot opt into Opus signature behavior", () => {
  assert.throws(() =>
    validateGeminiToolParts([native], names, { correlationNamespace: namespace })
  );
  assert.throws(
    () =>
      new RawGeminiToolCollector({
        model: gemini,
        allowedNames: names,
        allowToolUse: true,
        fixedNativeOpus: true,
      })
  );
  const raw = new RawGeminiToolCollector({
    model: gemini,
    allowedNames: names,
    allowToolUse: true,
    correlationNamespace: namespace,
  });
  assert.throws(() => raw.accept(frame([native])));
});
for (const thoughtSignature of ["", " ", "skip_thought_signature_validator", null]) {
  test(`Opus rejects malformed or bypass signature ${JSON.stringify(thoughtSignature)}`, () => {
    assert.throws(() =>
      validateGeminiToolParts([{ ...native, thoughtSignature }], names, {
        correlationNamespace: namespace,
        fixedNativeOpus: true,
      })
    );
  });
}
test("Opus wire requires explicit exact fixed-native option and contains only native tool controls", () => {
  assert.throws(() => buildGeminiToolWire(body, model, project, new Map()));
  assert.throws(() =>
    buildGeminiToolWire(body, gemini, project, new Map(), undefined, { fixedNativeOpus: true })
  );
  const wire = buildGeminiToolWire(body, model, project, new Map(), undefined, {
    fixedNativeOpus: true,
  });
  const request = wire.request as GeminiToolJson;
  assert.equal(wire.model, model);
  assert.deepEqual(request.generationConfig, { topK: 40, topP: 1 });
  assert.deepEqual(request.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  assert.deepEqual(request.tools, [
    {
      functionDeclarations: [
        { name: "echo", parametersJsonSchema: body.tools![0].function.parameters },
      ],
    },
  ]);
});
test("new Opus replay envelope binds exact owner and cannot become Gemini replay", () => {
  const value = storeGeminiToolReplay(identity, [native], namespace);
  assert.equal(JSON.parse(value)[0].type, "agy-opus-tool-parts-v1");
  assert.equal(restoreGeminiToolReplay(identity), value);
  const group = parseGeminiToolReplayGroup(value, identity);
  assert.equal(group.fixedNativeOpus, true);
  assert.deepEqual(group.parts, [native]);
  for (const key of ["id", "keyId", "comboId", "connectionId", "provider", "model", "effort"]) {
    assert.throws(() => restoreGeminiToolReplay({ ...identity, [key]: "synthetic-other" }));
  }
  assert.throws(() => parseGeminiToolReplayGroup(value, { ...identity, model: gemini }));
  assert.throws(() => serializeGeminiToolReplay([native], namespace));
  assert.throws(() => serializeGeminiToolReplay([native], undefined, true));
  const signed = [{ ...native, thoughtSignature: "synthetic-native-signature" }];
  const geminiValue = serializeGeminiToolReplay(signed, namespace);
  assert.throws(() => parseGeminiToolReplayGroup(geminiValue, identity));
});
test("Opus replay preserves absent/present IDs and signatures and exact result correlation", () => {
  const sourceParts = [
    native,
    {
      functionCall: { id: "native-present", name: "echo", args: { text: "second" } },
      thoughtSignature: "synthetic-second-signature",
    },
  ];
  const firstId = resolveGeminiClientCallId(null, namespace, 0);
  const continuation: ChatPolicyBody = {
    ...body,
    messages: [
      ...body.messages,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: firstId,
            type: "function",
            function: { name: "echo", arguments: '{"text":"synthetic"}' },
          },
          {
            id: "native-present",
            type: "function",
            function: { name: "echo", arguments: '{"text":"second"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: firstId, content: "first result" },
      { role: "tool", tool_call_id: "native-present", content: "second result" },
    ],
  };
  const before = canonicalToolJSON(continuation);
  const wire = buildGeminiToolWire(
    continuation,
    model,
    project,
    new Map([[1, sourceParts]]),
    new Map([[1, namespace]]),
    { fixedNativeOpus: true }
  );
  const request = wire.request as {
    contents: Array<{ role: string; parts: GeminiToolJson[] }>;
    generationConfig: GeminiToolJson;
  };
  assert.deepEqual(request.contents[1].parts, sourceParts);
  assert.deepEqual(request.contents[2].parts, [
    { functionResponse: { name: "echo", response: { output: "first result" } } },
    {
      functionResponse: {
        id: "native-present",
        name: "echo",
        response: { output: "second result" },
      },
    },
  ]);
  assert.deepEqual(request.generationConfig, { topK: 40, topP: 1 });
  assert.equal(canonicalToolJSON(continuation), before);
  assert.throws(() =>
    buildGeminiToolWire(
      continuation,
      gemini,
      project,
      new Map([[1, sourceParts]]),
      new Map([[1, namespace]])
    )
  );
});
test("Opus replay type and namespace reject coercion and unknown metadata", () => {
  const value = serializeGeminiToolReplay([native], namespace, true);
  for (const mutation of [
    { type: ["agy-opus-tool-parts-v1"] },
    { correlationNamespace: null },
    { correlationNamespace: "0".repeat(32) },
    { extra: true },
  ]) {
    const parsed = JSON.parse(value);
    Object.assign(parsed[0], mutation);
    assert.throws(() => parseGeminiToolReplayGroup(canonicalToolJSON(parsed), identity));
  }
});
