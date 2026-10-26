import assert from "node:assert/strict";
import test from "node:test";
import {
  createGeminiCorrelationNamespace,
  resolveGeminiClientCallId,
  validateGeminiCorrelationNamespace,
} from "../../src/lib/decisionPolicy/geminiToolIdentity.ts";

const attempt = "12345678-1234-4234-8234-123456789abc";
const namespace = "12345678123442348234123456789abc";
function rejects(run: () => unknown) {
  assert.throws(run, /^Error: decision_gemini_tool_identity_invalid$/);
}
test("trusted attempt UUID produces a bounded deterministic namespace without identity metadata", () => {
  assert.equal(createGeminiCorrelationNamespace(attempt), namespace);
  assert.equal(
    createGeminiCorrelationNamespace(attempt),
    createGeminiCorrelationNamespace(attempt)
  );
  assert.notEqual(
    createGeminiCorrelationNamespace("12345678-1234-4234-8234-123456789abd"),
    namespace
  );
});
test("absent native ID gets only a client correlation ID by call occurrence", () => {
  assert.equal(resolveGeminiClientCallId(null, namespace, 0), `gmc_${namespace}_0`);
  assert.equal(resolveGeminiClientCallId(null, namespace, 31), `gmc_${namespace}_31`);
  assert.notEqual(
    resolveGeminiClientCallId(null, namespace, 0),
    resolveGeminiClientCallId(null, namespace, 1)
  );
});
test("explicit native IDs stay exact, including generated-looking IDs", () => {
  assert.equal(resolveGeminiClientCallId("native_call", undefined, 0), "native_call");
  const native = `gmc_${namespace}_0`;
  assert.equal(resolveGeminiClientCallId(native, namespace, 1), native);
});
test("no namespace grants no missing-ID correlation", () => {
  rejects(() => resolveGeminiClientCallId(null, undefined, 0));
});
for (const invalid of [
  "",
  "x".repeat(32),
  namespace.toUpperCase(),
  namespace + "0",
  " " + namespace,
  "private/account",
]) {
  test("malformed namespace cannot be accepted or ignored for explicit calls", () => {
    rejects(() => validateGeminiCorrelationNamespace(invalid));
    rejects(() => resolveGeminiClientCallId("native_call", invalid, 0));
  });
}
for (const invalid of [
  "",
  "source-attempt",
  attempt.toUpperCase(),
  "12345678123442348234123456789abc",
  "12345678-1234-4234-8234-123456789abc\n",
]) {
  test("namespace factory accepts only canonical trusted UUID syntax", () => {
    rejects(() => createGeminiCorrelationNamespace(invalid));
  });
}
for (const ordinal of [-1, 32, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  test("call ordinal is bounded and never numerically coerced", () => {
    rejects(() => resolveGeminiClientCallId(null, namespace, ordinal));
    rejects(() => resolveGeminiClientCallId("native_call", namespace, ordinal));
  });
}
for (const id of ["", "native:unsafe", "private\nvalue"]) {
  test("explicit malformed native IDs cannot become absent or leak into errors", () => {
    rejects(() => resolveGeminiClientCallId(id, namespace, 0));
  });
}
