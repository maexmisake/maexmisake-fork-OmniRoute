import test from "node:test";
import assert from "node:assert/strict";
import { GeminiToolClient } from "../../src/lib/decisionPolicy/geminiToolClient.ts";

const MODEL = "gemini-3.8-flash-high";
const RESPONSE = "chatcmpl-synthetic-gateway";
function frame(parts: unknown[] = [], finishReason?: unknown, extra = {}) {
  return {
    response: {
      candidates: [
        {
          index: 0,
          content: { role: "model", parts },
          ...(finishReason === undefined ? {} : { finishReason }),
        },
      ],
      ...extra,
    },
  };
}
function call(id = "native_call_1", name = "echo", args: unknown = { text: "fixture" }) {
  return { functionCall: { id, name, args }, thoughtSignature: "synthetic-private-signature" };
}
function converter() {
  return new GeminiToolClient(MODEL, RESPONSE, new Set(["echo"]));
}
function invalid(action: () => unknown) {
  assert.throws(
    action,
    /^Error: decision_gemini_(tool_client|tools|response)_(invalid|limit|incomplete)$/
  );
}

test("complete native calls become exact indexed OpenAI tool deltas", () => {
  const client = converter();
  const rows = client.accept(frame([call()], "STOP"));
  assert.deepEqual(rows[0].choices[0].delta, {
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "native_call_1",
        type: "function",
        function: { name: "echo", arguments: '{"text":"fixture"}' },
      },
    ],
  });
  assert.equal(rows.at(-1)?.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(client.finish(), []);
});
test("parallel calls preserve native order, IDs and monotonically assigned indices", () => {
  const client = converter();
  const rows = [
    ...client.accept(frame([call("first")])),
    ...client.accept(frame([call("second", "echo", {})], "STOP")),
  ];
  const calls = rows.flatMap((row) => row.choices[0].delta.tool_calls ?? []);
  assert.deepEqual(
    calls.map(({ id, index }) => ({ id, index })),
    [
      { id: "first", index: 0 },
      { id: "second", index: 1 },
    ]
  );
  assert.equal(calls[1].function.arguments, "{}");
  client.finish();
});
test("literal text and thoughts retain delta bytes without tag or textual-tool parsing", () => {
  const client = converter();
  const literal = "[Tool call: synthetic]\nArguments: {} <think>literal</think>";
  const rows = client.accept(
    frame([{ text: "reason 🪶", thought: true }, { text: literal }, { text: "" }], "STOP")
  );
  assert.equal(rows[0].choices[0].delta.reasoning_content, "reason 🪶");
  assert.equal(rows[1].choices[0].delta.content, literal);
  assert.equal(rows.flatMap((row) => row.choices[0].delta.tool_calls ?? []).length, 0);
  assert.equal(rows.at(-1)?.choices[0].finish_reason, "stop");
  client.finish();
});
test("gateway metadata is stable and provider-private metadata never reaches client chunks", () => {
  const client = converter();
  const rows = client.accept({
    ...frame([{ text: "ok", thoughtSignature: "private-signature" }], "STOP", {
      responseId: "native-private-id",
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 0,
        totalTokenCount: 5,
      },
    }),
    traceId: "private-trace",
    consumedCredits: [{ amount: "9" }],
    remainingCredits: [{ amount: "42" }],
  });
  assert.ok(
    rows.every(
      (row) => row.id === RESPONSE && row.model === MODEL && row.object === "chat.completion.chunk"
    )
  );
  assert.ok(
    rows.every((row) => Number.isSafeInteger(row.created) && row.created === rows[0].created)
  );
  const serialized = JSON.stringify(rows);
  for (const privateValue of [
    "private-signature",
    "native-private-id",
    "private-trace",
    "consumedCredits",
    "remainingCredits",
    "usage",
    "promptTokenCount",
  ])
    assert.equal(serialized.includes(privateValue), false);
  client.finish();
});
test("standalone signature metadata emits no text or synthetic tool delta", () => {
  const client = converter();
  assert.deepEqual(client.accept(frame([{ thoughtSignature: "synthetic-signature" }])), []);
  assert.equal(client.accept(frame([], "STOP")).at(-1)?.choices[0].finish_reason, "stop");
  client.finish();
});
test("ordinary maximum token finish maps to length without inventing a call", () => {
  const client = converter();
  const rows = client.accept(frame([{ text: "partial answer" }], "MAX_TOKENS"));
  assert.equal(rows.at(-1)?.choices[0].finish_reason, "length");
  client.finish();
});
for (const reason of [
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]) {
  test(`blocked finish ${reason} preserves refusal with no tool authority`, () => {
    const client = converter();
    const rows = client.accept(frame([], reason));
    assert.equal(rows.at(-1)?.choices[0].finish_reason, "content_filter");
    assert.equal(rows.flatMap((row) => row.choices[0].delta.tool_calls ?? []).length, 0);
    client.finish();
  });
}
test("prompt refusal without candidates maps to content_filter", () => {
  const client = converter();
  const rows = client.accept({ response: { promptFeedback: { blockReason: "SAFETY" } } });
  assert.equal(rows.at(-1)?.choices[0].finish_reason, "content_filter");
  client.finish();
});
for (const [name, raw] of [
  ["missing native ID", frame([{ functionCall: { name: "echo", args: {} } }], "STOP")],
  ["missing args", frame([{ functionCall: { id: "a", name: "echo" } }], "STOP")],
  ["string args", frame([call("a", "echo", "{}")], "STOP")],
  ["array args", frame([call("a", "echo", [])], "STOP")],
  ["unsafe integer args", frame([call("a", "echo", { n: 9007199254740992 })], "STOP")],
  [
    "partial args",
    frame([{ functionCall: { id: "a", name: "echo", args: {}, partialArgs: [] } }], "STOP"),
  ],
  [
    "continuation marker",
    frame([{ functionCall: { id: "a", name: "echo", args: {}, willContinue: false } }], "STOP"),
  ],
  ["duplicate call", frame([call("same"), call("same")], "STOP")],
  ["tools truncated", frame([call()], "MAX_TOKENS")],
  ["tools refused", frame([call()], "SAFETY")],
  [
    "multiple candidates",
    { response: { candidates: [{ content: { parts: [] } }, { content: { parts: [] } }] } },
  ],
  ["wrong model", frame([], "STOP", { modelVersion: "different-model" })],
  ["native error", { response: { error: { message: "private-provider-error" } } }],
  ["unknown terminal", frame([], "MALFORMED_FUNCTION_CALL")],
  ["unsupported media", frame([{ inlineData: { data: "private" } }], "STOP")],
] as const) {
  test(`rejects ${name} without exposing raw values`, () => {
    const client = converter();
    invalid(() => client.accept(raw));
    invalid(() => client.finish());
  });
}
test("duplicate calls across frames cannot become another tool index", () => {
  const client = converter();
  client.accept(frame([call()]));
  invalid(() => client.accept(frame([call()], "STOP")));
});
test("raw EOF before terminal cannot fabricate stop or DONE", () => {
  const client = converter();
  client.accept(frame([{ text: "not terminal" }]));
  invalid(() => client.finish());
  invalid(() => client.accept(frame([], "STOP")));
});
test("terminal permits usage-only trailing frames but no later candidate", () => {
  const client = converter();
  client.accept(frame([], "STOP"));
  assert.deepEqual(
    client.accept({
      response: {
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          totalTokenCount: 0,
        },
      },
    }),
    []
  );
  invalid(() => client.accept(frame([{ text: "late" }])));
});
test("finished converter cannot be reused for a second response", () => {
  const client = converter();
  client.accept(frame([], "STOP"));
  assert.deepEqual(client.finish(), []);
  invalid(() => client.accept(frame([], "STOP")));
});
test("response and model identifiers are bounded gateway metadata", () => {
  for (const [model, responseId] of [
    ["", RESPONSE],
    [MODEL, ""],
    [MODEL, "\nprivate"],
    ["x".repeat(201), RESPONSE],
    [MODEL, "x".repeat(201)],
  ])
    invalid(() => new GeminiToolClient(model, responseId, new Set(["echo"])));
});
test("source input mutation cannot change already emitted JSON arguments", () => {
  const args = { nested: { text: "original" } };
  const client = converter();
  const rows = client.accept(frame([call("a", "echo", args)], "STOP"));
  args.nested.text = "changed";
  assert.equal(
    rows[0].choices[0].delta.tool_calls?.[0].function.arguments,
    '{"nested":{"text":"original"}}'
  );
  client.finish();
});

