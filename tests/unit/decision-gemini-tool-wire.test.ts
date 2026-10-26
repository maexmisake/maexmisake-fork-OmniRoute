import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeDecisionTextRequest,
  type ChatPolicyBody,
} from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../open-sse/config/constants.ts";
import {
  buildGeminiToolWire,
  assertGeminiToolWire,
  supportsGeminiToolRequest,
  type GeminiToolJson,
} from "../../src/lib/decisionPolicy/geminiToolWire.ts";
const model = "gemini-3.8-flash-high",
  project = "synthetic-project";
const tool = {
  type: "function",
  function: {
    name: "echo",
    description: "Synthetic echo",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Exact fixture" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
};
function request(patch: Record<string, unknown> = {}): ChatPolicyBody {
  const result = normalizeDecisionTextRequest({
    model: "synthetic-combo",
    stream: true,
    max_tokens: 32,
    reasoning_effort: "high",
    messages: [{ role: "user", content: "Synthetic task" }],
    tools: [tool],
    ...patch,
  });
  assert.ok(result);
  return result;
}
const call = (id: string, text = "x") => ({
  id,
  type: "function",
  function: { name: "echo", arguments: JSON.stringify({ text }) },
});
const native = (id: string, text = "x", signed = true) => ({
  functionCall: { id, name: "echo", args: { text } },
  ...(signed ? { thoughtSignature: "synthetic-opaque-signature" } : {}),
});
function continuation() {
  const body = request({
    messages: [
      { role: "user", content: "Synthetic task" },
      {
        role: "assistant",
        content: "Before tools",
        tool_calls: [call("native_1"), call("native_2", "y")],
      },
      { role: "tool", tool_call_id: "native_1", content: '{"looks":"json"}' },
      { role: "tool", tool_call_id: "native_2", content: "plain result" },
    ],
  });
  const parts = [{ text: "Before tools" }, native("native_1"), native("native_2", "y", false)];
  return { body, parts, replay: new Map<number, readonly GeminiToolJson[]>([[1, parts]]) };
}
const wire = (
  body = request(),
  replay: ReadonlyMap<number, readonly GeminiToolJson[]> = new Map()
) => buildGeminiToolWire(body, model, project, replay);
function nativeRequest(value: GeminiToolJson): GeminiToolJson {
  return value.request as GeminiToolJson;
}
test("first turn preserves JSON Schema and documented native controls without conversion", () => {
  const body = request();
  assert.equal(supportsGeminiToolRequest(body), true);
  const result = wire(body),
    req = nativeRequest(result);
  assert.deepEqual(result.model, model);
  assert.equal(result.project, project);
  assert.deepEqual(req.contents, [{ role: "user", parts: [{ text: "Synthetic task" }] }]);
  assert.deepEqual(req.tools, [
    {
      functionDeclarations: [
        {
          name: "echo",
          description: "Synthetic echo",
          parametersJsonSchema: tool.function.parameters,
        },
      ],
    },
  ]);
  assert.deepEqual(req.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
  assert.deepEqual(req.generationConfig, {
    maxOutputTokens: 32,
    thinkingConfig: { thinkingLevel: "high" },
    topK: 40,
    topP: 1,
  });
  assert.deepEqual(req.systemInstruction, {
    role: "system",
    parts: [{ text: ANTIGRAVITY_DEFAULT_SYSTEM }],
  });
});
for (const choice of ["auto", "none"] as const)
  test(`maps explicit ${choice} without enabling auto execution`, () => {
    assert.deepEqual(nativeRequest(wire(request({ tool_choice: choice }))).toolConfig, {
      functionCallingConfig: { mode: choice === "auto" ? "AUTO" : "NONE" },
    });
  });
test("parallel true is permitted but parallel false is unsupported", () => {
  assert.equal(supportsGeminiToolRequest(request({ parallel_tool_calls: true })), true);
  assert.equal(supportsGeminiToolRequest(request({ parallel_tool_calls: false })), false);
  assert.throws(() => wire(request({ parallel_tool_calls: false })));
});
test("tool continuation replays original ordered Parts then all matching responses preserving strings", () => {
  const { body, parts, replay } = continuation();
  const value = wire(body, replay);
  const contents = nativeRequest(value).contents as GeminiToolJson[];
  assert.deepEqual(contents[1], { role: "model", parts });
  assert.deepEqual(contents[2], {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "native_1",
          name: "echo",
          response: { output: '{"looks":"json"}' },
        },
      },
      { functionResponse: { id: "native_2", name: "echo", response: { output: "plain result" } } },
    ],
  });
  assert.equal((contents[1].parts as GeminiToolJson[])[2].thoughtSignature, undefined);
  assertGeminiToolWire(value, wire(body, replay));
});
test("interleaved text and standalone empty signature Parts retain original placement", () => {
  const { body, replay } = continuation();
  body.messages[1].content = "Before tools after";
  const parts = [
    { text: "Before tools" },
    native("native_1"),
    { text: " after" },
    { text: "", thoughtSignature: "synthetic-standalone" },
    native("native_2", "y", false),
  ];
  replay.set(1, parts);
  assert.deepEqual((nativeRequest(wire(body, replay)).contents as GeminiToolJson[])[1], {
    role: "model",
    parts,
  });
});
test("client result order does not alter original native call response order", () => {
  const { body, replay } = continuation();
  [body.messages[2], body.messages[3]] = [body.messages[3], body.messages[2]];
  const parts = (nativeRequest(wire(body, replay)).contents as GeminiToolJson[])[2]
    .parts as GeminiToolJson[];
  assert.deepEqual(
    parts.map((part) => (part.functionResponse as GeminiToolJson).id),
    ["native_1", "native_2"]
  );
});
test("returned wire is detached from client schemas and native replay Parts", () => {
  const { body, parts, replay } = continuation();
  const original = structuredClone(body),
    originalParts = structuredClone(parts);
  const result = wire(body, replay);
  const contents = nativeRequest(result).contents as GeminiToolJson[];
  (contents[1].parts as GeminiToolJson[])[0].text = "changed";
  assert.deepEqual(body, original);
  assert.deepEqual(parts, originalParts);
});
test("system relocation and mixed text history retain existing text subset semantics", () => {
  const body = request({
    tools: [],
    messages: [
      { role: "system", content: "system fixture" },
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: "previous" },
      { role: "user", content: "last" },
    ],
  });
  const req = nativeRequest(wire(body));
  assert.equal(req.tools, undefined);
  assert.equal(req.toolConfig, undefined);
  assert.deepEqual(req.contents, [
    { role: "user", parts: [{ text: "system fixture" }, { text: "first" }] },
    { role: "model", parts: [{ text: "previous" }] },
    { role: "user", parts: [{ text: "last" }] },
  ]);
});
for (const change of [
  "missing",
  "extra",
  "wrong-id",
  "wrong-name",
  "wrong-args",
  "missing-signature",
  "sentinel",
  "text",
  "fragment",
  "media",
])
  test(`rejects replay ${change} without any repair or signature graft`, () => {
    const { body, replay } = continuation();
    const parts = structuredClone(replay.get(1)!) as GeminiToolJson[];
    const fn = () => parts[1].functionCall as GeminiToolJson;
    if (change === "missing") replay.delete(1);
    else {
      if (change === "extra") replay.set(3, []);
      if (change === "wrong-id") fn().id = "unknown";
      if (change === "wrong-name") fn().name = "other";
      if (change === "wrong-args") fn().args = { text: "changed" };
      if (change === "missing-signature") delete parts[1].thoughtSignature;
      if (change === "sentinel") parts[1].thoughtSignature = "skip_thought_signature_validator";
      if (change === "text") parts[0].text = "changed";
      if (change === "text-after-call") parts.push({ text: "later" });
      if (change === "fragment") fn().partialArgs = [];
      if (change === "media")
        parts.push({ inlineData: { data: "synthetic", mimeType: "image/png" } });
      replay.set(1, parts);
    }
    assert.throws(() => wire(body, replay));
  });
