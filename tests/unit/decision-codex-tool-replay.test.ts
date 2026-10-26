import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { canonicalToolJSON } from "../../open-sse/services/decisionPolicy/toolContract.ts";
import {
  __clearCodexToolReplayForTests,
  assertCodexReplayCalls,
  discardCodexToolReplay,
  parseCodexToolReplay,
  restoreCodexToolReplay,
  storeCodexToolReplay,
} from "../../src/lib/decisionPolicy/codexToolReplay.ts";
const identity = {
  id: "synthetic-origin",
  keyId: "synthetic-key",
  comboId: "synthetic-combo",
  provider: "codex",
  model: "gpt-6-sol",
  connectionId: "synthetic-account",
  effort: "high",
};
const call = {
  type: "function_call",
  id: "fc_synthetic",
  call_id: "call_synthetic",
  name: "synthetic_tool",
  arguments: '{"item":"synthetic"}',
  status: "completed",
};
const reasoning = {
  type: "reasoning",
  id: "rs_synthetic",
  summary: [],
  encrypted_content: "synthetic-original-opaque-reasoning",
};
beforeEach(() => __clearCodexToolReplayForTests());
test("Codex replay preserves original native items and exact scoped identity", () => {
  const items = [reasoning, call];
  const value = storeCodexToolReplay({ ...identity, trace: [] } as typeof identity, items);
  assert.equal(restoreCodexToolReplay(identity), value);
  assert.deepEqual(parseCodexToolReplay(value, identity).items, items);
  assertCodexReplayCalls(value, identity, [
    { id: call.call_id, name: call.name, arguments: call.arguments },
  ]);
  for (const changed of [
    { keyId: "other" },
    { comboId: "other" },
    { connectionId: "other" },
    { effort: "medium" },
    { model: "gpt-5.6-sol" },
  ]) {
    assert.throws(
      () => restoreCodexToolReplay({ ...identity, ...changed }),
      /decision_codex_replay_unavailable/
    );
  }
});
test("Codex replay keeps genuinely absent reasoning absent", () => {
  const value = storeCodexToolReplay(identity, [call]);
  assert.deepEqual(parseCodexToolReplay(value, identity).items, [call]);
});
test("Codex replay cannot reconstruct missing encrypted reasoning from a summary", () => {
  const value = canonicalToolJSON([
    {
      type: "codex-tool-items-v1",
      items: [{ type: "reasoning", id: "rs_synthetic", summary: [] }, call],
    },
  ]);
  assert.throws(() => parseCodexToolReplay(value, identity));
});
test("Codex replay descriptor, canonical envelope and cache loss fail closed", () => {
  const value = storeCodexToolReplay(identity, [reasoning, call]);
  assert.throws(() =>
    assertCodexReplayCalls(value, identity, [
      { id: call.call_id, name: call.name, arguments: '{"item":"changed"}' },
    ])
  );
  assert.throws(() => parseCodexToolReplay(JSON.stringify(JSON.parse(value), null, 2), identity));
  __clearCodexToolReplayForTests();
  assert.throws(() => restoreCodexToolReplay(identity));
});
test("failed publication cleanup can discard only the exact origin-bound private value", () => {
  const value = storeCodexToolReplay(identity, [call]);
  assert.equal(discardCodexToolReplay(identity, "different"), false);
  assert.equal(restoreCodexToolReplay(identity), value);
  assert.equal(discardCodexToolReplay(identity, value), true);
  assert.throws(() => restoreCodexToolReplay(identity));
});
test("expired Codex replay cannot be reused", (context) => {
  storeCodexToolReplay(identity, [call]);
  const later = Date.now() + 31 * 60_000;
  context.mock.method(Date, "now", () => later);
  assert.throws(() => restoreCodexToolReplay(identity));
});
