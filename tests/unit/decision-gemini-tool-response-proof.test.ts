import assert from "node:assert/strict";
import test from "node:test";
import {
  RawGeminiToolCollector,
  validateGeminiFunctionCallPart,
  validateGeminiToolParts,
} from "../../src/lib/decisionPolicy/geminiToolResponseProof.ts";
import { BoundedGeminiFrames } from "../../src/lib/decisionPolicy/geminiResponseProof.ts";

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
    { id: "native_call_1", wireName: "echo", input: { text: "Synthetic fixture" }, partIndex: 1 },
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
