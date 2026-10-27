import assert from "node:assert/strict";
import { test } from "node:test";
import { completedExecutionRejection } from "../../open-sse/services/decisionPolicy/retryPolicy.ts";
import { boundedDecisionConfigurationSchema } from "../../src/shared/decisionPolicy/configuration.ts";
import { fixtureConfig } from "../fixtures/decision-policy/scenarios.ts";

test("a quota error with reported generated output is not a clean rejection proof", () => {
  for (const usage of [{ completion_tokens: 1 }, { output_tokens: 1 }, { output_tokens: "1" }]) {
    assert.equal(
      completedExecutionRejection(
        429,
        {
          error: { code: "insufficient_quota", scope: "account" },
          usage,
        },
        null
      ),
      null
    );
  }
});
test("expired Retry-After HTTP date is honored as already elapsed", () => {
  const now = Date.parse("2026-10-27T05:00:00Z");
  assert.deepEqual(
    completedExecutionRejection(
      429,
      {
        error: { code: "insufficient_quota", scope: "account" },
      },
      "Tue, 27 Oct 2026 04:59:00 GMT",
      now
    ),
    {
      scope: "account-quota",
      status: 429,
      retryAt: now,
    }
  );
});
test("access denial, unknown scope, malformed body and partial output never authorize rotation", () => {
  for (const [status, body] of [
    [403, { error: { code: "access_denied", scope: "account" } }],
    [429, { error: { code: "quota_exceeded", scope: "provider" } }],
    [429, { error: { code: "rate_limit_exceeded" } }],
    [429, { error: { code: "insufficient_quota" }, choices: [] }],
    [503, { error: "server_error" }],
    [200, { error: { code: "insufficient_quota" } }],
  ] as Array<[number, Record<string, unknown>]>)
    assert.equal(completedExecutionRejection(status, body, null), null);
});
test("malformed Retry-After is not parsed as an unrelated date", () => {
  for (const header of ["-1", "0x10", "tomorrow", "1,2", ""]) {
    assert.equal(
      completedExecutionRejection(
        429,
        {
          error: { code: "insufficient_quota", scope: "account" },
        },
        header
      ),
      null,
      header
    );
  }
});
test("operator validation rejects account-quota transitions to the same connection", () => {
  const config = {
    enabled: true,
    applicationMode: "bounded-v1",
    policy: { ...fixtureConfig, maxDecisionAttempts: 0, maxExecutionAttempts: 2 },
    connections: Object.fromEntries(
      fixtureConfig.candidates.map((candidate) => [candidate.id, "same-account"])
    ),
    retry: { transitions: [{ from: "basic", to: "code_medium", scopes: ["account-quota"] }] },
  };
  assert.equal(boundedDecisionConfigurationSchema.safeParse(config).success, false);
});
test("duplicate model-effort bindings need distinct configured accounts, not duplicate aliases", () => {
  const candidate = fixtureConfig.candidates[0];
  const config = {
    enabled: true,
    applicationMode: "bounded-v1",
    policy: {
      ...fixtureConfig,
      candidates: [candidate, { ...candidate, id: "other-account" }],
      taskOrder: { explanation: [candidate.id, "other-account"] },
      maxDecisionAttempts: 0,
      maxExecutionAttempts: 1,
    },
    connections: { [candidate.id]: "same", "other-account": "same" },
  };
  assert.equal(boundedDecisionConfigurationSchema.safeParse(config).success, false);
  config.connections["other-account"] = "different";
  assert.equal(boundedDecisionConfigurationSchema.safeParse(config).success, true);
});
test("known native Claude and Codex rejection types keep their distinct account scopes", () => {
  const now = 1000;
  for (const [provider, type, scope] of [
    ["claude", "rate_limit_error", "account-rate-limit"],
    ["codex", "usage_limit_reached", "account-quota"],
  ]) {
    assert.deepEqual(completedExecutionRejection(429, { error: { type } }, null, now, provider), {
      scope,
      status: 429,
      retryAt: now,
    });
    assert.equal(
      completedExecutionRejection(429, { error: { type, scope: "provider" } }, null, now, provider),
      null
    );
    assert.equal(completedExecutionRejection(403, { error: { type } }, null, now, provider), null);
    assert.equal(
      completedExecutionRejection(429, { error: { type } }, null, now, "unknown-provider"),
      null
    );
  }
});