test("undeclared names reject and constructor name set mutation cannot expand admission", () => {
  const names = new Set(["echo"]);
  const client = new GeminiToolClient(MODEL, RESPONSE, names);
  names.add("secret_tool");
  invalid(() => client.accept(frame([call("a", "secret_tool", {})], "STOP")));
});
test("a refused prompt emits completion only once across trailing usage", () => {
  const client = converter();
  client.accept({ response: { promptFeedback: { blockReason: "SAFETY" } } });
  assert.deepEqual(client.accept({ response: { usageMetadata: { promptTokenCount: 0 } } }), []);
  client.finish();
});

test("oversized frames fail without copying private text into the exception", () => {
  const client = converter();
  const canary = "synthetic-private-oversize";
  invalid(() => client.accept(frame([{ text: canary.repeat(4000) }])));
  invalid(() => client.finish());
});
test("at most 32 complete native calls can be projected", () => {
  const client = converter();
  const first = client.accept(
    frame(Array.from({ length: 32 }, (_, index) => call(`native_${index}`)))
  );
  assert.equal(first.length, 32);
  invalid(() => client.accept(frame([call("one_too_many")], "STOP")));
});
test("hostile non-JSON input cannot invoke getters or stringify hooks", () => {
  for (const key of ["response", "toJSON"]) {
    let invoked = false;
    const raw = Object.defineProperty({}, key, {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("synthetic-secret");
      },
    });
    invalid(() => converter().accept(raw));
    assert.equal(invoked, false);
  }
});
test("trailing native error cannot preserve an earlier successful terminal", () => {
  const client = converter();
  client.accept(frame([], "STOP"));
  invalid(() => client.accept({ response: { error: { message: "synthetic-private" } } }));
  invalid(() => client.finish());
});
test("missing and genuine zero argument values preserve JSON meaning", () => {
  const client = converter();
  const rows = client.accept(
    frame([call("values", "echo", { zero: 0, nil: null, disabled: false, empty: "" })], "STOP")
  );
  assert.deepEqual(JSON.parse(rows[0].choices[0].delta.tool_calls![0].function.arguments), {
    zero: 0,
    nil: null,
    disabled: false,
    empty: "",
  });
  client.finish();
});

