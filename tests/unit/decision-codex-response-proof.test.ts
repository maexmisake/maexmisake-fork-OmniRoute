import test from "node:test";
import assert from "node:assert/strict";
import { CodexResponseFrames } from "../../src/lib/decisionPolicy/codexResponseProof.ts";

// Curated contract fixtures, not captured live provider envelopes. Native
// Responses event names/fields follow the pinned official Codex/Responses source.
const MODEL = "gpt-6-sol";
const ID = "synthetic-native-response";
const ITEM = "synthetic-native-message";
const usage = {
  input_tokens: 10,
  output_tokens: 7,
  total_tokens: 17,
  input_tokens_details: { cached_tokens: 4 },
  output_tokens_details: { reasoning_tokens: 3 },
};
function message(content: unknown[] = [{ type: "output_text", text: "Synthetic answer" }]) {
  return { type: "message", id: ITEM, role: "assistant", status: "completed", content };
}
function response(status = "completed", extra: Record<string, unknown> = {}) {
  return { id: ID, object: "response", model: MODEL, status, output: [message()], ...extra };
}
function lifecycle(status = "completed", extra: Record<string, unknown> = {}) {
  return { type: `response.${status}`, response: response(status, extra) };
}
function start(extra: Record<string, unknown> = {}) {
  const value = new CodexResponseFrames(MODEL);
  value.accept(lifecycle("created", { status: "in_progress", output: [], ...extra }));
  return value;
}
function complete(extra: Record<string, unknown> = {}) {
  const value = start();
  value.accept(lifecycle("completed", extra));
  return value;
}
function rejects(action: () => unknown) {
  assert.throws(action, /^Error: decision_codex_response_(invalid|incomplete)$/);
}
function itemEvent(type: "added" | "done", item: unknown = message()) {
  return { type: `response.output_item.${type}`, output_index: 0, item };
}
function delta(extra: Record<string, unknown> = {}) {
  return {
    type: "response.output_text.delta",
    item_id: ITEM,
    output_index: 0,
    content_index: 0,
    delta: "Synthetic delta",
    ...extra,
  };
}

test("native terminal counts reasoning once as an output subset and keeps undocumented cost unknown", () => {
  const value = complete({ usage: { ...usage, cost: 0.03 } });
  assert.deepEqual(value.result(), {
    input: 10,
    output: 7,
    reasoning: 3,
    cacheRead: 4,
    cacheCreation: null,
    uncachedInput: 6,
    cost: null,
  });
  assert.equal(value.applicationStatus, undefined);
  assert.equal(value.refused, false);
});
for (const missing of [undefined, null])
  test(`missing/null native usage stays unknown (${String(missing)})`, () => {
    assert.deepEqual(complete({ usage: missing }).result(), {
      input: null,
      output: null,
      reasoning: null,
      cacheRead: null,
      cacheCreation: null,
      uncachedInput: null,
      cost: null,
    });
  });
test("genuine zeros survive without inventing a free monetary receipt", () => {
  const value = complete({
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      cost: 0,
    },
  });
  assert.equal(value.result().input, 0);
  assert.equal(value.result().output, 0);
  assert.equal(value.result().reasoning, 0);
  assert.equal(value.result().cost, null);
});
test("unreceived terminal output is unknown even if the provider emitted a provisional usage snapshot", () => {
  const value = start({ usage });
  assert.deepEqual(value.partial(), {
    input: 10,
    cacheRead: 4,
    cacheCreation: null,
    uncachedInput: 6,
    output: null,
    reasoning: null,
    cost: null,
  });
  rejects(() => value.result());
});
test("a terminal missing usage never inherits provisional lifecycle output or zero counters", () => {
  const value = start({ usage });
  value.accept(lifecycle("completed"));
  assert.equal(value.result().input, null);
  assert.equal(value.result().output, null);
  assert.equal(value.result().reasoning, null);
});
test("partial nested details do not reconstruct missing input or output totals", () => {
  const value = complete({
    usage: {
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  });
  assert.equal(value.result().input, null);
  assert.equal(value.result().output, null);
  assert.equal(value.result().uncachedInput, null);
  assert.equal(value.result().reasoning, 3);
});
test("documented cache-write details stay distinct without adding them to total input", () => {
  const value = complete({
    usage: { ...usage, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } },
  });
  assert.equal(value.result().input, 10);
  assert.equal(value.result().cacheRead, 4);
  assert.equal(value.result().cacheCreation, 2);
  assert.equal(value.result().output, 7);
});
for (const status of ["failed", "incomplete", "cancelled"])
  test(`${status} native terminals retain valid reported usage but cannot become application success`, () => {
    const value = start();
    value.accept(lifecycle(status, { usage }));
    assert.ok(value.applicationStatus! >= 400);
    assert.equal(value.result().output, 7);
    assert.equal(value.result().cost, null);
  });
