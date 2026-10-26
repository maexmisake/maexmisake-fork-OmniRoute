import test from "node:test";
import assert from "node:assert/strict";
import {
  BoundedGeminiFrames,
  GEMINI_PROOF_LIMITS,
} from "../../src/lib/decisionPolicy/geminiResponseProof.ts";

const MODEL = "gemini-3.8-flash-high";
const usage = {
  promptTokenCount: 10,
  cachedContentTokenCount: 4,
  candidatesTokenCount: 3,
  thoughtsTokenCount: 2,
  totalTokenCount: 15,
};
function candidate(finishReason?: unknown, extra: Record<string, unknown> = {}) {
  return {
    response: {
      candidates: [
        { content: { role: "model", parts: [{ text: "Synthetic text" }] }, finishReason },
      ],
      ...extra,
    },
  };
}
function proof(raw: unknown[] = [candidate("STOP")]) {
  const value = new BoundedGeminiFrames(MODEL);
  raw.forEach((row) => value.accept(row));
  return value;
}
function rejects(action: () => unknown, code = "(invalid|limit|incomplete)") {
  assert.throws(action, new RegExp(`^Error: decision_gemini_response_${code}$`));
}

test("complete text proof preserves exact model version and counts thoughts once", () => {
  const value = proof([candidate("STOP", { modelVersion: MODEL, usageMetadata: usage })]);
  assert.equal(value.modelVersion, MODEL);
  assert.equal(value.refused, false);
  assert.deepEqual(value.result(), {
    input: 10,
    output: 5,
    reasoning: 2,
    cacheRead: 4,
    cacheCreation: null,
    uncachedInput: 6,
    cost: null,
  });
});
test("optional model version remains unknown, not an inferred model attestation", () => {
  assert.equal(proof().modelVersion, null);
});
test("cumulative usage and a later usage-only row replace counters without double counting", () => {
  const value = proof([
    candidate(undefined, {
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 1 },
    }),
    candidate("STOP"),
    { response: { candidates: [], usageMetadata: usage } },
  ]);
  assert.equal(value.result().output, 5);
  assert.equal(value.result().input, 10);
});
test("an earlier total is not silently reused against a later partial counter snapshot", () => {
  const value = proof([
    candidate(undefined, {
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 1,
        thoughtsTokenCount: 1,
        totalTokenCount: 12,
      },
    }),
    candidate("STOP", { usageMetadata: { candidatesTokenCount: 3, thoughtsTokenCount: 2 } }),
  ]);
  assert.equal(value.result().output, 5);
});
test("partial proof retains processed input/cache but no final output, thoughts or cost", () => {
  const value = proof([candidate(undefined, { usageMetadata: usage })]);
  assert.deepEqual(value.partial(), {
    input: 10,
    output: null,
    reasoning: null,
    cacheRead: 4,
    cacheCreation: null,
    uncachedInput: 6,
    cost: null,
  });
  rejects(() => value.result(), "incomplete");
});
test("missing or null usage never becomes free or zero tokens", () => {
  for (const usageMetadata of [undefined, null]) {
    const value = proof([candidate("STOP", { usageMetadata })]);
    assert.deepEqual(value.result(), {
      input: null,
      output: null,
      reasoning: null,
      cacheRead: null,
      cacheCreation: null,
      uncachedInput: null,
      cost: null,
    });
  }
});
test("genuine token zeros survive, but undocumented USD and credits are never converted", () => {
  const value = proof([
    {
      ...candidate("STOP", {
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          cachedContentTokenCount: 0,
          totalTokenCount: 0,
          toolUsePromptTokenCount: 0,
          cost: 0.05,
        },
      }),
      remainingCredits: [{ amount: "100", type: "GOOGLE_ONE_AI" }],
      consumedCredits: [{ amount: "4" }],
    },
  ]);
  assert.deepEqual(value.result(), {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheCreation: null,
    uncachedInput: 0,
    cost: null,
  });
});
for (const missing of ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount"]) {
  test(`total cannot reconstruct missing ${missing}`, () => {
    const reported: Record<string, unknown> = { ...usage };
    delete reported[missing];
    const result = proof([candidate("STOP", { usageMetadata: reported })]).result();
    assert.equal(result.input, missing === "promptTokenCount" ? null : 10);
    assert.equal(result.output, missing === "promptTokenCount" ? 5 : null);
    assert.equal(result.reasoning, missing === "thoughtsTokenCount" ? null : 2);
  });
}
test("a lone total receipt yields no invented component counts", () => {
  const result = proof([
    candidate("MAX_TOKENS", { usageMetadata: { totalTokenCount: 100 } }),
  ]).result();
  assert.equal(result.input, null);
  assert.equal(result.output, null);
  assert.equal(result.reasoning, null);
  assert.equal(result.cost, null);
});
test("missing cache remains missing and is not added to total prompt tokens", () => {
  const { cachedContentTokenCount: _cache, ...reported } = usage;
  const result = proof([candidate("STOP", { usageMetadata: reported })]).result();
  assert.equal(result.input, 10);
  assert.equal(result.cacheRead, null);
  assert.equal(result.uncachedInput, null);
});
test("known cache is a total lower bound without reconstructing missing prompt tokens", () => {
  const result = proof([
    candidate("STOP", {
      usageMetadata: {
        cachedContentTokenCount: 7,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
        totalTokenCount: 10,
      },
    }),
  ]).result();
  assert.equal(result.input, null);
  assert.equal(result.uncachedInput, null);
  assert.equal(result.cacheRead, 7);
  assert.equal(result.output, 0);
});
test("known cache cannot exceed a freshly reported total when prompt tokens are absent", () => {
  rejects(() =>
    proof([
      candidate("STOP", {
        usageMetadata: {
          cachedContentTokenCount: 7,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
          totalTokenCount: 0,
        },
      }),
    ])
  );
});
test("later fresh totals respect earlier known cache without inventing prompt tokens", () => {
  const value = proof([candidate("STOP", { usageMetadata: { cachedContentTokenCount: 7 } })]);
  rejects(() => value.accept({ response: { usageMetadata: { totalTokenCount: 1 } } }));
  assert.equal(value.partial().cacheRead, 7);
  assert.equal(value.partial().input, null);
  rejects(() => value.result());
});
test("a stale earlier total is not reused against newly reported cache", () => {
  const value = proof([
    candidate(undefined, { usageMetadata: { totalTokenCount: 0 } }),
    candidate("STOP", { usageMetadata: { cachedContentTokenCount: 7 } }),
  ]);
  assert.equal(value.result().cacheRead, 7);
  assert.equal(value.result().input, null);
});
test("nested provider error cannot coexist with successful terminal proof or leak details", () => {
  const value = new BoundedGeminiFrames(MODEL);
  rejects(() =>
    value.accept(candidate("STOP", { error: { code: 403, message: "SYNTHETIC-PRIVATE-ACCOUNT" } }))
  );
  rejects(() => value.result());
});
test("later nested provider error poisons an otherwise terminal proof", () => {
  const value = proof();
  rejects(() => value.accept({ response: { error: { code: 401, message: "SYNTHETIC-PRIVATE" } } }));
  rejects(() => value.result());
});
test("a maximum-token stop is terminal without a follow-on request", () => {
  assert.equal(proof([candidate("MAX_TOKENS")]).refused, false);
  assert.equal(proof([candidate("MAX_TOKENS")]).result().output, null);
});
test("text/thought parts and opaque signatures are validated without retaining private text", () => {
  const raw = {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "SYNTHETIC PRIVATE THOUGHT", thought: true, thoughtSignature: "opaque" },
              { text: "Visible", thought: false },
              { thoughtSignature: "signature-only" },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
  };
  const value = proof([raw]);
  assert.ok(!JSON.stringify(value.result()).includes("PRIVATE"));
  assert.equal(value.refused, false);
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
  test(`candidate ${reason} is a reported refusal, not a successful model choice`, () => {
    const value = proof([candidate(reason, { usageMetadata: usage })]);
    assert.equal(value.refused, true);
    assert.equal(value.result().output, 5);
  });
}
for (const reason of ["SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"]) {
  test(`prompt ${reason} terminates as refused without requiring an invented candidate`, () => {
    const value = proof([
      {
        response: {
          promptFeedback: { blockReason: reason },
          usageMetadata: { promptTokenCount: 2 },
        },
      },
    ]);
    assert.equal(value.refused, true);
    assert.equal(value.result().input, 2);
    assert.equal(value.result().output, null);
  });
}
test("unspecified prompt feedback is not terminal refusal", () => {
  const value = proof([
    { response: { promptFeedback: { blockReason: "BLOCK_REASON_UNSPECIFIED" } } },
  ]);
  assert.equal(value.refused, false);
  rejects(() => value.result(), "incomplete");
});
test("an explicit candidate safety block survives later STOP and false flags", () => {
  const value = proof([
    {
      response: {
        candidates: [{ safetyRatings: [{ blocked: true }], content: { parts: [{ text: "x" }] } }],
      },
    },
    { response: { candidates: [{ finishReason: "STOP", safetyRatings: [{ blocked: false }] }] } },
  ]);
  assert.equal(value.refused, true);
  assert.equal(value.result().cost, null);
});
test("prompt safety block flags are preserved but alone cannot invent terminal evidence", () => {
  const value = proof([{ response: { promptFeedback: { safetyRatings: [{ blocked: true }] } } }]);
  assert.equal(value.refused, true);
  rejects(() => value.result(), "incomplete");
});
test("unblocked safety metadata is not mistaken for refusal", () => {
  const value = proof([
    { response: { candidates: [{ finishReason: "STOP", safetyRatings: [{ blocked: false }] }] } },
  ]);
  assert.equal(value.refused, false);
});
for (const finish of [
  "OTHER",
  "LANGUAGE",
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "CONTINUATION",
  "NEW_REASON",
  ["STOP"],
]) {
  test(`unsupported finish ${JSON.stringify(finish)} is not normalized into success`, () => {
    rejects(() => proof([candidate(finish)]));
  });
}
for (const malformed of [
  null,
  [],
  {},
  { error: { message: "SYNTHETIC PRIVATE ACCOUNT" } },
  { response: [] },
  { response: { modelVersion: "gemini-3.8-flash" } },
  { response: { modelVersion: "" } },
  { response: { candidates: [{ index: "0", finishReason: "STOP" }] } },
  { response: { candidates: [{ index: 1, finishReason: "STOP" }] } },
  { response: { candidates: [{ finishReason: "STOP" }, { finishReason: "STOP" }] } },
  { response: { candidates: [{ content: { role: "user", parts: [{ text: "x" }] } }] } },
  { response: { candidates: [{ content: { parts: [{ functionCall: { name: "run" } }] } }] } },
  { response: { candidates: [{ content: { parts: [{ inlineData: { data: "AA==" } }] } }] } },
  { response: { candidates: [{ content: { parts: [{ text: "x", functionCall: {} }] } }] } },
  { response: { candidates: [{ content: { parts: [{ thought: "true", text: "x" }] } }] } },
  { response: { automaticFunctionCallingHistory: [{ role: "model" }] } },
  { response: { promptFeedback: { blockReason: "ACCOUNT_QUOTA" } } },
]) {
  test("malformed, extra-candidate, wrong-identity and unreviewed capability payloads reject", () => {
    const value = new BoundedGeminiFrames(MODEL);
    rejects(() => value.accept(malformed));
    rejects(() => value.result());
  });
}
for (const invalidUsage of [
  { promptTokenCount: -1 },
  { candidatesTokenCount: 1.5 },
  { thoughtsTokenCount: "2" },
  { thoughtsTokenCount: null },
  { promptTokenCount: Number.MAX_SAFE_INTEGER + 1 },
  { promptTokenCount: 2, cachedContentTokenCount: 3 },
  { toolUsePromptTokenCount: 1 },
  { ...usage, totalTokenCount: 14 },
  { ...usage, totalTokenCount: 16 },
  { promptTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: 1 },
]) {
  test("invalid or contradictory usage cannot become a valid receipt", () => {
    rejects(() => proof([candidate("STOP", { usageMetadata: invalidUsage })]));
  });
}
test("a malformed later chunk does not erase earlier processed input evidence", () => {
  const value = proof([candidate(undefined, { usageMetadata: usage })]);
  rejects(() => value.accept({ response: { usageMetadata: { promptTokenCount: -1 } } }));
  assert.equal(value.partial().input, 10);
  assert.equal(value.partial().cacheRead, 4);
  assert.equal(value.partial().output, null);
  rejects(() => value.result());
});
test("regressing cumulative counters are rejected instead of silently undercounting", () => {
  const value = proof([candidate(undefined, { usageMetadata: { promptTokenCount: 10 } })]);
  rejects(() => value.accept(candidate("STOP", { usageMetadata: { promptTokenCount: 9 } })));
  assert.equal(value.partial().input, 10);
});
test("content, duplicate terminal and prompt blocks after terminal cannot reopen the proof", () => {
  for (const row of [
    candidate(),
    candidate("STOP"),
    { response: { promptFeedback: { blockReason: "SAFETY" } } },
  ]) {
    const value = proof();
    rejects(() => value.accept(row));
    rejects(() => value.result());
  }
});
test("prompt-block cannot be mixed with an emitted candidate", () => {
  const value = proof([candidate()]);
  rejects(() => value.accept({ response: { promptFeedback: { blockReason: "SAFETY" } } }));
});
test("bounded trace/credit metadata does not create terminal or USD evidence", () => {
  const incomplete = proof([{ traceId: "synthetic-id", remainingCredits: [] }]);
  rejects(() => incomplete.result(), "incomplete");
  const value = proof([{ traceId: "synthetic-id", remainingCredits: [] }]);
  value.accept(candidate("STOP"));
  value.accept({ traceId: "synthetic-end", consumedCredits: [{ amount: 1 }] });
  assert.equal(value.result().cost, null);
});
test("caller-attested incomplete EOF cannot be reopened by later content", () => {
  const value = proof([candidate()]);
  rejects(() => value.result(), "incomplete");
  rejects(() => value.accept(candidate("STOP")), "invalid");
});
test("caller-attested EOF seals result; snapshots cannot mutate collector counters", () => {
  const value = proof([candidate("STOP", { usageMetadata: usage })]);
  const first = value.result();
  first.input = 99;
  assert.equal(value.result().input, 10);
  rejects(() => value.accept({ response: { usageMetadata: usage } }));
});
test("per-event and aggregate byte limits are enforced without content in the error", () => {
  rejects(() => proof([candidate(undefined, { extra: "SECRET".repeat(12000) })]), "limit");
  const value = new BoundedGeminiFrames(MODEL);
  const row = { response: { extra: "x".repeat(60000) } };
  for (let i = 0; i < 17; i++) value.accept(row);
  rejects(() => value.accept(row), "limit");
});
test("event and aggregate part counts are bounded", () => {
  const events = new BoundedGeminiFrames(MODEL);
  for (let i = 0; i < GEMINI_PROOF_LIMITS.events; i++) events.accept({ traceId: "x" });
  rejects(() => events.accept({ traceId: "x" }), "limit");
  const parts = new BoundedGeminiFrames(MODEL);
  const row = { response: { candidates: [{ content: { parts: Array(64).fill({ text: "" }) } }] } };
  for (let i = 0; i < GEMINI_PROOF_LIMITS.parts / 64; i++) parts.accept(row);
  rejects(() => parts.accept(row), "limit");
});
test("bad data never appears in public fixed parser errors", () => {
  const secret = "SYNTHETIC-SECRET-NOT-FOR-ERRORS";
  const value = new BoundedGeminiFrames(MODEL);
  try {
    value.accept({
      response: { candidates: [{ content: { parts: [{ functionCall: secret }] } }] },
    });
    assert.fail("Expected bounded parser rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "decision_gemini_response_invalid");
    assert.ok(!error.message.includes(secret));
  }
});
