import test from "node:test";
import assert from "node:assert/strict";
import {
  RawClaudeToolCollector,
  ClientOpenAIToolCollector,
  ClientToolSSEFramer,
  crossCheckToolCalls,
  TOOL_PROOF_LIMITS,
} from "../../src/lib/decisionPolicy/toolResponseProof.ts";

const model = "claude-opus-5-5";
const encoder = new TextEncoder();
const start = { type: "message_start", message: { role: "assistant", content: [] } };
const stop = { type: "message_stop" };
const finish = (reason = "tool_use") => ({
  type: "message_delta",
  delta: { stop_reason: reason, stop_sequence: null },
});
const block = (index: number, content_block: unknown) => ({
  type: "content_block_start",
  index,
  content_block,
});
const delta = (index: number, data: unknown) => ({
  type: "content_block_delta",
  index,
  delta: data,
});
const close = (index: number) => ({ type: "content_block_stop", index });
const tool = (index = 0, id = "call_1", name = "Read", input: unknown = {}) =>
  block(index, { type: "tool_use", id, name, input });
const argument = (text: string, index = 0) =>
  delta(index, { type: "input_json_delta", partial_json: text });
function raw(events: unknown[]) {
  const collector = new RawClaudeToolCollector();
  events.forEach((event) => collector.accept(event));
  return collector.finish();
}
function rawEvents(args = '{"path":"☃"}') {
  return [start, tool(), argument(args), close(0), finish(), stop];
}

for (const role of [undefined, "user"]) {
  test(`raw message start ${role === undefined ? "omitted" : "non-assistant"} role is invalid`, () => {
    const malformed = {
      type: "message_start",
      message: { content: [], ...(role === undefined ? {} : { role }) },
    };
    rejects(() => raw([malformed, ...rawEvents().slice(1)]));
  });
}
function chunk(data: unknown, reason: unknown = null) {
  return {
    model,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: data, finish_reason: reason }],
  };
}
function call(index = 0, id = "call_1", name = "read", args = "") {
  return { index, id, type: "function", function: { name, arguments: args } };
}
function client(args = '{"path":"☃"}', name = "read") {
  const c = new ClientOpenAIToolCollector(model);
  c.accept(chunk({ role: "assistant", content: "Before " }));
  c.accept(chunk({ content: "tools", tool_calls: [call(0, "call_1", name, args)] }));
  assert.deepEqual(c.accept(chunk({}, "tool_calls")), { completion: true });
  c.done();
  return c.finish()!;
}
function rejects(action: () => unknown) {
  assert.throws(action, /^Error: decision_tool_response_(invalid|limit)$/);
}

test("raw complete tool group and client restored descriptors agree without altering arguments", () => {
  const provider = raw(rawEvents())!;
  const delivered = client(' { "path" : "☃" } ');
  crossCheckToolCalls(provider, delivered, (name) => (name === "Read" ? "read" : name));
  assert.equal(delivered.assistant.content, "Before tools");
  assert.equal(delivered.calls[0].arguments, ' { "path" : "☃" } ');
  assert.deepEqual(provider.calls, [{ id: "call_1", wireName: "Read", input: { path: "☃" } }]);
});

test("signed and redacted thinking blocks retain exact ordered contents", () => {
  const p = raw([
    start,
    block(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "private thought" }),
    delta(0, { type: "signature_delta", signature: "sig-" }),
    delta(0, { type: "signature_delta", signature: "complete" }),
    close(0),
    block(1, { type: "redacted_thinking", data: "opaque-data" }),
    close(1),
    tool(2),
    argument('{"path":', 2),
    argument('"x"}', 2),
    close(2),
    finish(),
    stop,
  ])!;
  assert.deepEqual(p.thinkingBlocks, [
    { type: "thinking", thinking: "private thought", signature: "sig-complete" },
    { type: "redacted_thinking", data: "opaque-data" },
  ]);
});

function signed(index: number) {
  return [
    block(index, { type: "thinking", thinking: "private", signature: "signed" }),
    close(index),
  ];
}
function text(index: number) {
  return [block(index, { type: "text", text: "before tools" }), close(index)];
}
function completeTool(index: number, callId = `call_${index}`) {
  return [tool(index, callId), argument("{}", index), close(index)];
}

