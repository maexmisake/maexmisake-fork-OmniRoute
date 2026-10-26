import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDecisionTextRequest } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
const source = () => ({
  model: "synthetic-text-combo",
  messages: [{ role: "user", content: "Synthetic text only" }],
  stream: false,
  max_tokens: 128,
  reasoning: { effort: "high" },
});
test("explicit text aliases normalize to one exact immutable canonical contract", () => {
  const body = source();
  const initial = JSON.stringify(body);
  Object.freeze(body.reasoning);
  Object.freeze(body.messages[0]);
  Object.freeze(body.messages);
  Object.freeze(body);
  const normalized = normalizeDecisionTextRequest(body);
  assert.ok(normalized);
  assert.equal(normalized.max_completion_tokens, 128);
  assert.equal(normalized.reasoning_effort, "high");
  assert.equal(Object.hasOwn(normalized, "max_tokens"), false);
  assert.equal(Object.hasOwn(normalized, "reasoning"), false);
  assert.equal(JSON.stringify(body), initial);
});
for (const value of [
  0,
  -1,
  1.5,
  "128",
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  1000001,
])
  test(`invalid explicit output reservation ${String(value)} is rejected`, () => {
    assert.equal(normalizeDecisionTextRequest({ ...source(), max_tokens: value }), null);
  });
test("equivalent duplicate carriers preserve meaning; contradictions are rejected", () => {
  const valid = { ...source(), max_completion_tokens: 128, reasoning_effort: "high" };
  assert.ok(normalizeDecisionTextRequest(valid));
  assert.equal(normalizeDecisionTextRequest({ ...valid, max_completion_tokens: 129 }), null);
  assert.equal(normalizeDecisionTextRequest({ ...valid, reasoning_effort: "medium" }), null);
});
for (const reasoning of [
  { enabled: false },
  { effort: "high", enabled: false },
  { effort: "high", unknown: true },
  { effort: "turbo" },
])
  test(`unsupported raw nested reasoning ${JSON.stringify(reasoning)} remains rejected`, () => {
    assert.equal(
      normalizeDecisionTextRequest({ ...source(), reasoning_effort: "high", reasoning }),
      null
    );
  });
test("normalization never evaluates accessor payloads", () => {
  let reads = 0;
  const body = Object.defineProperty(source(), "reasoning", {
    get: () => {
      reads++;
      return { effort: "high" };
    },
    enumerable: true,
  });
  assert.equal(normalizeDecisionTextRequest(body), null);
  assert.equal(reads, 0);
});

test("own symbol controls cannot disappear during text alias normalization", () => {
  const body = { ...source(), [Symbol("synthetic-hidden-control")]: false };
  assert.equal(normalizeDecisionTextRequest(body), null);
});
test("non-enumerable nested controls cannot disappear during text alias normalization", () => {
  const reasoning = Object.defineProperty({ effort: "high" }, "enabled", {
    value: false,
    enumerable: false,
  });
  assert.equal(normalizeDecisionTextRequest({ ...source(), reasoning }), null);
});

test("canonical multipart text is deeply detached from the caller's own data", () => {
  const part = { type: "text", text: "Before synthetic text" };
  const body = { ...source(), messages: [{ role: "user", content: [part] }] };
  const normalized = normalizeDecisionTextRequest(body);
  assert.ok(normalized);
  const content = normalized.messages[0].content;
  assert.ok(Array.isArray(content));
  (content[0] as { text: string }).text = "After synthetic text";
  assert.equal(part.text, "Before synthetic text");
  part.text = "Another caller edit";
  assert.equal((content[0] as { text: string }).text, "After synthetic text");
});
