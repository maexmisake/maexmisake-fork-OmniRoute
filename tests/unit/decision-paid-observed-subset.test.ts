import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseSystemOneAnswers,
  validateSystemOneBackendBody,
} from "../../open-sse/services/typesafe/systemOneAnswers.ts";

type SubsetCase = {
  provider: string;
  mode: string;
  request: Record<string, unknown>;
  partialResponse: {
    model: string;
    answers: Record<string, Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  };
};
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/systemone/paid-native-observed-subset.json", import.meta.url),
    "utf8"
  )
) as { kind: string; cases: SubsetCase[] };
assert.equal(fixture.kind, "SYNTHETIC_PARTIAL_OBSERVED_SUBSET");
assert.equal(fixture.cases.length, 9);

// These tests check retained fields only. They are not full provider-response replay.
for (const row of fixture.cases) {
  test(`retained ${row.provider} ${row.mode} subset keeps its evidence limits`, () => {
    assert.deepEqual(validateSystemOneBackendBody(row.provider, row.request), { ok: true });
    assert.equal(Object.hasOwn(row.partialResponse.usage, "cost"), false);
    const parsed = parseSystemOneAnswers(row.partialResponse, row.request);
    if (row.mode === "score") {
      assert.equal(Object.hasOwn(row.partialResponse.answers.smoke, "legend"), false);
      assert.equal(
        parsed.ok,
        false,
        "An incomplete retained subset must not invent a score legend"
      );
      return;
    }
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.model, row.partialResponse.model);
    assert.equal(parsed.usage.inputTokens, row.partialResponse.usage.input_tokens);
    assert.equal(parsed.usage.outputTokens, row.partialResponse.usage.output_tokens);
    assert.equal(parsed.usage.costUsd, null);
    const answer = parsed.answers.smoke;
    assert.equal(answer.type, row.mode);
    if (answer.type === "noul") assert.equal(answer.noul, row.partialResponse.answers.smoke.noul);
    if (answer.type === "choice") {
      assert.equal(answer.choice, row.partialResponse.answers.smoke.choice);
      assert.deepEqual(answer.probabilities, row.partialResponse.answers.smoke.probabilities);
      assert.equal(answer.confidence, row.partialResponse.answers.smoke.confidence);
    }
    if (row.provider === "openrouter") {
      assert.equal(row.request.model, "typesafe/jev-1.14");
      assert.equal(parsed.model, "typesafe/jev-1.14-20261014");
    }
  });
}
