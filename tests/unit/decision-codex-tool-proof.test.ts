import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RawCodexToolCollector,
  CodexResponseFrames,
  validateCodexToolItems,
} from "../../src/lib/decisionPolicy/codexResponseProof.ts";
import { canonicalToolJSON } from "../../open-sse/services/decisionPolicy/toolContract.ts";

// Curated native protocol fixtures. Request/output item fields follow official
// Codex970111f6... protocol/src/models.rs and codex-api/src/sse/responses.rs.
// No fixture is a captured live provider response or proof of entitlement.
const MODEL = "gpt-6-sol",
  NAME = "synthetic_tool",
  RESPONSE = "synthetic-tool-response";
const reasoning = {
  type: "reasoning",
  id: "rs_synthetic",
  summary: [],
  encrypted_content: "synthetic-opaque-provider-cipher",
};
const message = {
  type: "message",
  id: "msg_synthetic",
  role: "assistant",
  status: "completed",
  phase: "commentary",
  content: [{ type: "output_text", text: "Synthetic preamble", annotations: [], logprobs: [] }],
};
const call = {
  type: "function_call",
  id: "fc_synthetic",
  call_id: "call_synthetic",
  name: NAME,
  arguments: '{"value":1}',
  status: "completed",
};
function collector(allowToolUse = true) {
  return new RawCodexToolCollector({ model: MODEL, allowedNames: [NAME], allowToolUse });
}
function lifecycle(output: unknown[] | null = [reasoning, message, call], extra = {}) {
  return {
    type: "response.completed",
    response: {
      id: RESPONSE,
      model: MODEL,
      status: "completed",
      output,
      end_turn: false,
      usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 },
      ...extra,
    },
  };
}
function start(value = collector()) {
  value.accept({ type: "response.created", response: { id: RESPONSE, model: MODEL } });
  return value;
}
function done(value: RawCodexToolCollector, item: unknown, output_index: number) {
  value.accept({ type: "response.output_item.done", item, output_index });
}
function proof() {
  const value = start();
  done(value, reasoning, 0);
  done(value, message, 1);
  value.accept({
    type: "response.output_item.added",
    output_index: 2,
    item: { ...call, arguments: "", status: "in_progress" },
  });
  value.accept({
    type: "response.function_call_arguments.delta",
    output_index: 2,
    item_id: call.id,
    delta: '{"value":',
  });
  value.accept({
    type: "response.function_call_arguments.delta",
    output_index: 2,
    item_id: call.id,
    delta: "1}",
  });
  value.accept({
    type: "response.function_call_arguments.done",
    output_index: 2,
    item_id: call.id,
    arguments: call.arguments,
  });
  done(value, call, 2);
  value.accept(lifecycle());
  return value.finish();
}
function rejects(action: () => unknown) {
  assert.throws(action, /decision_(codex|tool)/);
}
test("native tool proof retains exact encrypted reasoning, sampled metadata and original call_id", () => {
  const value = proof();
  assert.ok(value);
  assert.deepEqual(value.items, [reasoning, message, call]);
  assert.deepEqual(value.calls, [{ id: call.call_id, name: NAME, arguments: call.arguments }]);
  assert.equal(value.assistantText, "Synthetic preamble");
  assert.equal(canonicalToolJSON(value.items).includes("synthetic-opaque-provider-cipher"), true);
});
test("sparse terminal uses complete original done items rather than inventing terminal output", () => {
  const value = start();
  done(value, reasoning, 0);
  done(value, call, 1);
  value.accept(lifecycle(null));
  assert.deepEqual(value.finish()?.items, [reasoning, call]);
});
test("provider-native no-tool completion remains null and does not require invented encrypted reasoning", () => {
  const value = start();
  const plain = { type: "reasoning", summary: [] };
  done(value, plain, 0);
  done(value, message, 1);
  value.accept(lifecycle([plain, message], { end_turn: true }));
  assert.equal(value.finish(), null);
});
test("end_turn false is valid only for a complete requested tool handoff", () => {
  assert.ok(proof());
  const plain = start();
  done(plain, message, 0);
  plain.accept(lifecycle([message]));
  rejects(() => plain.finish());
});
test("ordinary text proof still rejects native tool items", () => {
  const plain = new CodexResponseFrames(MODEL);
  rejects(() => plain.accept({ type: "response.output_item.done", item: call, output_index: 0 }));
});
test("terminal refusal in the tool lane preserves actual usage without publishing replay", () => {
  const frames = new CodexResponseFrames(MODEL, { allowedNames: [NAME] });
  frames.accept(
    lifecycle(
      [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "synthetic opaque refusal" }],
        },
      ],
      { end_turn: true }
    )
  );
  assert.equal(frames.applicationStatus, 422);
  assert.equal(frames.protocolTerminal, true);
  const receipt = frames.result();
  assert.equal(receipt.input, 10);
  assert.equal(receipt.output, 7);
  rejects(() => frames.toolResult());
});
test("early native tool refusal keeps its status and unknown terminal usage", () => {
  const frames = new CodexResponseFrames(MODEL, { allowedNames: [NAME] });
  frames.accept({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: "synthetic opaque refusal" }],
    },
  });
  assert.equal(frames.applicationStatus, 422);
  assert.equal(frames.protocolTerminal, false);
  assert.equal(frames.partial().output, null);
  rejects(() => frames.result());
});
test("tool_choice none and undeclared native names cannot authorize a function call", () => {
  const none = start(collector(false));
  rejects(() => done(none, call, 0));
  const other = start();
  rejects(() => done(other, { ...call, name: "unoffered_tool" }, 0));
});
for (const bad of [
  [{ ...call, call_id: "unsafe/call" }],
  [{ ...call, arguments: "[]" }],
  [{ ...call, arguments: '{"n":9007199254740993}' }],
  [{ ...call, status: "in_progress" }],
  [{ type: "reasoning", summary: [] }, call],
  [{ ...reasoning, encrypted_content: null }, call],
  [reasoning, call, { ...call, id: "other" }],
  [{ ...reasoning, type: "function_call_output", call_id: call.call_id, output: "fake" }, call],
  [{ ...call, extra_permission: true }],
])
  test(`invalid native replay group rejects (${canonicalToolJSON(bad).length} chars)`, () =>
    rejects(() => validateCodexToolItems(bad, { allowedNames: [NAME] })));