test("supported signed-thinking then text then tool phases retain exact block and call order", () => {
  const p = raw([
    start,
    ...signed(0),
    block(1, { type: "redacted_thinking", data: "opaque" }),
    close(1),
    ...text(2),
    ...completeTool(3),
    ...completeTool(4),
    finish(),
    stop,
  ])!;
  assert.deepEqual(p.thinkingBlocks, [
    { type: "thinking", thinking: "private", signature: "signed" },
    { type: "redacted_thinking", data: "opaque" },
  ]);
  assert.deepEqual(
    p.calls.map((c) => c.id),
    ["call_3", "call_4"]
  );
});

const unsupportedOrders: [string, unknown[]][] = [
  ["tool then thinking then tool", [...completeTool(0), ...signed(1), ...completeTool(2)]],
  ["tools then thinking", [...completeTool(0), ...completeTool(1), ...signed(2)]],
  ["text then thinking", [...text(0), ...signed(1), ...completeTool(2)]],
  ["tool then text", [...signed(0), ...completeTool(1), ...text(2)]],
  [
    "text interleaved between tools",
    [...signed(0), ...completeTool(1), ...text(2), ...completeTool(3)],
  ],
  [
    "redacted thinking after text",
    [
      ...text(0),
      block(1, { type: "redacted_thinking", data: "opaque" }),
      close(1),
      ...completeTool(2),
    ],
  ],
];
for (const [name, events] of unsupportedOrders) {
  test(`unsupported raw order ${name} cannot collapse into a handoff proof`, () => {
    rejects(() => raw([start, ...events, finish(), stop]));
  });
}

test("explicit empty object arguments are accepted; client empty placeholder is rejected", () => {
  assert.deepEqual(raw(rawEvents("{}"))!.calls[0].input, {});
  assert.deepEqual(raw([start, tool(), close(0), finish(), stop])!.calls[0].input, {});
  rejects(() => client(""));
  assert.equal(client("{}").calls[0].arguments, "{}");
});

test("nonempty initial complete input is retained but cannot be combined with partial deltas", () => {
  assert.deepEqual(
    raw([start, tool(0, "call_1", "Read", { path: "x" }), close(0), finish(), stop])!.calls[0]
      .input,
    { path: "x" }
  );
  rejects(() => raw([start, tool(0, "call_1", "Read", { x: 1 }), argument("{}"), close(0)]));
});

test("parallel response calls have distinct current-group IDs and stable order", () => {
  const p = raw([
    start,
    tool(),
    argument("{}"),
    close(0),
    tool(1, "call_2", "Write"),
    argument('{"value":2}', 1),
    close(1),
    finish(),
    stop,
  ])!;
  assert.deepEqual(
    p.calls.map((c) => c.id),
    ["call_1", "call_2"]
  );
});

test("provider IDs may be legitimately reused in another response occurrence", () => {
  assert.deepEqual(raw(rawEvents()), raw(rawEvents()));
  assert.deepEqual(client(), client());
});

test("auto plain end_turn returns no tool proof; none rejects any tool block", () => {
  assert.equal(
    raw([start, block(0, { type: "text", text: "hello" }), close(0), finish("end_turn"), stop]),
    null
  );
  const c = new RawClaudeToolCollector({ allowToolUse: false });
  c.accept(start);
  rejects(() => c.accept(tool()));
  rejects(() => c.finish());
});

for (const reason of ["refusal", "model_context_window_exceeded"]) {
  test(`documented no-call ${reason} remains a valid raw non-handoff response`, () => {
    assert.equal(raw([start, finish(reason), stop]), null);
    const none = new RawClaudeToolCollector({ allowToolUse: false });
    [start, finish(reason), stop].forEach((event) => none.accept(event));
    assert.equal(none.finish(), null);
  });
}

const rawBad: [string, unknown[]][] = [
  ["missing message start", [tool()]],
  ["missing index", [start, { ...tool(), index: undefined }]],
  ["missing index zero", [start, tool(1)]],
  ["repeated closed index", [start, tool(), close(0), tool()]],
  ["duplicate current-group ID", [start, tool(), close(0), tool(1)]],
  ["wrong block delta type", [start, tool(), delta(0, { type: "text_delta", text: "{}" })]],
  ["unsigned thinking", [start, block(0, { type: "thinking", thinking: "x" }), close(0)]],
  [
    "thinking after signature",
    [
      start,
      block(0, { type: "thinking", thinking: "", signature: "s" }),
      delta(0, { type: "thinking_delta", thinking: "x" }),
    ],
  ],
  ["missing redacted data", [start, block(0, { type: "redacted_thinking", data: "" })]],
  ["malformed arguments", [start, tool(), argument('{"private":'), close(0)]],
  ["array arguments", [start, tool(), argument("[]"), close(0)]],
  ["refusal with tool calls", [start, tool(), argument("{}"), close(0), finish("refusal"), stop]],
  [
    "context limit with tool calls",
    [start, tool(), argument("{}"), close(0), finish("model_context_window_exceeded"), stop],
  ],
  ["unknown server tool", [start, block(0, { type: "server_tool_use" })]],
  ["unfinished block", [start, tool(), finish(), stop]],
  ["truncated terminal", [start, tool(), argument("{}"), close(0), finish()]],
  ["truncated call reason", [start, tool(), argument("{}"), close(0), finish("max_tokens"), stop]],
  ["unknown stop", [start, finish("future_reason"), stop]],
  ["trailing event", [...rawEvents(), { type: "ping" }]],
];
for (const [name, events] of rawBad) {
  test(`raw collector never proves ${name}`, () => rejects(() => raw(events)));
}