test("a successful HTTP terminal containing refusal remains explicit refusal", () => {
  const value = complete({
    output: [message([{ type: "refusal", refusal: "Synthetic refusal" }])],
    usage,
  });
  assert.equal(value.refused, true);
  assert.equal(value.applicationStatus, 422);
  assert.equal(value.result().output, 7);
});
test("canonical text item deltas complete with exact terminal identity", () => {
  const value = start();
  value.accept(itemEvent("added", { ...message([]), status: "in_progress" }));
  value.accept({
    ...delta(),
    type: "response.content_part.added",
    part: { type: "output_text", text: "" },
  });
  value.accept(delta());
  value.accept({ ...delta(), type: "response.output_text.done", text: "Synthetic answer" });
  value.accept(itemEvent("done"));
  value.accept(lifecycle("completed", { usage }));
  assert.equal(value.result().output, 7);
});
test("reasoning summary events remain reasoning metadata, not tool execution", () => {
  const value = start();
  const reasoning = { id: "synthetic-reasoning", type: "reasoning", summary: [] };
  value.accept(itemEvent("added", reasoning));
  value.accept({
    type: "response.reasoning_summary_text.delta",
    item_id: reasoning.id,
    output_index: 0,
    summary_index: 0,
    delta: "Synthetic summary",
  });
  value.accept(itemEvent("done", reasoning));
  value.accept(lifecycle("completed", { output: [reasoning], usage }));
  assert.equal(value.result().reasoning, 3);
});
for (const mutation of [
  { model: "gpt-5.6-sol" },
  { id: "different-response" },
  { status: "in_progress" },
  { error: { message: "Synthetic terminal error" } },
  { incomplete_details: { reason: "max_output_tokens" } },
  { output: [message(), message()] },
  {
    output: [
      {
        type: "function_call",
        id: "synthetic-tool",
        call_id: "call",
        name: "tool",
        arguments: "{}",
      },
    ],
  },
])
  test(`invalid completed identity/status/output remains rejected (${JSON.stringify(mutation)})`, () => {
    const value = start();
    rejects(() => value.accept(lifecycle("completed", mutation)));
    rejects(() => value.result());
  });
