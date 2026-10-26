import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNativeAttemptInspectionQuery,
  projectNativeAttempt,
  projectNativeAttemptPage,
} from "../../src/lib/decisionPolicy/attemptInspection.ts";

const NOW = Date.parse("2026-10-26T22:00:00Z");
const CANARY = "SYNTHETIC_PRIVATE_FIELD_NEVER_RETURN";
const row = () => ({
  id: "fixture-attempt",
  request_id: "fixture-request",
  combo_id: "fixture-combo",
  candidate_id: "deep",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  lane: "execution",
  state: "started",
  created_at: "2026-10-26T21:59:00Z",
  updated_at: "2026-10-26T21:59:01Z",
  lease_expires_at: NOW - 1,
  api_key_id: CANARY,
  connection_id: CANARY,
  lease_owner: CANARY,
  raw_error: CANARY,
  apiKey: CANARY,
});
test("projection preserves unknown versus zero and observes expiry without changing recorded state", () => {
  const source = row();
  const before = JSON.stringify(source);
  const value = projectNativeAttempt(source, NOW);
  assert.equal(value.state, "started");
  assert.equal(value.lease, "expired");
  assert.equal(value.inputTokens, null);
  assert.equal(value.outputTokens, null);
  assert.equal(value.costUsd, null);
  assert.equal(JSON.stringify(source), before);
  assert.ok(!JSON.stringify(value).includes(CANARY));
  const zero = projectNativeAttempt(
    {
      ...source,
      state: "completed",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      application_status: 200,
    },
    NOW
  );
  assert.equal(zero.inputTokens, 0);
  assert.equal(zero.outputTokens, 0);
  assert.equal(zero.costUsd, 0);
  assert.equal(zero.lease, "released");
});
test("reserved occupancy stays reserved on read and is never reported free or cancelled after expiry", () => {
  const source = { ...row(), state: "reserved", lease_expires_at: NOW + 1 };
  assert.equal(projectNativeAttempt(source, NOW).lease, "active");
  const expired = projectNativeAttempt(source, NOW + 2);
  assert.equal(expired.state, "reserved");
  assert.equal(expired.lease, "expired");
  assert.equal(expired.costUsd, null);
  assert.equal(source.state, "reserved");
});
test("decision selection projection drops its private connection binding and rejects unknown trace prose", () => {
  const value = projectNativeAttempt(
    {
      ...row(),
      lane: "decision",
      decision_outcome: "refused",
      selected_binding: JSON.stringify(["deep", "claude", "claude-opus-5-5", "high", CANARY]),
      selection_trace: JSON.stringify([
        { phase: "eligibility", id: "deep", reason: "eligible", body: CANARY },
        { phase: "difficulty", reason: "local_difficulty_difficult", content: CANARY },
        { phase: "preference", reason: "difficulty_scoped_order" },
        { phase: "selection", reason: CANARY },
        { phase: CANARY, reason: "eligible" },
        { phase: "eligibility", id: "sk-proj-synthetic-credential", reason: "eligible" },
      ]),
    },
    NOW
  );
  assert.equal(value.decisionOutcome, "refused");
  assert.deepEqual(value.selected, {
    candidateId: "deep",
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
  });
  assert.equal(value.trace.length, 4);
  assert.equal(value.trace.at(-1)?.candidateId, null);
  assert.ok(!JSON.stringify(value).includes(CANARY));
  assert.ok(!JSON.stringify(value).includes("sk-proj-"));
});
test("malformed stored metrics, model strings, selected data and traces become unavailable metadata", () => {
  const value = projectNativeAttempt(
    {
      ...row(),
      state: CANARY,
      model: "https://private.example.invalid/secret",
      input_tokens: -1,
      output_tokens: "0",
      cost_usd: Number.POSITIVE_INFINITY,
      http_status: 999,
      selected_binding: CANARY,
      selection_trace: "[invalid",
    },
    NOW
  );
  assert.equal(value.state, null);
  assert.equal(value.lease, "unknown");
  assert.equal(value.model, null);
  assert.equal(value.inputTokens, null);
  assert.equal(value.outputTokens, null);
  assert.equal(value.costUsd, null);
  assert.equal(value.httpStatus, null);
  assert.equal(value.selected, null);
  assert.deepEqual(value.trace, []);
});
test("query filters are bounded, canonical and reject duplicate, foreign-key and malformed selectors", () => {
  assert.deepEqual(parseNativeAttemptInspectionQuery(new URLSearchParams()), { limit: 25 });
  assert.deepEqual(
    parseNativeAttemptInspectionQuery(
      new URLSearchParams({
        combo: "fixture-combo",
        limit: "100",
        cursor: "42",
        since: "2026-10-26T10:00:00+02:00",
      })
    ),
    { combo: "fixture-combo", limit: 100, cursor: 42, since: "2026-10-26T08:00:00.000Z" }
  );
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=01",
    "cursor=-1",
    "cursor=9007199254740992",
    "combo=x&combo=y",
    "apiKeyId=foreign-key",
    "since=invalid",
    "combo=../../private",
    "since=2026-10-27T00%3A00%3A00Z&until=2026-10-26T00%3A00%3A00Z",
  ])
    assert.equal(parseNativeAttemptInspectionQuery(new URLSearchParams(query)), null, query);
});
test("trace and page projections stay bounded without inventing cost or exact trace completeness", () => {
  const source = {
    ...row(),
    selection_trace: JSON.stringify(
      Array.from({ length: 40 }, () => ({ phase: "eligibility", reason: "eligible" }))
    ),
  };
  assert.equal(projectNativeAttempt(source, NOW).trace.length, 32);
  const page = projectNativeAttemptPage(
    [
      { ...source, inspection_order: 8 },
      { ...source, inspection_order: 7 },
    ],
    2,
    NOW
  );
  assert.equal(page.rows.length, 2);
  assert.equal(page.nextCursor, "7");
  assert.equal(projectNativeAttemptPage([], 2, NOW).nextCursor, null);
});