test("interleaved native Part order survives the client projection without grafting signatures", () => {
  const client = converter();
  const rows = client.accept(
    frame(
      [
        call("first"),
        { text: "thought", thought: true },
        { thoughtSignature: "standalone-private" },
        { text: "literal" },
        { functionCall: { id: "second", name: "echo", args: {} } },
      ],
      "STOP"
    )
  );
  assert.deepEqual(
    rows.slice(0, -1).map((row) => {
      const delta = row.choices[0].delta;
      return delta.tool_calls?.[0].id ?? delta.reasoning_content ?? delta.content;
    }),
    ["first", "thought", "literal", "second"]
  );
  assert.equal(JSON.stringify(rows).includes("standalone-private"), false);
  client.finish();
});
test("up to 64 declared names are bounded independently of the 32 returned call cap", () => {
  const names = new Set(Array.from({ length: 64 }, (_, index) => `tool_${index}`));
  const client = new GeminiToolClient(MODEL, RESPONSE, names);
  assert.equal(
    client.accept(frame([call("last", "tool_63", {})], "STOP"))[0].choices[0].delta.tool_calls?.[0]
      .function.name,
    "tool_63"
  );
  client.finish();
  names.add("tool_64");
  invalid(() => new GeminiToolClient(MODEL, RESPONSE, names));
});

test("a blocked safety rating without a terminal cannot fabricate completion on usage-only rows", () => {
  const client = converter();
  const rows = client.accept({
    response: { candidates: [{ safetyRatings: [{ blocked: true }] }] },
  });
  assert.deepEqual(rows, []);
  assert.deepEqual(client.accept({ response: { usageMetadata: { promptTokenCount: 1 } } }), []);
  invalid(() => client.finish());
});

