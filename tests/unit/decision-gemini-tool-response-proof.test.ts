import assert from "node:assert/strict";
import test from "node:test";
import {
  RawGeminiToolCollector,
  inspectGeminiFunctionCallPart,
  validateGeminiFunctionCallPart,
  validateGeminiToolParts,
} from "../../src/lib/decisionPolicy/geminiToolResponseProof.ts";
import { BoundedGeminiFrames } from "../../src/lib/decisionPolicy/geminiResponseProof.ts";
import {
  createGeminiCorrelationNamespace,
  resolveGeminiClientCallId,
} from "../../src/lib/decisionPolicy/geminiToolIdentity.ts";

const model = "gemini-3.8-flash-high";
const allowedNames = new Set(["echo", "other"]);
const signature = "c3ludGhldGljLXNpZ25hdHVyZQ==";
type Json = Record<string, unknown>;
function call(id = "native_call_1", name = "echo", signed = true): Json {
  return {
    functionCall: { id, name, args: { text: "Synthetic fixture" } },
    ...(signed ? { thoughtSignature: signature } : {}),
  };
}
function frame(parts: Json[] = [], finishReason?: string, extra: Json = {}) {
  return {
    response: {
      candidates: [
        { content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) },
      ],
      ...extra,
    },
  };
}
function collector(allowToolUse = true) {
  return new RawGeminiToolCollector({ model, allowedNames, allowToolUse });
}
function complete(parts = [call()]) {
  const value = collector();
  value.accept(frame(parts));
  value.accept(frame([], "STOP"));
  return value;
}
function rejects(action: () => unknown) {
  assert.throws(
    action,
    /^Error: decision_gemini_(tool_response_(invalid|limit)|response_(invalid|limit|incomplete))$/
  );
}