test("replay validation is detached and preserves unknown monetary semantics", () => {
  const original = [reasoning, message, call];
  const value = validateCodexToolItems(original);
  (value.items[0] as Record<string, unknown>).encrypted_content = "changed";
  assert.equal(original[0].encrypted_content, "synthetic-opaque-provider-cipher");
  assert.equal(Object.hasOwn(value, "cost"), false);
});
test("source-known opaque optional fields survive replay without authorizing a namespace", () => {
  const values = [
    { ...reasoning, internal_chat_message_metadata_passthrough: { synthetic: true } },
    { ...message, encrypted_content: null, internal_chat_message_metadata_passthrough: null },
    {
      ...call,
      namespace: null,
      encrypted_content: "synthetic-call-cipher",
      encrypted_function_args: ["synthetic-argument-cipher"],
      internal_chat_message_metadata_passthrough: { synthetic: "metadata" },
    },
  ];
  assert.deepEqual(validateCodexToolItems(values).items, values);
  rejects(() => validateCodexToolItems([{ ...call, namespace: "unoffered_namespace" }]));
});
test("argument fragments must bind to the exact known native item", () => {
  const value = start();
  value.accept({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...call, arguments: "", status: "in_progress" },
  });
  rejects(() =>
    value.accept({ type: "response.function_call_arguments.delta", item_id: "other", delta: "{}" })
  );
});
test("fragment/done argument disagreement cannot publish a continuation", () => {
  const value = start();
  value.accept({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...call, arguments: "", status: "in_progress" },
  });
  value.accept({
    type: "response.function_call_arguments.delta",
    item_id: call.id,
    delta: '{"value":2}',
  });
  rejects(() =>
    value.accept({
      type: "response.function_call_arguments.done",
      item_id: call.id,
      arguments: call.arguments,
    })
  );
});
test("a pending call cannot become a successful native terminal", () => {
  const value = start();
  value.accept({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...call, arguments: "", status: "in_progress" },
  });
  rejects(() => value.accept(lifecycle([])));
});
test("native terminal output cannot substitute the completed original call arguments", () => {
  const value = start();
  done(value, reasoning, 0);
  done(value, call, 1);
  rejects(() => value.accept(lifecycle([reasoning, { ...call, arguments: '{"value":2}' }])));
});
test("duplicate native calls, custom tools and hidden server tools remain unsupported", () => {
  rejects(() => validateCodexToolItems([reasoning, call, { ...call, id: "different" }]));
  for (const type of ["custom_tool_call", "web_search_call", "local_shell_call"])
    rejects(() => validateCodexToolItems([reasoning, { ...call, type }]));
});

test("parallel native calls completing out of order retain exact output-index order", () => {
  const other = { ...call, id: "fc_second", call_id: "call_second", arguments: '{"value":2}' };
  for (const output of [[call, other], null]) {
    const value = start();
    done(value, other, 1);
    done(value, call, 0);
    value.accept(lifecycle(output));
    assert.deepEqual(value.finish()?.items, [call, other]);
  }
});
test("parallel native calls cannot reuse an output index", () => {
  const value = start();
  done(value, call, 0);
  rejects(() => done(value, { ...call, id: "fc_second", call_id: "call_second" }, 0));
});
test("mixed indexed and unindexed native originals cannot invent replay ordering", () => {
  const value = start();
  done(value, call, 0);
  value.accept({
    type: "response.output_item.done",
    item: { ...call, id: "fc_second", call_id: "call_second" },
  });
  rejects(() => value.accept(lifecycle(null)));
});
test("parallel terminal cannot swap original IDs, arguments or encrypted reasoning", () => {
  const other = { ...call, id: "fc_second", call_id: "call_second", arguments: '{"value":2}' };
  for (const output of [
    [other, call],
    [{ ...call, arguments: other.arguments }, other],
    [{ ...reasoning, encrypted_content: "changed-cipher" }, call],
  ]) {
    const value = start();
    if (output[0].type === "reasoning") {
      done(value, reasoning, 0);
      done(value, call, 1);
    } else {
      done(value, other, 1);
      done(value, call, 0);
    }
    rejects(() => value.accept(lifecycle(output)));
  }
});
