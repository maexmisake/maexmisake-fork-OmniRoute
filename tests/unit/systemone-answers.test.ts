/**
 * System One typed answers (`noul` / `choice` / `score`) and request validation.
 *
 * The decision semantics are the product: a parsed answer must keep the typed
 * value, the calibrated probabilities, the confidence and the usage/cost the
 * upstream reported. Validation rejects malformed envelopes before a credential
 * is spent, and no error message may echo the caller's state or instructions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSystemOneAnswers,
  validateSystemOneRequestBody,
  validateSystemOneBackendBody,
} from "../../open-sse/services/typesafe/systemOneAnswers.ts";

const STATE = "patient record: Jane Doe, 1980-02-02, diagnosed with a secret condition";

function body(overrides: Record<string, unknown> = {}) {
  return {
    model: "openrouter/typesafe/jev-1.13",
    state: STATE,
    questions: {
      urgent: { type: "noul", instructions: "Is this urgent?" },
    },
    ...overrides,
  };
}

test("a noul answer keeps its probability value", () => {
  const result = parseSystemOneAnswers({
    model: "jev-1.13",
    answers: {
      urgent: {
        type: "noul",
        noul: 0.91,
      },
    },
    usage: { input_tokens: 120, output_tokens: 3 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.model, "jev-1.13");
  assert.deepEqual(result.answers.urgent, {
    type: "noul",
    noul: 0.91,
    probabilities: null,
    confidence: null,
  });
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 3, costUsd: null });
});

test("a choice answer keeps the chosen option and its probability distribution", () => {
  const result = parseSystemOneAnswers({
    answers: {
      route: {
        type: "choice",
        choice: "gpt-5",
        probabilities: { "gpt-5": 0.7, "claude-4": 0.3 },
        confidence: 0.66,
      },
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.answers.route, {
    type: "choice",
    choice: "gpt-5",
    probabilities: { "gpt-5": 0.7, "claude-4": 0.3 },
    confidence: 0.66,
  });
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, costUsd: null });
});

test("a score answer keeps its numeric level", () => {
  const result = parseSystemOneAnswers({
    answers: {
      severity: { type: "score", score: 4, probabilities: { "4": 0.5, "5": 0.5 }, confidence: 0.5 },
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.answers.severity.type, "score");
  assert.deepEqual(result.answers.severity, {
    type: "score",
    score: 4,
    probabilities: { "4": 0.5, "5": 0.5 },
    confidence: 0.5,
  });
});

test("several typed questions are answered in one response", () => {
  const result = parseSystemOneAnswers({
    answers: {
      urgent: { type: "noul", noul: 0.1 },
      route: { type: "choice", choice: "a", probabilities: { a: 1 } },
      severity: { type: "score", score: 2 },
    },
    usage: { input_tokens: 10, output_tokens: 1, cost: 0.000042 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.answers).sort(), ["route", "severity", "urgent"]);
  assert.equal(result.usage.costUsd, 0.000042);
  // Optional fields stay explicitly absent instead of being invented.
  assert.equal(result.answers.severity.confidence, null);
  assert.equal(result.answers.severity.probabilities, null);
});

test("a reported zero cost is preserved as a known zero, not as unknown", () => {
  const result = parseSystemOneAnswers({
    answers: { q: { type: "noul", noul: 1 } },
    usage: { input_tokens: 5, output_tokens: 0, cost: 0 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.usage.costUsd, 0);
  assert.equal(result.usage.outputTokens, 0);
});

test("malformed answer bodies are rejected without echoing the request state", () => {
  const cases: unknown[] = [
    null,
    "not json",
    [],
    {},
    { answers: null },
    { answers: [] },
    { answers: {} },
    { answers: { q: { type: "telepathy", noul: 1 } } },
    { answers: { q: { type: "noul" } } },
    { answers: { q: { type: "noul", noul: "yes" } } },
    { answers: { q: { type: "choice", probabilities: { a: 1 } } } },
    { answers: { q: { type: "choice", choice: "   " } } },
    { answers: { q: { type: "score", score: "high" } } },
    { answers: { q: { type: "choice", choice: "a", probabilities: { a: -1 } } } },
    { answers: { q: { type: "noul", noul: 2 } } },
  ];
  for (const payload of cases) {
    const result = parseSystemOneAnswers(payload);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(payload)}`);
    if (result.ok) continue;
    assert.equal(result.reason, "invalid_response");
    assert.ok(result.detail.length > 0);
    assert.doesNotMatch(result.detail, /Jane Doe/);
  }
});

test("a valid request envelope passes validation", () => {
  const result = validateSystemOneRequestBody(body());
  assert.deepEqual(result, { ok: true });
});

test("choice and score questions carry their criteria", () => {
  assert.deepEqual(
    validateSystemOneRequestBody(
      body({
        questions: {
          route: { type: "choice", instructions: "pick", criteria: { a: "A", b: null } },
          severity: { type: "score", instructions: "rate", criteria: ["low", "high"] },
        },
      })
    ),
    { ok: true }
  );
});

test("an invalid request envelope is rejected with a 400 and no state echo", () => {
  const cases: unknown[] = [
    {},
    { model: "", state: "x", questions: { q: { type: "noul" } } },
    { model: "m", state: STATE },
    { model: "m", state: STATE, questions: {} },
    { model: "m", state: STATE, questions: [] },
    { model: "m", state: STATE, questions: { q: {} } },
    { model: "m", state: STATE, questions: { q: { type: "unknown" } } },
    { model: "m", state: STATE, questions: { q: { type: "choice" } } },
    { model: "m", state: STATE, questions: { q: { type: "choice", criteria: {} } } },
    { model: "m", state: STATE, questions: { q: { type: "choice", criteria: [] } } },
    { model: "m", state: STATE, questions: { q: { type: "score", criteria: {} } } },
    { model: "m", state: 42, questions: { q: { type: "noul" } } },
  ];
  for (const payload of cases) {
    const result = validateSystemOneRequestBody(payload);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(payload)}`);
    if (result.ok) continue;
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.message, /Jane Doe/);
  }
});

test("the shared envelope is validated once and the state is never truncated", () => {
  const long = "x".repeat(50_000);
  const result = validateSystemOneRequestBody(body({ state: long }));
  assert.deepEqual(result, { ok: true });
});

test("per-backend limits bound the number of candidates and questions", () => {
  const criteria: Record<string, string> = {};
  for (let index = 0; index < 300; index++) criteria[`option-${index}`] = "x";
  const tooManyChoices = validateSystemOneBackendBody(
    "openrouter",
    body({ questions: { route: { type: "choice", criteria } } })
  );
  assert.equal(tooManyChoices.ok, false);
  if (!tooManyChoices.ok) assert.equal(tooManyChoices.status, 400);

  const tooManyLevels = validateSystemOneBackendBody(
    "opencode-zen",
    body({ questions: { severity: { type: "score", criteria: Array(40).fill("level") } } })
  );
  assert.equal(tooManyLevels.ok, false);

  const questions: Record<string, unknown> = {};
  for (let index = 0; index < 200; index++) questions[`q${index}`] = { type: "noul" };
  const tooManyQuestions = validateSystemOneBackendBody("vercel-ai-gateway", body({ questions }));
  assert.equal(tooManyQuestions.ok, false);
});

test("a request within the backend limits is accepted on every backend", () => {
  for (const provider of ["opencode-zen", "openrouter", "vercel-ai-gateway"]) {
    assert.deepEqual(
      validateSystemOneBackendBody(
        provider,
        body({
          questions: {
            route: { type: "choice", criteria: { a: "A", b: "B" } },
            severity: { type: "score", criteria: ["low", "high"] },
            urgent: { type: "noul" },
          },
        })
      ),
      { ok: true },
      provider
    );
  }
});

test("a backend body that exceeds the backend byte budget is rejected with 413", () => {
  const huge = "y".repeat(3_000_000);
  const result = validateSystemOneBackendBody("openrouter", body({ state: huge }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 413);
    assert.doesNotMatch(result.message, /yyy/);
  }
});
