import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createApiKey } from "../../../src/lib/db/apiKeys.ts";
import { createCombo } from "../../../src/lib/db/combos.ts";
import { createProviderConnection } from "../../../src/lib/db/providers.ts";
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import {
  decisionAuthorityStamp,
  finishDecisionApplication,
  reserveDecisionAttempt,
  settleDecisionAttempt,
  startDecisionAttempt,
  type AttemptIdentity,
} from "../../../src/lib/db/decisionAttempts.ts";
import {
  assertToolContinuationClaim,
  claimToolContinuation,
  issueToolContinuation,
  prepareToolContinuation,
} from "../../../src/lib/db/decisionContinuations.ts";
import { serializeGeminiToolReplay } from "../../../src/lib/decisionPolicy/geminiToolReplay.ts";

const parts = [
  {
    functionCall: { id: "synthetic-call", name: "synthetic_lookup", args: { text: "fixture" } },
    thoughtSignature: "synthetic-private-native-signature",
  },
];
const calls = [{ id: "synthetic-call", name: "synthetic_lookup", arguments: '{"text":"fixture"}' }];
async function fixture() {
  const key = await createApiKey("synthetic-gemini-metadata-key", "synthetic");
  const policy = { enabled: true, applicationMode: "bounded-v1" };
  const combo = await createCombo({
    name: "synthetic-gemini-metadata-" + randomUUID(),
    strategy: "priority",
    models: ["agy/gemini-3.8-flash-high"],
    config: { decisionPolicy: policy },
  });
  const connection = await createProviderConnection({
    provider: "agy",
    authType: "oauth",
    name: "synthetic-gemini-metadata-account",
    accessToken: "synthetic-account-token",
    isActive: true,
    providerSpecificData: { projectId: "synthetic-project" },
  });
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId: key.id,
    comboId: String(combo.id),
    candidateId: "gemini-high",
    provider: "agy",
    model: "gemini-3.8-flash-high",
    connectionId: String(connection.id),
    effort: "high",
    requestedModel: String(combo.name),
    lane: "execution",
  };
  const expectedPolicy = JSON.stringify(policy);
  const expectedAuthority = decisionAuthorityStamp(identity, expectedPolicy);
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  settleDecisionAttempt(identity, { status: 200, input: 2, output: 4, cost: null });
  finishDecisionApplication(identity.id, 200);
  const group = {
    clientPrefixJSON: JSON.stringify([{ role: "user", content: "fixture" }]),
    toolContractJSON: JSON.stringify({ tools: ["synthetic-only"] }),
    calls,
  };
  const proof = {
    ...group,
    expectedPolicy,
    expectedAuthority,
    thinkingBlocksJSON: serializeGeminiToolReplay(parts),
  };
  const request = {
    keyId: key.id,
    comboId: String(combo.id),
    history: [group],
    completedCallIds: ["synthetic-call"],
  };
  return { identity, proof, request };
}
after(resetDbInstance);
test("trusted AGY origin issues provider-tagged MAC metadata without storing native Parts", async () => {
  const f = await fixture();
  const turn = issueToolContinuation(f.identity, f.proof);
  const row = getDbInstance().prepare("SELECT * FROM decision_tool_turns WHERE id=?").get(turn);
  assert.equal(typeof row.thinking_mac, "string");
  assert.ok(!JSON.stringify(row).includes("synthetic-private-native-signature"));
  assert.ok(!JSON.stringify(row).includes("functionCall"));
  const next: AttemptIdentity = { ...f.identity, id: randomUUID(), leaseOwner: undefined };
  claimToolContinuation(f.request, next, { [f.identity.id]: f.proof.thinkingBlocksJSON });
  assertToolContinuationClaim(f.request, next, { [f.identity.id]: f.proof.thinkingBlocksJSON });
});
test("AGY tool metadata cannot be issued with missing or Claude-shaped replay", async () => {
  const f = await fixture();
  assert.throws(() =>
    issueToolContinuation(f.identity, { ...f.proof, thinkingBlocksJSON: undefined })
  );
  assert.throws(() =>
    issueToolContinuation(f.identity, {
      ...f.proof,
      thinkingBlocksJSON: JSON.stringify([
        { type: "thinking", thinking: "fixture", signature: "fixture" },
      ]),
    })
  );
});
test("provider-tagged Gemini replay cannot become a different provider's replay format", async () => {
  const f = await fixture();
  assert.throws(() => issueToolContinuation({ ...f.identity, provider: "claude" }, f.proof));
});
test("changed or missing private Parts cannot claim an issued AGY continuation", async () => {
  const f = await fixture();
  issueToolContinuation(f.identity, f.proof);
  const next: AttemptIdentity = { ...f.identity, id: randomUUID(), leaseOwner: undefined };
  const changed = structuredClone(parts);
  changed[0].thoughtSignature = "synthetic-other-signature";
  assert.throws(() => claimToolContinuation(f.request, next, {}));
  assert.throws(() =>
    claimToolContinuation(f.request, next, { [f.identity.id]: serializeGeminiToolReplay(changed) })
  );
  const prepared = prepareToolContinuation(f.request);
  assert.equal(prepared.binding.provider, "agy");
  assert.equal(prepared.binding.connectionId, f.identity.connectionId);
});
