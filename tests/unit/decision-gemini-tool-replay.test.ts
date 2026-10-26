import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  __clearGeminiToolReplayForTests,
  parseGeminiToolReplay,
  restoreGeminiToolReplay,
  serializeGeminiToolReplay,
  storeGeminiToolReplay,
  discardGeminiToolReplay,
} from "../../src/lib/decisionPolicy/geminiToolReplay.ts";

const identity = {
  id: "synthetic-source",
  keyId: "synthetic-key",
  comboId: "synthetic-combo",
  provider: "agy",
  model: "gemini-3.8-flash-high",
  connectionId: "synthetic-account",
  effort: "high",
};
function parts() {
  return [
    { text: "Synthetic thought", thought: true, thoughtSignature: "synthetic-text-signature" },
    {
      functionCall: { id: "synthetic-call", name: "synthetic_lookup", args: { value: "fixture" } },
      thoughtSignature: "synthetic-call-signature",
    },
    { text: "After the call", thoughtSignature: "synthetic-separate-part-signature" },
    { functionCall: { id: "synthetic-second", name: "synthetic_lookup", args: {} } },
  ];
}
beforeEach(__clearGeminiToolReplayForTests);
afterEach(__clearGeminiToolReplayForTests);
test("versioned replay preserves the exact ordered signed Parts without signature grafting", () => {
  const value = serializeGeminiToolReplay(parts());
  assert.deepEqual(parseGeminiToolReplay(value), parts());
  assert.equal(parseGeminiToolReplay(value)[3].thoughtSignature, undefined);
});
test("private replay snapshots survive source mutations and ignore unrelated phase fields", () => {
  const source = parts();
  const value = storeGeminiToolReplay(
    { ...identity, ...{ trace: "synthetic-only-phase" } },
    source
  );
  source[0].text = "changed";
  assert.equal(restoreGeminiToolReplay(identity), value);
  const restored = parseGeminiToolReplay(value);
  restored[0].thoughtSignature = "changed";
  assert.equal(restoreGeminiToolReplay(identity), value);
});
for (const field of ["id", "keyId", "comboId", "connectionId", "provider", "model", "effort"]) {
  test(`private replay never crosses its original ${field}`, () => {
    storeGeminiToolReplay(identity, parts());
    assert.throws(() => restoreGeminiToolReplay({ ...identity, [field]: "synthetic-other" }));
    assert.doesNotThrow(() => restoreGeminiToolReplay(identity));
  });
}
test("cache loss rejects rather than rebuilding signed parts from the client or an ID", () => {
  storeGeminiToolReplay(identity, parts());
  __clearGeminiToolReplayForTests();
  assert.throws(() => restoreGeminiToolReplay(identity), /decision_gemini_replay_unavailable/);
});
test("duplicate source storage cannot replace an already retained signed group", () => {
  const value = storeGeminiToolReplay(identity, parts());
  assert.throws(() => storeGeminiToolReplay(identity, parts()));
  assert.equal(restoreGeminiToolReplay(identity), value);
});
test("failed publication discards only its own exact newly stored value", () => {
  const value = storeGeminiToolReplay(identity, parts());
  assert.equal(
    discardGeminiToolReplay({ ...identity, keyId: "synthetic-foreign-key" }, value),
    false
  );
  assert.equal(discardGeminiToolReplay(identity, value + " "), false);
  assert.equal(restoreGeminiToolReplay(identity), value);
  assert.equal(discardGeminiToolReplay(identity, value), true);
  assert.throws(() => restoreGeminiToolReplay(identity));
});
test("source capacity rejects new publication without evicting an existing continuation", () => {
  for (let index = 0; index < 128; index++)
    storeGeminiToolReplay({ ...identity, id: `synthetic-${index}` }, parts());
  assert.throws(() => storeGeminiToolReplay({ ...identity, id: "synthetic-overflow" }, parts()));
  assert.doesNotThrow(() => restoreGeminiToolReplay({ ...identity, id: "synthetic-0" }));
});
test("expired memory is unavailable and its bounded capacity can be reclaimed", () => {
  const original = Date.now;
  const now = original();
  try {
    Date.now = () => now;
    storeGeminiToolReplay(identity, parts());
    Date.now = () => now + 30 * 60_000 + 1;
    assert.throws(() => restoreGeminiToolReplay(identity));
    assert.doesNotThrow(() => storeGeminiToolReplay(identity, parts()));
  } finally {
    Date.now = original;
  }
});
for (const value of [
  "[]",
  '[{"type":"gemini-tool-parts-v1","parts":[]}]',
  '[{"type":"thinking","thinking":"synthetic","signature":"synthetic"}]',
  '[{"type":"gemini-tool-parts-v2","parts":[]}]',
  '[{"type":"gemini-tool-parts-v1","parts":[],"extra":true}]',
]) {
  test(`unproven, empty or foreign replay format is rejected: ${value}`, () => {
    assert.throws(() => parseGeminiToolReplay(value));
  });
}
