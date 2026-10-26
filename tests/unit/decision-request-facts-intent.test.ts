import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRequestFacts } from "../../open-sse/services/decisionPolicy/requestFacts.ts";

function facts(text: string) {
  const result = extractRequestFacts(
    {
      model: "synthetic-intent-combo",
      messages: [{ role: "user", content: text }],
      max_tokens: 64,
    },
    { measureContext: () => 1024 }
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Synthetic intent fixture was rejected");
  return result.facts;
}
for (const text of [
  "Write a function that returns the input string.",
  "Create a Python script that prints a greeting.",
  "Implement a cache service with expiry.",
]) {
  test(`explicit coding intent uses the existing coding task without requiring a difficulty keyword: ${text}`, () => {
    assert.equal(facts(text).task, "complex_code");
  });
}
test("equal-size simple and complex code requests retain coding intent with distinct bounded difficulty", () => {
  const simple = "Write a function that returns a string.";
  const complex =
    "Implement a function with nested loops, concurrency, invariant proofs and transactional failure recovery.";
  const width = Math.max(simple.length, complex.length);
  const easy = facts(simple.padEnd(width));
  const hard = facts(complex.padEnd(width));
  assert.equal(easy.task, "complex_code");
  assert.equal(hard.task, "complex_code");
  assert.notEqual(easy.difficulty, hard.difficulty);
  assert.notEqual(easy.state, hard.state);
});
for (const text of [
  "Explain what a function is.",
  "Translate this greeting into French.",
  "Rewrite this paragraph clearly.",
  "Research the documented alternatives.",
]) {
  test(`positive informational intent retains explanation task: ${text}`, () =>
    assert.equal(facts(text).task, "explanation"));
}
for (const text of ["continue", "blue lamp", "Do the thing."]) {
  test(`genuinely underspecified task remains unresolved: ${text}`, () =>
    assert.equal(facts(text).task, "unresolved"));
}
test("task and difficulty metadata never serialize synthetic private text", () => {
  const marker = "synthetic-private-intent-content-must-stay-local";
  const value = facts(`Write a function for ${marker}.`);
  assert.equal(value.state.includes(marker), false);
  assert.equal(value.state.includes("Write a function"), false);
  assert.match(value.state, /local-structure-v1/);
});