const NAMESPACE = "0123456789abcdef0123456789abcdef";
function correlated(namespace = NAMESPACE) {
  return new GeminiToolClient(MODEL, RESPONSE, new Set(["echo"]), namespace);
}
function nativeWithoutId(args: unknown = {}) {
  return {
    functionCall: { name: "echo", args },
    thought: true,
    thoughtSignature: "synthetic-idless-signature",
  };
}
test("absent native ID receives only the trusted gateway correlation ID without mutating the Part", () => {
  const client = correlated();
  const part = nativeWithoutId({ value: "fixture" });
  const original = structuredClone(part);
  const rows = client.accept(frame([part], "STOP"));
  assert.deepEqual(part, original);
  assert.equal(Object.hasOwn(part.functionCall, "id"), false);
  assert.deepEqual(rows[0].choices[0].delta.tool_calls?.[0], {
    index: 0,
    id: `gmc_${NAMESPACE}_0`,
    type: "function",
    function: { name: "echo", arguments: '{"value":"fixture"}' },
  });
  assert.equal(rows.at(-1)?.choices[0].finish_reason, "tool_calls");
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes("synthetic-idless-signature"), false);
  assert.equal(serialized.includes("nativeId"), false);
  assert.equal(serialized.includes("correlationNamespace"), false);
  client.finish();
});
test("ID-less same-name calls have stable occurrence indices across different frame boundaries", () => {
  const parts = [nativeWithoutId({ value: "first" }), nativeWithoutId({ value: "second" })];
  const grouped = correlated();
  const split = correlated();
  const fromGrouped = grouped.accept(frame(parts, "STOP"));
  const fromSplit = [
    ...split.accept(frame([parts[0]])),
    ...split.accept(frame([parts[1]], "STOP")),
  ];
  const calls = (rows: typeof fromGrouped) =>
    rows.flatMap((row) => row.choices[0].delta.tool_calls ?? []);
  assert.deepEqual(calls(fromGrouped), calls(fromSplit));
  assert.deepEqual(
    calls(fromGrouped).map(({ id, index }) => ({ id, index })),
    [
      { id: `gmc_${NAMESPACE}_0`, index: 0 },
      { id: `gmc_${NAMESPACE}_1`, index: 1 },
    ]
  );
  grouped.finish();
  split.finish();
});
test("mixed native and ID-less calls count all occurrences without changing explicit native IDs", () => {
  const client = correlated();
  const rows = client.accept(
    frame([call("native_first"), nativeWithoutId(), call("native_last")], "STOP")
  );
  assert.deepEqual(
    rows
      .flatMap((row) => row.choices[0].delta.tool_calls ?? [])
      .map(({ id, index }) => ({ id, index })),
    [
      { id: "native_first", index: 0 },
      { id: `gmc_${NAMESPACE}_1`, index: 1 },
      { id: "native_last", index: 2 },
    ]
  );
  client.finish();
});
const collisionCases: [string, unknown[]][] = [
  ["explicit before generated", [call(`gmc_${NAMESPACE}_1`), nativeWithoutId()]],
  ["generated before explicit", [nativeWithoutId(), call(`gmc_${NAMESPACE}_0`)]],
];
for (const [name, parts] of collisionCases) {
  test(`resolved client ID collision rejects ${name}`, () => {
    const client = correlated();
    invalid(() => client.accept(frame(parts, "STOP")));
    invalid(() => client.finish());
  });
}
test("native null ID is not treated as absent even with a trusted namespace", () => {
  const client = correlated();
  invalid(() =>
    client.accept(frame([{ functionCall: { id: null, name: "echo", args: {} } }], "STOP"))
  );
});
test("duplicate explicit native IDs still reject in correlated mode", () => {
  const client = correlated();
  client.accept(frame([call("duplicate")]));
  invalid(() => client.accept(frame([call("duplicate")], "STOP")));
});
test("provided namespace is validated even for a response containing only explicit IDs", () => {
  for (const namespace of ["", "PRIVATE-secret", NAMESPACE.toUpperCase(), `${NAMESPACE}0`])
    invalid(() => correlated(namespace));
});
test("namespace identifies only the gateway client call and cannot fabricate a terminal after truncation", () => {
  const client = correlated();
  client.accept(frame([nativeWithoutId()]));
  invalid(() => client.finish());
  invalid(() => client.accept(frame([], "STOP")));
});