test("raw missing-terminal failure poisons the collector", () => {
  const c = new RawClaudeToolCollector();
  c.accept(start);
  rejects(() => c.finish());
  rejects(() => c.accept(finish()));
});

test("raw arguments and parsed event sizes are byte bounded, not UTF-16 counts", () => {
  rejects(() => raw([start, tool(), argument('"' + "☃".repeat(22000) + '"')]));
});

test("raw current-group call, index and event counts are bounded", () => {
  const events: unknown[] = [start];
  for (let n = 0; n <= TOOL_PROOF_LIMITS.calls; n++) {
    events.push(tool(n, `call_${n}`), argument("{}", n), close(n));
  }
  rejects(() => raw(events));
  rejects(() => raw([start, block(TOOL_PROOF_LIMITS.blocks, { type: "text", text: "" })]));
  const c = new RawClaudeToolCollector();
  c.accept(start);
  rejects(() => {
    for (let n = 0; n < TOOL_PROOF_LIMITS.events; n++) c.accept({ type: "ping" });
  });
});

test("raw tool-choice policy is captured rather than mutable through caller options", () => {
  const options = { allowToolUse: false };
  const c = new RawClaudeToolCollector(options);
  options.allowToolUse = true;
  c.accept(start);
  rejects(() => c.accept(tool()));
});

test("client name and argument deltas assemble exact restored names and multiple calls", () => {
  const c = new ClientOpenAIToolCollector(model);
  c.accept(chunk({ tool_calls: [call(0, "call_1", "lo", '{"a":')] }));
  c.accept(chunk({ tool_calls: [{ index: 0, function: { name: "okup", arguments: "1}" } }] }));
  c.accept(chunk({ tool_calls: [call(1, "call_2", "write", "{}")] }));
  c.accept(chunk({}, "tool_calls"));
  c.done();
  assert.deepEqual(
    c.finish()!.calls.map((v) => [v.id, v.name, v.arguments]),
    [
      ["call_1", "lookup", '{"a":1}'],
      ["call_2", "write", "{}"],
    ]
  );
});

test("client classifier holds only completion/after-finish usage; done is separate", () => {
  const c = new ClientOpenAIToolCollector(model);
  assert.deepEqual(c.accept(chunk({ tool_calls: [call(0, "call_1", "read", "{}")] })), {
    completion: false,
  });
  assert.deepEqual(c.accept(chunk({}, "tool_calls")), { completion: true });
  assert.deepEqual(
    c.accept({ model, object: "chat.completion.chunk", choices: [], usage: { total_tokens: 0 } }),
    { completion: true }
  );
  c.done();
  assert.ok(c.finish());
});

test("client end_turn with no tool call proves no tool group", () => {
  const c = new ClientOpenAIToolCollector(model);
  c.accept(chunk({ content: "hello" }, "stop"));
  c.done();
  assert.equal(c.finish(), null);
});

for (const refusal of ["", "Synthetic refusal"]) {
  test(`client no-call refusal ${refusal ? "text" : "placeholder"} is valid without handoff proof`, () => {
    const c = new ClientOpenAIToolCollector(model);
    assert.deepEqual(c.accept(chunk({ refusal })), { completion: false });
    assert.deepEqual(c.accept(chunk({}, "stop")), { completion: true });
    c.done();
    assert.equal(c.finish(), null);
  });
}

test("client content_filter with no calls is valid without handoff proof", () => {
  const c = new ClientOpenAIToolCollector(model);
  assert.deepEqual(c.accept(chunk({}, "content_filter")), { completion: true });
  c.done();
  assert.equal(c.finish(), null);
});

