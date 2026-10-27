import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateSchema } from "../../open-sse/services/decisionPolicy/contract.ts";
import { nativeDecisionClient } from "../../open-sse/services/decisionPolicy/nativeSelector.ts";
import { guidanceDisclosureMatches } from "../../open-sse/services/decisionPolicy/taskContext.ts";
import { readProfiles } from "../../src/app/(dashboard)/dashboard/combos/decision/profileDraftControls.ts";
import { fixtureConfig, fixtureRequest } from "../fixtures/decision-policy/scenarios.ts";

test("operator selection guidance is optional, bounded and separate from capability evidence", () => {
  const profile = fixtureConfig.candidates[0];
  assert.equal(candidateSchema.safeParse(profile).success, true);
  const guided = candidateSchema.safeParse({
    ...profile,
    selectionGuidance:
      "Prefer for short formatting tasks; this is operator preference, not accuracy.",
  });
  assert.equal(guided.success, true);
  assert.equal(
    candidateSchema.safeParse({ ...profile, selectionGuidance: "x".repeat(1001) }).success,
    false
  );
  assert.equal(candidateSchema.safeParse({ ...profile, selectionGuidance: "" }).success, false);
});

const destination = {
  provider: "synthetic",
  model: "synthetic-decision",
  connectionId: "synthetic-connection",
};
const consent = { ...destination, acknowledgeExternalTransmission: true };

test("guidance remains editable while typing spaces; strict save validation stays separate", () => {
  for (const text of ["Prefer ", " "]) {
    const profiles = readProfiles(
      JSON.stringify([{ ...fixtureConfig.candidates[0], selectionGuidance: text }])
    );
    assert.ok(profiles);
    assert.equal(profiles[0].selectionGuidance, text);
  }
  assert.equal(
    candidateSchema.safeParse({ ...fixtureConfig.candidates[0], selectionGuidance: " " }).success,
    false
  );
});

test("guidance consent is exact, destination-bound and explicit", () => {
  assert.equal(guidanceDisclosureMatches(destination, consent), true);
  for (const changed of [
    undefined,
    { ...consent, acknowledgeExternalTransmission: false },
    { ...consent, provider: "other" },
    { ...consent, model: "other" },
    { ...consent, connectionId: "other" },
  ])
    assert.equal(guidanceDisclosureMatches(destination, changed), false);
});

for (const disclosure of [undefined, consent, { ...consent, connectionId: "other" }])
  test(`native guidance requires explicit matching destination consent=${JSON.stringify(disclosure)}`, async () => {
    const candidates = fixtureConfig.candidates.slice(0, 2).map((profile, index) => ({
      ...profile,
      selectionGuidance: index === 0 ? "Synthetic concise transformation preference" : undefined,
    }));
    let criteria: Record<string, string> = {};
    const client = nativeDecisionClient({
      id: "synthetic-guidance",
      ...destination,
      guidanceDisclosure: disclosure,
      call: async (body) => {
        criteria = (body.questions as { route: { criteria: Record<string, string> } }).route
          .criteria;
        return { status: 200, body: { answers: { route: { type: "refusal" } } } };
      },
    });
    await client.select(candidates, fixtureRequest, new AbortController().signal);
    assert.deepEqual(
      Object.keys(criteria),
      candidates.map((row) => row.id)
    );
    const first = JSON.parse(criteria[candidates[0].id]);
    assert.equal(
      first.selectionGuidance,
      disclosure === consent ? candidates[0].selectionGuidance : undefined
    );
    assert.deepEqual(first.effort, {
      mode: candidates[0].effort.mode,
      value: candidates[0].effort.value,
      supported: candidates[0].effort.supported,
    });
    assert.equal(first.model, candidates[0].model);
    assert.equal(first.provider, candidates[0].provider);
    assert.equal(JSON.parse(criteria[candidates[1].id]).selectionGuidance, undefined);
    assert.equal(JSON.stringify(criteria).includes("synthetic-fixture-v1"), false);
  });