test("source-derived complete call preserves original ordered Parts and its exact native ID", () => {
  const parts = [
    { text: "Before" },
    call(),
    { text: "After" },
    { thoughtSignature: "opaque-tail" },
  ];
  const result = complete(parts).finish();
  assert.ok(result);
  assert.deepEqual(result.parts, parts);
  assert.deepEqual(result.calls, [
    {
      id: "native_call_1",
      nativeId: "native_call_1",
      wireName: "echo",
      input: { text: "Synthetic fixture" },
      partIndex: 1,
      ordinal: 0,
    },
  ]);
});
test("parallel unsigned later call stays unsigned without merging or copying signatures", () => {
  const parts = [call(), call("native_call_2", "other", false)];
  const result = complete(parts).finish();
  assert.ok(result);
  assert.deepEqual(result.parts, parts);
  assert.equal(result.parts[1].thoughtSignature, undefined);
  assert.deepEqual(
    result.calls.map((item) => item.id),
    ["native_call_1", "native_call_2"]
  );
});
test("parts accumulate across parsed frames with exact flattened part indices", () => {
  const value = collector();
  value.accept(frame([{ text: "Before" }, { text: "Thought", thought: true }]));
  value.accept(frame([call()]));
  value.accept(frame([call("native_call_2", "other", false)], "STOP"));
  const result = value.finish();
  assert.ok(result);
  assert.deepEqual(
    result.calls.map((item) => item.partIndex),
    [2, 3]
  );
});
test("static replay Part validation claims neither EOF nor a new terminal response", () => {
  assert.equal(validateGeminiToolParts([call()], allowedNames).calls.length, 1);
  const value = collector();
  value.accept(frame([call()]));
  rejects(() => value.finish());
  rejects(() => value.accept(frame([], "STOP")));
});
test("valid text-only completion has no tool authority, including explicitly disabled tools", () => {
  for (const enabled of [true, false]) {
    const value = collector(enabled);
    value.accept(frame([{ text: "OK" }], "STOP"));
    assert.equal(value.finish(), null);
  }
});
test("text-only MAX_TOKENS remains no tool authority", () => {
  const value = collector();
  value.accept(frame([{ text: "Partial" }], "MAX_TOKENS"));
  assert.equal(value.finish(), null);
});
test("tool authority requires STOP, not MAX_TOKENS or a missing finish", () => {
  for (const finish of ["MAX_TOKENS", undefined]) {
    const value = collector();
    value.accept(frame([call()], finish));
    rejects(() => value.finish());
  }
});
test("disabled tools cannot become authority even if a call is correctly signed", () => {
  const value = collector(false);
  rejects(() => value.accept(frame([call()], "STOP")));
  rejects(() => value.finish());
});
test("constructor declaration and opt-in snapshots cannot be expanded after preparation", () => {
  const names = new Set(["echo"]);
  const options = { model, allowedNames: names, allowToolUse: false };
  const disabled = new RawGeminiToolCollector(options);
  options.allowToolUse = true;
  rejects(() => disabled.accept(frame([call()], "STOP")));
  const enabled = new RawGeminiToolCollector({ ...options, allowToolUse: true });
  names.add("other");
  rejects(() => enabled.accept(frame([call("native_2", "other")], "STOP")));
});
test("structural validation without declarations makes no declared-tool authorization claim", () => {
  const unknown = call("native_1", "undeclared");
  assert.equal(validateGeminiFunctionCallPart(unknown).wireName, "undeclared");
  rejects(() => validateGeminiFunctionCallPart(unknown, allowedNames));
  rejects(() => validateGeminiToolParts([unknown], allowedNames));
});
test("caller mutations and returned snapshots cannot alter retained original evidence", () => {
  const part = call();
  const value = complete([part]);
  (part.functionCall as Json).args = { text: "Mutated" };
  const first = value.finish();
  assert.ok(first);
  (first.parts[0].functionCall as Json).args = { text: "Mutated again" };
  first.calls[0].input.text = "Mutated input";
  const second = value.finish();
  assert.ok(second);
  assert.deepEqual(second.calls[0].input, { text: "Synthetic fixture" });
  assert.deepEqual((second.parts[0].functionCall as Json).args, { text: "Synthetic fixture" });
  rejects(() => value.accept({ traceId: "after-eof" }));
});
for (const malformed of [
  { functionCall: { name: "echo", args: {} }, thoughtSignature: signature },
  { functionCall: { id: "invalid:id", name: "echo", args: {} }, thoughtSignature: signature },
  { functionCall: { id: "native_1", name: "unknown", args: {} }, thoughtSignature: signature },
  { functionCall: { id: "native_1", name: "echo", args: "{}" }, thoughtSignature: signature },
  { functionCall: { id: "native_1", name: "echo", args: [] }, thoughtSignature: signature },
  { functionCall: { id: "native_1", name: "echo", args: null }, thoughtSignature: signature },
  {
    functionCall: { id: "native_1", name: "echo", args: { unsafe: Number.MAX_SAFE_INTEGER + 1 } },
    thoughtSignature: signature,
  },
  {
    functionCall: { id: "native_1", name: "echo", args: {}, partialArgs: [] },
    thoughtSignature: signature,
  },
  {
    functionCall: { id: "native_1", name: "echo", args: {}, willContinue: false },
    thoughtSignature: signature,
  },
  {
    functionCall: {
      id: "native_1",
      name: "echo",
      partialArgs: [{ jsonPath: "$.x", stringValue: "x" }],
      willContinue: true,
    },
    thoughtSignature: signature,
  },
  { ...call(), text: "Mixed payload" },
  { ...call(), functionResponse: { name: "echo", response: {} } },
  { ...call(), error: "SYNTHETIC-PRIVATE" },
  { ...call(), thoughtSignature: "skip_thought_signature_validator" },
  { ...call(), thoughtSignature: " skip_thought_signature_validator\n" },
  { ...call(), thoughtSignature: " " },
  { ...call(), thoughtSignature: "" },
  call("native_1", "echo", false),
]) {
  test("malformed, undeclared, unsigned or fragmented calls reject and poison the proof", () => {
    const value = collector();
    rejects(() => value.accept(frame([malformed], "STOP")));
    rejects(() => value.finish());
  });
}
test("a standalone signature is retained but cannot authorize a later unsigned call", () => {
  const value = collector();
  value.accept(frame([{ thoughtSignature: signature }]));
  rejects(() => value.accept(frame([call("native_1", "echo", false)], "STOP")));
});
test("duplicate native IDs within or across frames reject rather than coalescing", () => {
  rejects(() => complete([call(), call()]));
  const value = collector();
  value.accept(frame([call()]));
  rejects(() => value.accept(frame([call()], "STOP")));
});
test("a genuine zero in arguments survives canonical validation", () => {
  const part = call();
  (part.functionCall as Json).args = { zero: 0, negative: -1, fractional: 0.25, absent: null };
  assert.deepEqual(
    validateGeminiFunctionCallPart(part, allowedNames).input,
    (part.functionCall as Json).args
  );
});
for (const bad of [
  {
    response: {
      error: { code: 403, message: "SYNTHETIC-PRIVATE" },
      candidates: [{ finishReason: "STOP" }],
    },
  },
  frame([call()], "SAFETY"),
  frame([call()], "RECITATION"),
  frame([{ inlineData: { data: "AA==" } }], "STOP"),
  frame([call()], "OTHER"),
  frame([call()], "STOP", { modelVersion: "gemini-3.8-flash" }),
  { response: { candidates: [{ finishReason: "STOP" }, { finishReason: "STOP" }] } },
  frame([call()], "STOP", { usageMetadata: { promptTokenCount: 1, cachedContentTokenCount: 2 } }),
]) {
  test("provider errors, refusals and invalid response evidence cannot authorize tools", () => {
    const value = collector();
    rejects(() => value.accept(bad));
    rejects(() => value.finish());
  });
}
test("valid no-call safety refusal remains a refusal with no tool authority", () => {
  const value = collector();
  value.accept(frame([{ text: "Synthetic refused response" }], "SAFETY"));
  assert.equal(value.finish(), null);
});
test("valid prompt refusal permits later usage before genuine EOF without tool authority", () => {
  const value = collector();
  value.accept({ response: { promptFeedback: { blockReason: "SAFETY" } } });
  value.accept({ response: { usageMetadata: { promptTokenCount: 1 } } });
  assert.equal(value.finish(), null);
});
test("blocked safety metadata without terminal evidence cannot complete at EOF", () => {
  const value = collector();
  value.accept({ response: { candidates: [{ safetyRatings: [{ blocked: true }] }] } });
  value.accept({ response: { usageMetadata: { promptTokenCount: 1 } } });
  rejects(() => value.finish());
});
test("a sticky blocked no-call response can complete later without becoming malformed", () => {
  const value = collector();
  value.accept({ response: { candidates: [{ safetyRatings: [{ blocked: true }] }] } });
  value.accept(frame([], "STOP"));
  assert.equal(value.finish(), null);
});
test("prior calls followed by refusal can never become executable tool authority", () => {
  const value = collector();
  value.accept(frame([call()]));
  rejects(() => value.accept(frame([], "SAFETY")));
  rejects(() => value.finish());
});
test("earlier blocked metadata prevents a later signed call from escaping refusal", () => {
  const value = collector();
  value.accept({ response: { candidates: [{ safetyRatings: [{ blocked: true }] }] } });
  rejects(() => value.accept(frame([call()], "STOP")));
  rejects(() => value.finish());
});
test("later valid usage is allowed, content after terminal and malformed late errors are not", () => {
  const value = complete();
  value.accept({
    response: {
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
        totalTokenCount: 1,
      },
    },
  });
  assert.equal(value.finish()?.calls.length, 1);
  for (const bad of [frame([{ text: "late" }]), { response: { error: { code: 401 } } }]) {
    const other = complete();
    rejects(() => other.accept(bad));
    rejects(() => other.finish());
  }
});
test("32 calls are bounded and the 33rd never receives authority", () => {
  const parts = Array.from({ length: 32 }, (_, i) => call(`native_${i}`, "echo", i === 0));
  assert.equal(complete(parts).finish()?.calls.length, 32);
  rejects(() => complete([...parts, call("native_32", "echo", false)]));
});
test("64 total ordered parts are bounded across multiple frames", () => {
  const value = collector();
  value.accept(frame(Array.from({ length: 63 }, () => ({ text: "x" }))));
  value.accept(frame([call()], "STOP"));
  assert.equal(value.finish()?.parts.length, 64);
  const tooMany = collector();
  tooMany.accept(frame(Array.from({ length: 64 }, () => ({ text: "x" }))));
  rejects(() => tooMany.accept(frame([call()], "STOP")));
});
test("frame, aggregate and argument budgets fail closed", () => {
  rejects(() => complete([{ text: "x".repeat(65536) }, call()]));
  const value = collector();
  const row = { response: { boundedUnknownMetadata: "x".repeat(60000) } };
  for (let i = 0; i < 17; i++) value.accept(row);
  rejects(() => value.accept(row));
  const part = call();
  (part.functionCall as Json).args = { text: "x".repeat(65536) };
  rejects(() => validateGeminiFunctionCallPart(part, allowedNames));
});
test("untrusted values cannot appear in fixed public proof errors", () => {
  const part = call();
  (part.functionCall as Json).name = "SYNTHETIC-PRIVATE-ACCOUNT";
  try {
    collector().accept(frame([part], "STOP"));
    assert.fail("Expected rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "decision_gemini_tool_response_invalid");
    assert.ok(!error.message.includes("PRIVATE"));
  }
});
test("text-only parser remains closed to tool parts unless a trusted validator is supplied", () => {
  const defaultParser = new BoundedGeminiFrames(model);
  rejects(() => defaultParser.accept(frame([call()], "STOP")));
  const trusted = new BoundedGeminiFrames(model, {
    validateFunctionCallPart: (part) => validateGeminiFunctionCallPart(part, allowedNames),
  });
  trusted.accept(frame([call()], "STOP"));
  assert.equal(trusted.result().cost, null);
});
test("trusted validation callback receives a deeply detached copy of nested arguments", () => {
  const original = call();
  (original.functionCall as Json).args = { nested: { text: "original" } };
  const frames = new BoundedGeminiFrames(model, {
    validateFunctionCallPart: (part) => {
      const args = (part.functionCall as Json).args as { nested: { text: string } };
      args.nested.text = "mutated_by_callback";
    },
  });
  frames.accept(frame([original], "STOP"));
  assert.deepEqual((original.functionCall as Json).args, { nested: { text: "original" } });
});
test("trusted callback capability cannot be replaced after construction", () => {
  const options: { validateFunctionCallPart: () => void } = {
    validateFunctionCallPart: () => {
      throw new Error("synthetic_rejection");
    },
  };
  const frames = new BoundedGeminiFrames(model, options);
  options.validateFunctionCallPart = () => {};
  rejects(() => frames.accept(frame([call()], "STOP")));
});
test("a thought-marked complete call remains a call and retains its original Part", () => {
  const original = { ...call(), thought: true };
  const proof = complete([original]).finish();
  assert.equal(proof?.calls.length, 1);
  assert.deepEqual(proof?.parts, [original]);
});

const namespace = createGeminiCorrelationNamespace("12345678-1234-4234-8234-123456789abc");
const otherNamespace = createGeminiCorrelationNamespace("12345678-1234-4234-8234-123456789abd");
function idless(signed = true): Json {
  const part = call("discarded", "echo", signed);
  delete (part.functionCall as Json).id;
  return part;
}
function correlated(parts: Json[], correlationNamespace = namespace) {
  return validateGeminiToolParts(parts, allowedNames, { correlationNamespace });
}
test("inspection distinguishes true native ID absence without modifying original Parts", () => {
  const original = idless();
  const inspected = inspectGeminiFunctionCallPart(original, allowedNames);
  assert.equal(inspected.nativeId, null);
  assert.equal(Object.hasOwn(original.functionCall as Json, "id"), false);
  rejects(() => validateGeminiFunctionCallPart(original, allowedNames));
  rejects(() => validateGeminiToolParts([original], allowedNames));
  const proof = correlated([original]);
  assert.equal(proof.calls[0].id, resolveGeminiClientCallId(null, namespace, 0));
  assert.equal(proof.calls[0].nativeId, null);
  assert.deepEqual(proof.parts, [original]);
});
test("mixed native ID presence and repeated same-name calls retain both identity domains", () => {
  const parts = [
    { text: "Before" },
    idless(),
    { text: "Between", thought: true },
    idless(false),
    call("explicit_id", "echo", false),
  ];
  const proof = correlated(parts);
  assert.deepEqual(
    proof.calls.map(({ id, nativeId, partIndex, ordinal }) => ({
      id,
      nativeId,
      partIndex,
      ordinal,
    })),
    [
      {
        id: resolveGeminiClientCallId(null, namespace, 0),
        nativeId: null,
        partIndex: 1,
        ordinal: 0,
      },
      {
        id: resolveGeminiClientCallId(null, namespace, 1),
        nativeId: null,
        partIndex: 3,
        ordinal: 1,
      },
      { id: "explicit_id", nativeId: "explicit_id", partIndex: 4, ordinal: 2 },
    ]
  );
  assert.deepEqual(proof.parts, parts);
  assert.equal(proof.parts[3].thoughtSignature, undefined);
});
test("stream frame placement cannot change call ordinals or inject native IDs", () => {
  const parts = [{ text: "Before" }, idless(), { text: "Between" }, idless(false)];
  const value = new RawGeminiToolCollector({
    model,
    allowedNames,
    allowToolUse: true,
    correlationNamespace: namespace,
  });
  value.accept(frame(parts.slice(0, 1)));
  value.accept(frame(parts.slice(1, 3)));
  value.accept(frame(parts.slice(3), "STOP"));
  assert.deepEqual(value.finish(), correlated(parts));
  assert.equal(Object.hasOwn(parts[1].functionCall as Json, "id"), false);
});
test("an explicit generated-looking ID remains native and is never reinterpreted by prefix", () => {
  const nativeId = resolveGeminiClientCallId(null, namespace, 0);
  const proof = correlated([call(nativeId)]);
  assert.equal(proof.calls[0].id, nativeId);
  assert.equal(proof.calls[0].nativeId, nativeId);
  assert.equal((proof.parts[0].functionCall as Json).id, nativeId);
});
test("an earlier generated client ID cannot collide with a later explicit native ID", () => {
  const collision = resolveGeminiClientCallId(null, namespace, 0);
  rejects(() => correlated([idless(), call(collision, "echo", false)]));
});
test("an earlier explicit native ID cannot collide with a later generated client ID", () => {
  const collision = resolveGeminiClientCallId(null, namespace, 1);
  rejects(() => correlated([call(collision), idless(false)]));
});
for (const present of [null, undefined, "", 0, false, "unsafe:id"]) {
  test("malformed present native IDs cannot be normalized into absence", () => {
    const part = idless();
    (part.functionCall as Json).id = present;
    rejects(() => inspectGeminiFunctionCallPart(part, allowedNames));
    rejects(() => correlated([part]));
  });
}
test("an immutable namespace snapshot determines IDs even if caller options later change", () => {
  const options = { model, allowedNames, allowToolUse: true, correlationNamespace: namespace };
  const value = new RawGeminiToolCollector(options);
  options.correlationNamespace = otherNamespace;
  value.accept(frame([idless()], "STOP"));
  assert.equal(value.finish()?.calls[0].id, resolveGeminiClientCallId(null, namespace, 0));
  const noContext: {
    model: string;
    allowedNames: Set<string>;
    allowToolUse: boolean;
    correlationNamespace?: string;
  } = { model, allowedNames, allowToolUse: true };
  const legacy = new RawGeminiToolCollector(noContext);
  noContext.correlationNamespace = namespace;
  rejects(() => legacy.accept(frame([idless()], "STOP")));
});
test("static namespace syntax is checked even when all calls have explicit IDs", () => {
  for (const correlationNamespace of ["", namespace.toUpperCase(), namespace + "0"])
    rejects(() => validateGeminiToolParts([call()], allowedNames, { correlationNamespace }));
});
test("namespace changes affect only local missing-ID correlation, not raw Parts or explicit IDs", () => {
  const parts = [idless(), call("native_explicit", "echo", false)];
  const first = correlated(parts),
    second = correlated(parts, otherNamespace);
  assert.notEqual(first.calls[0].id, second.calls[0].id);
  assert.equal(first.calls[1].id, second.calls[1].id);
  assert.deepEqual(first.parts, second.parts);
});
test("all 32 ID-less calls remain distinct and bounded despite identical names and arguments", () => {
  const parts = Array.from({ length: 32 }, (_, ordinal) => idless(ordinal === 0));
  const proof = correlated(parts);
  assert.equal(new Set(proof.calls.map((call) => call.id)).size, 32);
  assert.ok(proof.calls.every((call) => call.nativeId === null));
  rejects(() => correlated([...parts, idless(false)]));
});
test("missing native IDs never relax signature, STOP or explicit opt-in requirements", () => {
  rejects(() => correlated([idless(false)]));
  const value = new RawGeminiToolCollector({
    model,
    allowedNames,
    allowToolUse: true,
    correlationNamespace: namespace,
  });
  value.accept(frame([idless()]));
  rejects(() => value.finish());
  const disabled = new RawGeminiToolCollector({
    model,
    allowedNames,
    allowToolUse: false,
    correlationNamespace: namespace,
  });
  rejects(() => disabled.accept(frame([idless()], "STOP")));
});