test("client finish reason array is invalid instead of coercing to a documented string", () => {
  const c = new ClientOpenAIToolCollector(model);
  rejects(() => c.accept(chunk({}, ["stop"])));
});

test("usage-only and in-band totals cannot precede the finish marker", () => {
  const usageOnly = {
    model,
    object: "chat.completion.chunk",
    choices: [],
    usage: { total_tokens: 0 },
  };
  const c = new ClientOpenAIToolCollector(model);
  rejects(() => c.accept(usageOnly));
  const d = new ClientOpenAIToolCollector(model);
  rejects(() => d.accept({ ...chunk({ content: "early" }), usage: { total_tokens: 12 } }));
});

test("finish-carried and trailing usage are both classified as held completion frames", () => {
  const c = new ClientOpenAIToolCollector(model);
  c.accept(chunk({ tool_calls: [call(0, "call_1", "read", "{}")] }));
  assert.deepEqual(c.accept({ ...chunk({}, "tool_calls"), usage: { total_tokens: 12 } }), {
    completion: true,
  });
  assert.deepEqual(
    c.accept({ model, object: "chat.completion.chunk", choices: [], usage: { total_tokens: 12 } }),
    { completion: true }
  );
  c.done();
  assert.ok(c.finish());
});

const clientBad: [string, unknown[]][] = [
  ["wrong exact model", [{ ...chunk({}), model: "different" }]],
  ["missing index", [chunk({ tool_calls: [{ ...call(), index: undefined }] })]],
  ["missing index zero", [chunk({ tool_calls: [call(1)] })]],
  ["duplicate index in frame", [chunk({ tool_calls: [call(), call()] })]],
  ["duplicate call ID", [chunk({ tool_calls: [call(), call(1)] })]],
  ["repeated ID carrier", [chunk({ tool_calls: [call()] }), chunk({ tool_calls: [call()] })]],
  [
    "refusal after call",
    [chunk({ tool_calls: [call()] }), chunk({ refusal: "synthetic private refusal" })],
  ],
  ["call after empty refusal carrier", [chunk({ refusal: "" }), chunk({ tool_calls: [call()] })]],
  ["wrong role", [chunk({ role: "user" })]],
  ["content array", [chunk({ content: [{ text: "x" }] })]],
  ["legacy function_call", [chunk({ function_call: { name: "read" } })]],
  ["wrong finish reason", [chunk({ tool_calls: [call(0, "call_1", "read", "{}")] }, "stop")]],
  ["postfinish content", [chunk({}, "stop"), chunk({ content: "late" })]],
];
for (const [name, events] of clientBad) {
  test(`client collector never proves ${name}`, () => {
    const c = new ClientOpenAIToolCollector(model);
    rejects(() => events.forEach((v) => c.accept(v)));
    rejects(() => c.finish());
  });
}

test("premature or duplicated DONE is invalid and permanently poisons proof", () => {
  const c = new ClientOpenAIToolCollector(model);
  rejects(() => c.done());
  rejects(() => c.accept(chunk({}, "stop")));
  const valid = new ClientOpenAIToolCollector(model);
  valid.accept(chunk({}, "stop"));
  valid.done();
  rejects(() => valid.done());
  rejects(() => valid.finish());
});

test("client missing DONE never proves a tool group", () => {
  const c = new ClientOpenAIToolCollector(model);
  c.accept(chunk({ tool_calls: [call(0, "call_1", "read", "{}")] }, "tool_calls"));
  rejects(() => c.finish());
});

test("client final parse failure cannot be repaired into a later valid group", () => {
  const c = new ClientOpenAIToolCollector(model);
  c.accept(chunk({ tool_calls: [call(0, "call_1", "read", "{")] }, "tool_calls"));
  c.done();
  rejects(() => c.finish());
  rejects(() => c.accept(chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] })));
});

test("client current-group call count is bounded", () => {
  const c = new ClientOpenAIToolCollector(model);
  rejects(() => {
    for (let n = 0; n <= TOOL_PROOF_LIMITS.calls; n++)
      c.accept(chunk({ tool_calls: [call(n, `call_${n}`, "read", "{}")] }));
  });
});

test("framer retains split UTF-8, CRLF, original bytes and does not pre-drain answer", () => {
  const content = `data: ${JSON.stringify(chunk({ content: "☃" }))}\r\n\r\n`;
  const terminal = `data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`;
  const bytes = encoder.encode(content + terminal);
  const framer = new ClientToolSSEFramer();
  const frames = [...bytes].flatMap((byte) => framer.push(new Uint8Array([byte])));
  framer.finish();
  assert.equal(frames.length, 3);
  assert.deepEqual(Buffer.concat(frames.map((f) => Buffer.from(f.bytes))), Buffer.from(bytes));
  assert.equal(frames[0].payload!.choices instanceof Array, true);
  assert.equal(frames[0].done, false);
  assert.equal(frames[2].done, true);
});

