import test from "node:test";
import assert from "node:assert/strict";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.ts";
import {
  withApplicationAttempt,
  type ApplicationAttempt,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";

const literal = "[Tool call: synthetic]\nArguments: {}";
function chunk(text: string, finished = true) {
  return {
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          ...(finished ? { finishReason: "STOP" } : {}),
        },
      ],
    },
  };
}
function state() {
  return { toolCalls: new Map(), functionIndex: 0 };
}
function attempt(): ApplicationAttempt {
  return {
    id: "synthetic-translation-attempt",
    keyId: "synthetic-key",
    provider: "agy",
    model: "gemini-3.8-flash-high",
    effort: "high",
    connectionId: "synthetic-account",
    executionContract: "agy-gemini-high-v1",
    signal: new AbortController().signal,
    dispatch: {
      singleAttempt: true,
      beforeFetch() {},
      reject(): never {
        throw new Error("No dispatch in translator fixture");
      },
    },
    assertIdle() {},
    assertFresh() {},
    fence(value) {
      return value;
    },
    observe(send) {
      return send;
    },
  };
}
function deltas(rows: ReturnType<typeof geminiToOpenAIResponse>) {
  return (rows ?? []).flatMap((row) => row.choices?.map((choice) => choice.delta) ?? []);
}
test("ordinary Gemini textual tool recovery remains active", () => {
  const rows = geminiToOpenAIResponse(chunk(literal), state());
  assert.equal(deltas(rows).flatMap((delta) => delta.tool_calls ?? []).length, 1);
  assert.equal(rows?.at(-1)?.choices[0].finish_reason, "tool_calls");
});
test("bounded AGY preserves textual tool syntax as literal text without tool authority", () => {
  const rows = withApplicationAttempt(attempt(), () =>
    geminiToOpenAIResponse(chunk(literal), state())
  );
  assert.equal(deltas(rows).flatMap((delta) => delta.tool_calls ?? []).length, 0);
  assert.equal(
    deltas(rows)
      .map((delta) => delta.content ?? "")
      .join(""),
    literal
  );
  assert.equal(rows?.at(-1)?.choices[0].finish_reason, "stop");
});
test("bounded AGY split textual tool syntax stays literal", () => {
  const result = withApplicationAttempt(attempt(), () => {
    const current = state();
    return [
      ...(geminiToOpenAIResponse(chunk("[Tool call:", false), current) ?? []),
      ...(geminiToOpenAIResponse(chunk(" synthetic]\nArguments: {}"), current) ?? []),
    ];
  });
  assert.equal(deltas(result).flatMap((delta) => delta.tool_calls ?? []).length, 0);
  assert.equal(
    deltas(result)
      .map((delta) => delta.content ?? "")
      .join(""),
    literal
  );
});
test("unmarked AGY application context keeps ordinary textual recovery", () => {
  const current = attempt();
  delete current.executionContract;
  const rows = withApplicationAttempt(current, () =>
    geminiToOpenAIResponse(chunk(literal), state())
  );
  assert.equal(deltas(rows).flatMap((delta) => delta.tool_calls ?? []).length, 1);
});