for (const change of [
  "unknown-result",
  "duplicate-result",
  "missing-result",
  "wrong-result-name",
  "result-object",
  "unknown-tool",
  "duplicate-call",
])
  test(`rejects malformed client ${change}`, () => {
    const { body, replay } = continuation();
    if (change === "unknown-result") body.messages[2].tool_call_id = "unknown";
    if (change === "duplicate-result") body.messages[3].tool_call_id = "native_1";
    if (change === "missing-result") body.messages.pop();
    if (change === "wrong-result-name") body.messages[2].name = "other";
    if (change === "result-object") body.messages[2].content = null;
    if (change === "unknown-tool") body.messages[1].tool_calls![0].function.name = "other";
    if (change === "duplicate-call") body.messages[1].tool_calls![1].id = "native_1";
    assert.equal(supportsGeminiToolRequest(body), false);
    assert.throws(() => wire(body, replay));
  });
for (const patch of [
  { stream: false },
  { max_tokens: 65537 },
  { reasoning_effort: "medium" },
  { tools: [{ ...tool, function: { ...tool.function, strict: true } }] },
])
  test(`rejects unsupported request controls ${JSON.stringify(patch).slice(0, 60)}`, () => {
    const body = request(patch);
    assert.equal(supportsGeminiToolRequest(body), false);
    assert.throws(() => wire(body));
  });
