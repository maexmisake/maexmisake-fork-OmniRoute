import { createHash, randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import {
  decisionAuthorityStamp,
  finishDecisionApplicationWithMetadata,
  readDecisionAttemptReceipt,
  type AttemptIdentity,
} from "./decisionAttempts";

type Row = Record<string, unknown>;
export type SessionBinding = Pick<
  AttemptIdentity,
  "candidateId" | "provider" | "model" | "connectionId" | "effort"
>;
export type SessionClaim = {
  id: string;
  owner: string;
  keyId: string;
  comboId: string;
  binding: SessionBinding | null;
  stableTurns: number;
  policy: string;
  expectedAuthority?: string;
  pinnedAuthority?: string;
};
export type SessionPolicy = {
  idleTtlMs: number;
  maxTurns: number;
  minStableTurns: number;
  maxActiveSessions: number;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (): never => {
  throw new Error("decision_session_rejected");
};
export function sessionAuthority(
  binding: SessionBinding,
  keyId: string,
  comboId: string,
  policy: string
) {
  const snapshot = JSON.parse(
    decisionAuthorityStamp({ ...binding, keyId, comboId, id: "" }, policy)
  );
  // Runtime health observations change after ordinary successful requests. All credential,
  // connection, policy and key authority fields remain bound; dispatch uses the full fresh fence.
  if (snapshot[1]?.provider_specific_data) {
    const data = JSON.parse(snapshot[1].provider_specific_data);
    delete data.apiKeyHealth;
    snapshot[1].provider_specific_data = JSON.stringify(data);
  }
  return digest(JSON.stringify(snapshot));
}
function owned(claim: SessionClaim): Row {
  const row = getDbInstance()
    .prepare("SELECT * FROM decision_routing_sessions WHERE id=?")
    .get(claim.id) as Row | undefined;
  if (
    !row ||
    row.api_key_id !== claim.keyId ||
    row.combo_id !== claim.comboId ||
    row.state !== "claimed" ||
    row.lease_owner !== claim.owner ||
    Number(row.lease_expires_at) <= Date.now() ||
    row.policy_hash !== digest(claim.policy)
  )
    fail();
  return row!;
}
export function claimRoutingSession(input: {
  locator: string;
  keyId: string;
  comboId: string;
  policy: string;
  limits: SessionPolicy;
  timeoutMs: number;
}): SessionClaim {
  const db = getDbInstance();
  let result: SessionClaim | undefined;
  db.immediate(() => {
    const now = Date.now(),
      owner = randomUUID();
    let row: Row;
    if (input.locator === "new") {
      db.prepare(
        "DELETE FROM decision_routing_sessions WHERE api_key_id=? AND combo_id=? AND expires_at<=? AND (state!='claimed' OR lease_expires_at<=?)"
      ).run(input.keyId, input.comboId, now, now);
      const count = db
        .prepare(
          "SELECT COUNT(*) AS n FROM decision_routing_sessions WHERE api_key_id=? AND combo_id=? AND (expires_at>? OR (state='claimed' AND lease_expires_at>?))"
        )
        .get(input.keyId, input.comboId, now, now) as { n: number };
      if (count.n >= input.limits.maxActiveSessions) fail();
      const id = randomUUID();
      db.prepare(
        "INSERT INTO decision_routing_sessions(id,api_key_id,combo_id,policy_hash,state,expires_at) VALUES(?,?,?,?,'idle',?)"
      ).run(id, input.keyId, input.comboId, digest(input.policy), now + input.limits.idleTtlMs);
      row = db.prepare("SELECT * FROM decision_routing_sessions WHERE id=?").get(id) as Row;
    } else {
      const found = db
        .prepare(
          "SELECT * FROM decision_routing_sessions WHERE id=? AND api_key_id=? AND combo_id=?"
        )
        .get(input.locator, input.keyId, input.comboId) as Row | undefined;
      if (
        !found ||
        found.state !== "idle" ||
        Number(found.expires_at) <= now ||
        found.policy_hash !== digest(input.policy) ||
        Number(found.turns) >= input.limits.maxTurns
      )
        fail();
      row = found!;
    }
    const binding = row.binding_json
      ? (JSON.parse(String(row.binding_json)) as SessionBinding)
      : null;
    if (
      binding &&
      row.authority_hash !== sessionAuthority(binding, input.keyId, input.comboId, input.policy)
    )
      fail();
    db.prepare(
      "UPDATE decision_routing_sessions SET state='claimed',lease_owner=?,lease_expires_at=?,attempt_id=NULL WHERE id=?"
    ).run(owner, now + input.timeoutMs + 5000, row.id);
    result = {
      id: String(row.id),
      owner,
      keyId: input.keyId,
      comboId: input.comboId,
      binding,
      stableTurns: Number(row.stable_turns),
      policy: input.policy,
      pinnedAuthority: binding ? String(row.authority_hash) : undefined,
    };
  });
  if (!result) fail();
  return result!;
}
export function attachRoutingSession(claim: SessionClaim, attempt: AttemptIdentity): void {
  getDbInstance().immediate(() => {
    owned(claim);
    assertPinnedAuthority(claim);
    if (attempt.keyId !== claim.keyId || attempt.comboId !== claim.comboId) fail();
    claim.expectedAuthority = sessionAuthority(attempt, claim.keyId, claim.comboId, claim.policy);
    getDbInstance()
      .prepare("UPDATE decision_routing_sessions SET attempt_id=? WHERE id=?")
      .run(attempt.id, claim.id);
  });
}
function assertPinnedAuthority(claim: SessionClaim): void {
  if (
    claim.binding &&
    claim.pinnedAuthority !==
      sessionAuthority(claim.binding, claim.keyId, claim.comboId, claim.policy)
  )
    fail();
}
export function assertRoutingSession(claim: SessionClaim): void {
  owned(claim);
  assertPinnedAuthority(claim);
}
export function completeRoutingSession(
  claim: SessionClaim,
  attempt: AttemptIdentity,
  limits: SessionPolicy,
  publish?: () => void
): void {
  finishDecisionApplicationWithMetadata(attempt, () => {
    const row = owned(claim);
    assertPinnedAuthority(claim);
    if (row.attempt_id !== attempt.id) fail();
    const binding: SessionBinding = {
      candidateId: attempt.candidateId,
      provider: attempt.provider,
      model: attempt.model,
      connectionId: attempt.connectionId,
      effort: attempt.effort,
    };
    const same = row.binding_json === JSON.stringify(binding);
    const authority = sessionAuthority(binding, claim.keyId, claim.comboId, claim.policy);
    if (!claim.expectedAuthority || authority !== claim.expectedAuthority) fail();
    getDbInstance()
      .prepare(
        "UPDATE decision_routing_sessions SET binding_json=?,authority_hash=?,turns=turns+1,stable_turns=?,state='idle',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,expires_at=? WHERE id=?"
      )
      .run(
        JSON.stringify(binding),
        authority,
        same ? Number(row.stable_turns) + 1 : 1,
        Date.now() + limits.idleTtlMs,
        claim.id
      );
    publish?.();
  });
}
export function releaseRoutingSession(claim: SessionClaim): void {
  const db = getDbInstance();
  db.immediate(() => {
    const row = db
      .prepare(
        "SELECT * FROM decision_routing_sessions WHERE id=? AND lease_owner=? AND state='claimed'"
      )
      .get(claim.id, claim.owner) as Row | undefined;
    if (!row) return;
    const receipt = row.attempt_id ? readDecisionAttemptReceipt(String(row.attempt_id)) : null;
    const safe = !receipt || receipt.state === "reserved" || receipt.state === "cancelled";
    if (safe && !row.binding_json) {
      db.prepare("DELETE FROM decision_routing_sessions WHERE id=?").run(claim.id);
      return;
    }
    db.prepare(
      "UPDATE decision_routing_sessions SET state=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?"
    ).run(safe && row.binding_json ? "idle" : "unknown", claim.id);
  });
}
