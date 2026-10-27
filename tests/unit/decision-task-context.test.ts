import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRequestFacts } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { requestSchema } from "../../open-sse/services/decisionPolicy/contract.ts";
import { nativeSelectionSchema } from "../../src/shared/decisionPolicy/configuration.ts";

const task = "Compare the latency and consistency tradeoffs of a synthetic two-region cache.";
const body = {
  model: "synthetic-context-combo",
  messages: [
    { role: "system", content: "SYNTHETIC_SYSTEM_CONTEXT_MUST_STAY_LOCAL" },
    { role: "user", content: "SYNTHETIC_OLD_TASK_MUST_STAY_LOCAL" },
    { role: "assistant", content: "SYNTHETIC_ASSISTANT_CONTEXT_MUST_STAY_LOCAL" },
    { role: "user", content: task },
  ],
  max_tokens: 64,
};
const disclosure = {
  mode: "task-text" as const,
  acknowledgeExternalTransmission: true as const,
  maxChars: 2048,
};

test("stored native selection admits only an acknowledged bounded task-text policy", () => {
  const selection = {
    mode: "native",
    provider: "vercel-ai-gateway",
    model: "typesafe-ai/jev",
    connectionId: "synthetic-selector",
    timeoutMs: 1000,
  };
  assert.equal(
    nativeSelectionSchema.safeParse({ ...selection, decisionContext: disclosure }).success,
    true
  );
  assert.equal(
    nativeSelectionSchema.safeParse({
      ...selection,
      decisionContext: { ...disclosure, acknowledgeExternalTransmission: false },
    }).success,
    false
  );
  assert.equal(
    nativeSelectionSchema.safeParse({
      ...selection,
      decisionContext: { ...disclosure, maxChars: 2049 },
    }).success,
    false
  );
});
function state(options: Record<string, unknown> = {}, input: unknown = body) {
  const result = extractRequestFacts(input, { measureContext: () => 128, ...options });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected accepted synthetic context fixture");
  return JSON.parse(result.facts.state);
}

test("operator and client consent disclose only the exact latest user task to native selection", () => {
  const value = state({ decisionContext: disclosure, clientTaskContextConsent: true });
  assert.deepEqual(value.taskContext, { version: "latest-user-v1", text: task });
  assert.ok(!JSON.stringify(value).includes("MUST_STAY_LOCAL"));
});

test("local summary remains the default even when the client alone asks to disclose text", () => {
  const value = state({ clientTaskContextConsent: true });
  assert.equal(value.taskContext, undefined);
  assert.ok(!JSON.stringify(value).includes(task));
});

test("operator acknowledgement without client consent never transmits task text", () => {
  const value = state({ decisionContext: disclosure });
  assert.equal(value.taskContext, undefined);
  assert.ok(!JSON.stringify(value).includes(task));
});

test("task disclosure refuses an oversized task before routing instead of sending a truncated excerpt", () => {
  const result = extractRequestFacts(body, {
    measureContext: () => 128,
    ...{ decisionContext: { ...disclosure, maxChars: 10 }, clientTaskContextConsent: true },
  });
  assert.deepEqual(result, { ok: false, reason: "decision_context_bound_exceeded" });
});

test("missing acknowledgement cannot be used as an internal task-text disclosure shortcut", () => {
  const result = extractRequestFacts(body, {
    measureContext: () => 128,
    ...{ decisionContext: { mode: "task-text", maxChars: 2048 }, clientTaskContextConsent: true },
  });
  assert.deepEqual(result, { ok: false, reason: "decision_context_policy_invalid" });
});

test("text content parts retain their exact order with explicit consent", () => {
  const value = state(
    { decisionContext: disclosure, clientTaskContextConsent: true },
    {
      ...body,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Compare two" },
            { type: "text", text: "synthetic caches." },
          ],
        },
      ],
    }
  );
  assert.deepEqual(value.taskContext, {
    version: "latest-user-v1",
    text: "Compare two\nsynthetic caches.",
  });
});

test("the maximum consented task fits the state contract even with JSON-escaped characters", () => {
  const text = "\u0001".repeat(2048);
  const result = extractRequestFacts(
    { ...body, messages: [{ role: "user", content: text }] },
    { measureContext: () => 128, decisionContext: disclosure, clientTaskContextConsent: true }
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected bounded escaped task");
  assert.equal(requestSchema.safeParse(result.facts).success, true);
  assert.equal(JSON.parse(result.facts.state).taskContext.text, text);
});

test("authenticated tool continuations never disclose the previous user task again", () => {
  const value = state(
    {
      decisionContext: disclosure,
      clientTaskContextConsent: true,
      continuationCandidateId: "synthetic-pin",
    },
    {
      ...body,
      messages: [
        { role: "user", content: task },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "synthetic-call",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "synthetic-call", content: "synthetic result" },
      ],
    }
  );
  assert.equal(value.taskContext, undefined);
  assert.equal(value.continuation, true);
  assert.ok(!JSON.stringify(value).includes(task));
});