for (const change of ["cap", "effort", "call", "signature", "schema", "result"])
  test(`final validator rejects changed ${change}`, () => {
    const { body, replay } = continuation();
    const expected = wire(body, replay),
      actual = structuredClone(expected);
    const req = nativeRequest(actual),
      contents = req.contents as GeminiToolJson[];
    if (change === "cap") (req.generationConfig as GeminiToolJson).maxOutputTokens = 33;
    if (change === "effort")
      ((req.generationConfig as GeminiToolJson).thinkingConfig as GeminiToolJson).thinkingLevel =
        "low";
    if (change === "call")
      ((contents[1].parts as GeminiToolJson[])[1].functionCall as GeminiToolJson).id = "wrong";
    if (change === "signature")
      (contents[1].parts as GeminiToolJson[])[1].thoughtSignature = "other";
    if (change === "schema") req.tools = [];
    if (change === "result") (contents[2].parts as GeminiToolJson[]).reverse();
    assert.throws(() => assertGeminiToolWire(actual, expected));
  });

test("required, forced, strict:false, and unsupported identities remain rejected", () => {
  for (const tool_choice of ["required", { type: "function", function: { name: "echo" } }]) {
    const body = { ...request(), tool_choice } as unknown as ChatPolicyBody;
    assert.equal(supportsGeminiToolRequest(body), false);
    assert.throws(() => wire(body));
  }
  const strict = request({ tools: [{ ...tool, function: { ...tool.function, strict: false } }] });
  assert.equal(supportsGeminiToolRequest(strict), false);
  assert.throws(() => buildGeminiToolWire(request(), "gemini-3.8-flash", project, new Map()));
  for (const bad of ["", "__REQUIRES_GCP_PROJECT__", "project/unsafe", 123])
    assert.throws(() => buildGeminiToolWire(request(), model, bad as string, new Map()));
});
test("historical native ID reuse is bound to each assistant occurrence", () => {
  const { body, replay } = continuation();
  body.messages.push(
    { role: "assistant", content: null, tool_calls: [call("native_1", "new")] },
    { role: "tool", tool_call_id: "native_1", content: "new result" }
  );
  const lastParts = [native("native_1", "new")];
  replay.set(4, lastParts);
  const contents = nativeRequest(wire(body, replay)).contents as GeminiToolJson[];
  assert.deepEqual(contents[3], { role: "model", parts: lastParts });
  assert.deepEqual(contents[4], {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "native_1",
          name: "echo",
          response: { output: "new result" },
        },
      },
    ],
  });
});
test("request predicate rejects a leading emitted model turn before any selection", () => {
  for (const messages of [
    [
      { role: "assistant", content: "prior model" },
      { role: "user", content: "last" },
    ],
    [
      { role: "user", content: [] },
      { role: "assistant", content: "prior model" },
      { role: "user", content: "last" },
    ],
  ]) {
    const body = request({ messages });
    assert.equal(supportsGeminiToolRequest(body), false);
    assert.throws(() => wire(body));
  }
});
test("empty leading assistant content does not invent a native model turn", () => {
  const body = request({
    messages: [
      { role: "assistant", content: "" },
      { role: "user", content: "last" },
    ],
  });
  assert.equal(supportsGeminiToolRequest(body), true);
  assert.deepEqual(nativeRequest(wire(body)).contents, [
    { role: "user", parts: [{ text: "last" }] },
  ]);
});

test("aggregate replay metadata is rejected before oversized provider Parts are cloned", () => {
  const { body, replay } = continuation();
  replay.set(1, [
    { text: "private thought fixture", thought: true, thoughtSignature: "s".repeat(262144) },
    { text: "Before tools" },
    native("native_1"),
    native("native_2", "y", false),
  ]);
  const original = globalThis.structuredClone;
  let oversizedClone = 0;
  globalThis.structuredClone = function (value, options) {
    if (JSON.stringify(value).length > 262144) oversizedClone++;
    return original(value, options);
  };
  try {
    assert.throws(() => wire(body, replay), /decision_gemini_tool_wire_unsupported/);
    assert.equal(oversizedClone, 0);
  } finally {
    globalThis.structuredClone = original;
  }
});
test("signed native tool group retains its own Content boundary after a prior model turn", () => {
  const { body, parts } = continuation();
  body.messages.splice(1, 0, { role: "assistant", content: "Earlier separate model content" });
  const replay = new Map<number, readonly GeminiToolJson[]>([[2, parts]]);
  const contents = nativeRequest(wire(body, replay)).contents as GeminiToolJson[];
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [{ text: "Earlier separate model content" }],
  });
  assert.deepEqual(contents[2], { role: "model", parts });
  assert.deepEqual(
    (contents[3].parts as GeminiToolJson[]).map(
      (part) => (part.functionResponse as GeminiToolJson).id
    ),
    ["native_1", "native_2"]
  );
});
for (const active of [false, true]) {
  test(`prior closed tool cycles before a new user are screened before selection (new active=${active})`, () => {
    const { body, replay } = continuation();
    body.messages.push({ role: "user", content: "New user task" });
    if (active) {
      body.messages.push(
        { role: "assistant", content: null, tool_calls: [call("native_3", "new")] },
        { role: "tool", tool_call_id: "native_3", content: "new result" }
      );
      replay.set(5, [native("native_3", "new")]);
    }
    assert.equal(supportsGeminiToolRequest(body), false);
    assert.throws(() => wire(body, replay));
  });
}