test("framer leaves comments opaque but rejects malformed, truncated and invalid UTF-8 frames", () => {
  const c = new ClientToolSSEFramer();
  const comments = c.push(encoder.encode(": heartbeat\n\n"));
  assert.deepEqual(
    comments.map((f) => [f.payload, f.done]),
    [[undefined, false]]
  );
  c.finish();
  for (const bytes of [
    encoder.encode("data: private-not-json\n\n"),
    new Uint8Array([100, 97, 116, 97, 58, 32, 255, 10, 10]),
  ]) {
    const f = new ClientToolSSEFramer();
    rejects(() => f.push(bytes));
    rejects(() => f.finish());
  }
  const incomplete = new ClientToolSSEFramer();
  incomplete.push(encoder.encode("data: [DONE]\n"));
  rejects(() => incomplete.finish());
  rejects(() => incomplete.push(encoder.encode("\n")));
});

test("framer enforces complete-frame, pending-frame, total-byte and event limits", () => {
  rejects(() =>
    new ClientToolSSEFramer().push(
      encoder.encode(":" + "x".repeat(TOOL_PROOF_LIMITS.frameBytes) + "\n\n")
    )
  );
  rejects(() => new ClientToolSSEFramer().push(new Uint8Array(TOOL_PROOF_LIMITS.frameBytes + 1)));
  rejects(() => new ClientToolSSEFramer().push(new Uint8Array(TOOL_PROOF_LIMITS.totalBytes + 1)));
  rejects(() =>
    new ClientToolSSEFramer().push(encoder.encode(":\n\n".repeat(TOOL_PROOF_LIMITS.events + 1)))
  );
});

test("successful client EOF does not accept subsequent frames", () => {
  const f = new ClientToolSSEFramer();
  f.push(encoder.encode("data: [DONE]\n\n"));
  f.finish();
  rejects(() => f.push(encoder.encode(": after EOF\n\n")));
});

test("cross-check requires explicit restored name, same order/IDs and semantic arguments", () => {
  const p = raw(rawEvents())!;
  rejects(() => crossCheckToolCalls(p, client(), (v) => v));
  rejects(() => crossCheckToolCalls(p, client('{"path":"other"}'), () => "read"));
  const wrongId = client();
  wrongId.calls[0].id = "foreign";
  rejects(() => crossCheckToolCalls(p, wrongId, () => "read"));
  const missing = client();
  missing.calls.length = 0;
  rejects(() => crossCheckToolCalls(p, missing, () => "read"));
});

test("unsafe tool integers cannot collide after JavaScript parsing", () => {
  rejects(() => raw(rawEvents('{"n":9007199254740992}')));
  rejects(() => client('{"n":9007199254740993}'));
  rejects(() => raw([start, tool(0, "call_1", "Read", { nested: [Number.MAX_SAFE_INTEGER + 1] })]));
  const provider = {
    calls: [{ id: "call_1", wireName: "Read", input: { n: 9007199254740992 } }],
    thinkingBlocks: [],
  };
  const delivered = client("{}");
  delivered.calls[0].arguments = '{"n":9007199254740993}';
  rejects(() => crossCheckToolCalls(provider, delivered, () => "read"));
});

test("safe integer limits and ordinary fractional tool arguments retain agreement", () => {
  const argumentsJSON = '{"min":-9007199254740991,"max":9007199254740991,"fraction":1.5}';
  crossCheckToolCalls(raw(rawEvents(argumentsJSON))!, client(argumentsJSON), () => "read");
});

test("result snapshots cannot mutate private collector state", () => {
  const c = new RawClaudeToolCollector();
  rawEvents().forEach((v) => c.accept(v));
  c.finish()!.calls[0].input.path = "changed";
  assert.equal(c.finish()!.calls[0].input.path, "☃");
});

test("fixed failures never echo private arguments, names or JSON previews", () => {
  const secret = "synthetic-secret-not-for-errors";
  try {
    raw([start, tool(), argument(secret), close(0)]);
    assert.fail("must reject malformed arguments");
  } catch (e) {
    assert.equal((e as Error).message, "decision_tool_response_invalid");
    assert.ok(!(e as Error).stack!.includes(secret));
  }
});