for (const invalidUsage of [
  { input_tokens: -1 },
  { output_tokens: "7" },
  { output_tokens: 1.5 },
  { input_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
  { output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } },
  { input_tokens: 1, output_tokens: 2, total_tokens: 4 },
  { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
])
  test(`malformed or inconsistent usage rejects (${JSON.stringify(invalidUsage)})`, () => {
    const value = start();
    rejects(() => value.accept(lifecycle("completed", { usage: invalidUsage })));
    rejects(() => value.result());
  });
test("sparse native text deltas are not forced into a complete public-API event envelope", () => {
  const value = start();
  value.accept({ type: "response.output_text.delta", delta: "Synthetic sparse text" });
  value.accept({ type: "response.completed", response: { id: ID } });
  assert.equal(value.result().output, null);
});
test("tool events cannot hide in an otherwise valid text item", () => {
  const value = start();
  value.accept(itemEvent("added", message([])));
  rejects(() => value.accept({ ...delta(), type: "response.function_call_arguments.delta" }));
});
test("prototype names cannot select inherited event handlers", () => {
  const value = start();
  value.accept(itemEvent("added", message([])));
  rejects(() => value.accept({ ...delta(), type: "constructor" }));
});
test("a completed response cannot hide an unfinished or substituted stream item", () => {
  const value = start();
  value.accept(itemEvent("added", message([])));
  rejects(() => value.accept(lifecycle("completed")));
});
test("sequence numbers must advance and duplicate terminals never count twice", () => {
  const value = new CodexResponseFrames(MODEL);
  value.accept({
    ...lifecycle("created", { status: "in_progress", output: [] }),
    sequence_number: 1,
  });
  rejects(() => value.accept({ ...lifecycle("in_progress", { output: [] }), sequence_number: 1 }));
  const finished = complete();
  rejects(() => finished.accept(lifecycle("completed")));
});
test("raw EOF without a provider terminal cannot be synthesized into success", () => {
  const value = start();
  rejects(() => value.result());
  rejects(() => value.accept(lifecycle("completed")));
});
test("oversized native frames fail without retaining their private text", () => {
  const value = start();
  rejects(() =>
    value.accept(
      lifecycle("completed", {
        output: [message([{ type: "output_text", text: "x".repeat(65536) }])],
      })
    )
  );
  assert.equal(JSON.stringify(value.partial()).includes("xxxx"), false);
});
test("pinned Codex sparse lifecycle has no invented model/status/output requirement", () => {
  const value = new CodexResponseFrames(MODEL);
  value.accept({ type: "response.created", response: { id: ID } });
  value.accept({ type: "response.output_text.delta", delta: "Synthetic sparse output" });
  value.accept({ type: "response.completed", response: { id: ID, usage } });
  assert.equal(value.result().output, 7);
  assert.equal(value.applicationStatus, undefined);
});
test("sparse done items do not invent IDs/indexes or require repeated terminal output", () => {
  const value = new CodexResponseFrames(MODEL);
  value.accept({
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Synthetic" }],
    },
  });
  value.accept({ type: "response.completed", response: { id: ID, output: null, usage } });
  assert.equal(value.result().output, 7);
});
test("a provider terminal alone still requires its real response ID", () => {
  const value = new CodexResponseFrames(MODEL);
  rejects(() => value.accept({ type: "response.completed", response: { usage } }));
});
test("fixed response IDs and any supplied model metadata remain strict in sparse envelopes", () => {
  const value = start();
  rejects(() =>
    value.accept({ type: "response.completed", response: { id: "unexpected", usage } })
  );
  for (const headers of [{ "OpenAI-Model": "unexpected" }, { "openai-model": 3 }]) {
    const candidate = new CodexResponseFrames(MODEL);
    rejects(() => candidate.accept({ type: "response.created", response: { id: ID, headers } }));
  }
});
test("known pre-created rate metadata has no model-selection, quota, or accounting authority", () => {
  const value = new CodexResponseFrames(MODEL);
  value.accept({
    type: "codex.rate_limits",
    model: "ignored-metadata-model",
    retry_model: "ignored-metadata-target",
    usage: { input_tokens: 999, output_tokens: 999, cost: 0 },
    rate_limits: { remaining: 0 },
  });
  value.accept({ type: "response.completed", response: { id: ID, usage } });
  assert.equal(value.result().output, 7);
  assert.equal(value.result().cost, null);
});
test("unknown vendor events remain rejected instead of widening the metadata lane", () => {
  const value = new CodexResponseFrames(MODEL);
  rejects(() => value.accept({ type: "codex.unknown_metadata", retry_model: "unexpected" }));
});
test("source-supported Responses metadata validates identity without granting retry or accounting authority", () => {
  const value = new CodexResponseFrames(MODEL);
  value.accept({
    type: "response.metadata",
    response_id: ID,
    headers: { "OpenAI-Model": MODEL },
    metadata: { retry_model: "ignored-target", usage: { output_tokens: 999 } },
  });
  value.accept({ type: "response.created", response: { id: ID } });
  value.accept({ type: "response.completed", response: { id: ID, usage } });
  assert.equal(value.result().output, 7);
  const mismatch = start();
  rejects(() => mismatch.accept({ type: "response.metadata", response_id: "different" }));
});
test("end_turn false is a valid receipt but not a completed application answer", () => {
  const value = complete({ usage, end_turn: false });
  assert.equal(value.result().output, 7);
  assert.equal(value.applicationStatus, 409);
});
test("contradictory top-level error on native text is rejected before event dispatch", () => {
  const value = start();
  rejects(() =>
    value.accept({
      type: "response.output_text.delta",
      delta: "Synthetic",
      error: { message: "Opaque synthetic failure" },
    })
  );
  assert.equal(value.partial().output, null);
  rejects(() => value.result());
});
test("contradictory top-level lifecycle error rejects while null and nested failed receipts retain their meaning", () => {
  const value = start();
  rejects(() =>
    value.accept({
      type: "response.in_progress",
      response: { id: ID },
      error: { message: "Opaque synthetic failure" },
    })
  );
  const valid = start();
  valid.accept({ type: "response.in_progress", response: { id: ID }, error: null });
  valid.accept(
    lifecycle("failed", { usage, error: { message: "Opaque synthetic nested failure" } })
  );
  assert.equal(valid.applicationStatus, 409);
  assert.equal(valid.result().output, 7);
  assert.equal(valid.result().cost, null);
});
