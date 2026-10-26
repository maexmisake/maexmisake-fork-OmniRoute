import test from "node:test";
import assert from "node:assert/strict";
import { extractRequestFacts } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import {
  canonicalClientToolCall,
  inspectToolRequest,
} from "../../open-sse/services/decisionPolicy/toolContract.ts";
const call = (id = "call_synthetic", argumentsText = '{"x":1}') => ({
  id,
  type: "function",
  function: { name: "synthetic_lookup", arguments: argumentsText },
});
const tool = {
  type: "function",
  function: {
    name: "synthetic_lookup",
    parameters: { type: "object", properties: { x: { type: "number" } } },
  },
};
const initial = () => ({
  model: "synthetic-combo",
  messages: [{ role: "user", content: "Synthetic task" }],
  tools: [tool],
  max_tokens: 64,
  reasoning_effort: "medium",
  stream: true,
  stream_options: { include_usage: true },
});
const group = (id = "call_synthetic") => [
  { role: "assistant", content: "", tool_calls: [call(id)] },
  { role: "tool", content: "Synthetic result", tool_call_id: id },
];
test("tool contract preserves explicit controls and exact argument strings", () => {
  const source = {
    ...initial(),
    tool_choice: "auto",
    parallel_tool_calls: false,
    messages: [...initial().messages, ...group()],
  };
  const inspected = inspectToolRequest(source);
  assert.ok(inspected);
  assert.equal(inspected.current?.calls[0].arguments, '{"x":1}');
  assert.equal(inspected.history.length, 1);
  assert.deepEqual(JSON.parse(inspected.toolContractJSON).parallel_tool_calls, false);
  assert.equal(
    JSON.stringify(source),
    JSON.stringify({
      ...initial(),
      tool_choice: "auto",
      parallel_tool_calls: false,
      messages: [...initial().messages, ...group()],
    })
  );
});
test("historical ID reuse across complete active groups remains unambiguous", () => {
  const inspected = inspectToolRequest({
    ...initial(),
    messages: [...initial().messages, ...group(), ...group()],
  });
  assert.ok(inspected);
  assert.equal(inspected.history.length, 2);
  assert.equal(inspected.current?.calls[0].id, "call_synthetic");
  assert.notEqual(inspected.history[0].clientPrefixJSON, inspected.history[1].clientPrefixJSON);
});
for (const messages of [
  [
    ...initial().messages,
    { role: "assistant", content: "", tool_calls: [call(), call()] },
    ...group().slice(1),
  ],
  [
    ...initial().messages,
    ...group(),
    { role: "tool", content: "Duplicate", tool_call_id: "call_synthetic" },
  ],
  [...initial().messages, { role: "tool", content: "Forged", tool_call_id: "call_synthetic" }],
  [...initial().messages, { role: "assistant", content: "", tool_calls: [call()] }],
  [...initial().messages, ...group("call_synthetic|item_alias")],
])
  test("malformed/current duplicate/forged/noncanonical tool group fails closed", () =>
    assert.equal(inspectToolRequest({ ...initial(), messages }), null));
for (const choice of [
  "required",
  { type: "function", function: { name: "synthetic_lookup" } },
  "unknown",
])
  test("unsupported forced choice never silently becomes auto", () =>
    assert.equal(inspectToolRequest({ ...initial(), tool_choice: choice }), null));
test("new user turn does not treat every historical group as a current continuation", () => {
  const inspected = inspectToolRequest({
    ...initial(),
    messages: [...initial().messages, ...group(), { role: "user", content: "New synthetic task" }],
  });
  assert.ok(inspected);
  assert.equal(inspected.current, null);
  assert.equal(inspected.history.length, 0);
});
test("argument JSON must be an object and preserves whitespace when valid", () => {
  for (const args of ["bad", "[]", "null"]) {
    const rows = group();
    (rows[0].tool_calls![0].function as { arguments: string }).arguments = args;
    assert.equal(
      inspectToolRequest({ ...initial(), messages: [...initial().messages, ...rows] }),
      null
    );
  }
  const rows = group();
  rows[0].tool_calls![0].function.arguments = ' { "x" : 1 } ';
  const good = inspectToolRequest({ ...initial(), messages: [...initial().messages, ...rows] });
  assert.ok(good);
  assert.equal(good.current?.calls[0].arguments, ' { "x" : 1 } ');
});

test("structural facts allow historical ID reuse only with an explicit trusted current pin", () => {
  const body = { ...initial(), messages: [...initial().messages, ...group(), ...group()] };
  const noPin = extractRequestFacts(body, { measureContext: () => 128 });
  assert.equal(noPin.ok, false);
  const pinned = extractRequestFacts(body, {
    measureContext: () => 128,
    continuationCandidateId: "synthetic-pinned",
  });
  assert.equal(pinned.ok, true);
  if (pinned.ok) {
    assert.equal(pinned.facts.continuationCandidateId, "synthetic-pinned");
    assert.equal(pinned.facts.task, "continuation");
    assert.ok(!pinned.facts.state.includes("Synthetic result"));
  }
});

test("cross-role hidden carriers and undeclared active calls are rejected", () => {
  const toolRow = {
    role: "tool",
    content: "Result",
    tool_call_id: "call_synthetic",
    tool_calls: [call()],
  };
  assert.equal(
    inspectToolRequest({
      ...initial(),
      messages: [...initial().messages, ...group().slice(0, 1), toolRow],
    }),
    null
  );
  assert.equal(
    inspectToolRequest({
      ...initial(),
      messages: [{ role: "user", content: "Synthetic", tool_call_id: "call_synthetic" }],
    }),
    null
  );
  const unknown = group();
  unknown[0].tool_calls![0].function.name = "undeclared_tool";
  assert.equal(
    inspectToolRequest({ ...initial(), messages: [...initial().messages, ...unknown] }),
    null
  );
});
test("direct argument parsing never exposes a private syntax-error preview", () => {
  assert.throws(
    () => canonicalClientToolCall(call("call_synthetic", "PRIVATE-ARGUMENT-CANARY invalidJSON")),
    (error) =>
      error instanceof Error &&
      error.message === "decision_tool_arguments_invalid" &&
      !String(error).includes("PRIVATE-ARGUMENT-CANARY")
  );
});

test("tool arguments reject unsafe nested integers without exposing their contents", () => {
  for (const text of ['{"n":9007199254740993}', '{"nested":[{"n":-9007199254740993}]}']) {
    assert.throws(
      () => canonicalClientToolCall(call("call_safe", text)),
      /decision_tool_arguments_invalid/
    );
  }
  assert.equal(
    canonicalClientToolCall(call("call_safe", '{"n":9007199254740991,"fraction":0.125}')).arguments,
    '{"n":9007199254740991,"fraction":0.125}'
  );
});
