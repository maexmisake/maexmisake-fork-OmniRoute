import { createHash } from "node:crypto";
import { getDbInstance } from "./core";
import { encrypt, decrypt, isEncryptionEnabled } from "./encryption";
import {
  sessionAuthority,
  assertRoutingSession,
  type SessionBinding,
  type SessionClaim,
} from "./decisionSessions";
import { readDecisionAttemptReceipt, type AttemptIdentity } from "./decisionAttempts";

type Row = Record<string, unknown>;
export type ResponseHistoryLimits = { ttlMs: number; maxStoredResponses: number };
export type ResponseHistoryOrigin = {
  id: string;
  snapshot: string;
  sessionId: string;
  binding: SessionBinding;
  messages: unknown[];
};
export type ResponseHistorySlot = {
  id: string;
  claim: SessionClaim;
  policy: string;
  limits: ResponseHistoryLimits;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (): never => {
  throw new Error("decision_responses_history_rejected");
};
export function assertResponseHistoryAllowed(keyId: string): void {
  const key = getDbInstance().prepare("SELECT no_log FROM api_keys WHERE id=?").get(keyId) as
    Row | undefined;
  if (!key || key.no_log !== 0 || !isEncryptionEnabled()) fail();
}
function binding(identity: AttemptIdentity): SessionBinding {
  return {
    candidateId: identity.candidateId,
    provider: identity.provider,
    model: identity.model,
    connectionId: identity.connectionId,
    effort: identity.effort,
  };
}
export function readResponseHistory(
  id: string,
  keyId: string,
  comboId: string,
  policy: string
): ResponseHistoryOrigin {
  assertResponseHistoryAllowed(keyId);
  if (!/^resp_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) fail();
  const row = getDbInstance()
    .prepare("SELECT * FROM decision_response_histories WHERE id=? AND api_key_id=? AND combo_id=?")
    .get(id, keyId, comboId) as Row | undefined;
  if (
    !row ||
    row.state !== "ready" ||
    Number(row.expires_at) <= Date.now() ||
    row.policy_hash !== hash(policy) ||
    typeof row.history_ciphertext !== "string" ||
    !row.history_ciphertext.startsWith("enc:v1:")
  )
    fail();
  const bound = JSON.parse(String(row!.binding_json)) as SessionBinding;
  if (row!.authority_hash !== sessionAuthority(bound, keyId, comboId, policy)) fail();
  const receipt = readDecisionAttemptReceipt(String(row!.source_attempt_id));
  if (
    receipt.api_key_id !== keyId ||
    receipt.combo_id !== comboId ||
    receipt.state !== "completed" ||
    receipt.http_status !== 200 ||
    receipt.application_status !== 200 ||
    JSON.stringify(bound) !==
      JSON.stringify({
        candidateId: receipt.candidate_id,
        provider: receipt.provider,
        model: receipt.model,
        connectionId: receipt.connection_id,
        effort: receipt.effort,
      })
  )
    fail();
  const plaintext = decrypt(String(row!.history_ciphertext), { quiet: true });
  if (!plaintext || Buffer.byteLength(plaintext) > 2097152) fail();
  const messages: unknown = JSON.parse(plaintext!);
  if (!Array.isArray(messages) || messages.length > 128) fail();
  return {
    id,
    snapshot: hash(JSON.stringify(row)),
    sessionId: String(row!.session_id),
    binding: bound,
    messages: messages as unknown[],
  };
}
function assertResponseOrigin(
  origin: ResponseHistoryOrigin,
  claim: SessionClaim,
  policy: string
): void {
  assertRoutingSession(claim);
  const fresh = readResponseHistory(origin.id, claim.keyId, claim.comboId, policy);
  if (fresh.snapshot !== origin.snapshot || fresh.sessionId !== claim.id) fail();
}
/** Expiry is checked at owned admission; a valid admitted turn may finish within its request lease. */
export function admitResponseHistoryOrigin(
  origin: ResponseHistoryOrigin,
  claim: SessionClaim,
  policy: string
): void {
  getDbInstance().immediate(() => assertResponseOrigin(origin, claim, policy));
}
/** Reserve retention capacity before selection/dispatch, using the existing session owner. */
export function reserveResponseHistory(
  slot: ResponseHistorySlot,
  timeoutMs: number,
  origin?: ResponseHistoryOrigin
): void {
  const db = getDbInstance();
  db.immediate(() => {
    assertResponseHistoryAllowed(slot.claim.keyId);
    assertRoutingSession(slot.claim);
    if (origin) assertResponseOrigin(origin, slot.claim, slot.policy);
    const now = Date.now();
    db.prepare(
      "DELETE FROM decision_response_histories WHERE api_key_id=? AND combo_id=? AND expires_at<=?"
    ).run(slot.claim.keyId, slot.claim.comboId, now);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM decision_response_histories WHERE api_key_id=? AND combo_id=?"
      )
      .get(slot.claim.keyId, slot.claim.comboId) as { n: number };
    if (count.n >= slot.limits.maxStoredResponses) fail();
    db.prepare(
      "INSERT INTO decision_response_histories (id,session_id,api_key_id,combo_id,owner,state,policy_hash,expires_at) VALUES (?,?,?,?,?,'pending',?,?)"
    ).run(
      slot.id,
      slot.claim.id,
      slot.claim.keyId,
      slot.claim.comboId,
      slot.claim.owner,
      hash(slot.policy),
      now + timeoutMs + slot.limits.ttlMs
    );
  });
}
/** Called inside the owned session/receipt publication transaction. */
export function publishResponseHistory(
  slot: ResponseHistorySlot,
  attempt: AttemptIdentity,
  messages: unknown[]
): void {
  assertResponseHistoryAllowed(slot.claim.keyId);
  const plaintext = JSON.stringify(messages);
  if (messages.length > 128 || Buffer.byteLength(plaintext) > 2097152) fail();
  const ciphertext = encrypt(plaintext);
  if (!ciphertext?.startsWith("enc:v1:")) fail();
  const row = getDbInstance()
    .prepare("SELECT * FROM decision_response_histories WHERE id=?")
    .get(slot.id) as Row | undefined;
  if (
    !row ||
    row.state !== "pending" ||
    row.owner !== slot.claim.owner ||
    row.session_id !== slot.claim.id ||
    row.api_key_id !== attempt.keyId ||
    row.combo_id !== attempt.comboId ||
    row.policy_hash !== hash(slot.policy) ||
    Number(row.expires_at) <= Date.now()
  )
    fail();
  getDbInstance()
    .prepare(
      "UPDATE decision_response_histories SET state='ready',source_attempt_id=?,binding_json=?,authority_hash=?,history_ciphertext=?,expires_at=? WHERE id=?"
    )
    .run(
      attempt.id,
      JSON.stringify(binding(attempt)),
      sessionAuthority(attempt, attempt.keyId, attempt.comboId, slot.policy),
      ciphertext,
      Date.now() + slot.limits.ttlMs,
      slot.id
    );
}
export function releaseResponseHistory(slot: ResponseHistorySlot, attempt?: AttemptIdentity): void {
  const db = getDbInstance();
  db.immediate(() => {
    const receipt = attempt ? readDecisionAttemptReceipt(attempt.id) : undefined;
    const safe = !receipt || receipt.state === "reserved" || receipt.state === "cancelled";
    if (safe)
      db.prepare(
        "DELETE FROM decision_response_histories WHERE id=? AND owner=? AND state='pending'"
      ).run(slot.id, slot.claim.owner);
    else
      db.prepare(
        "UPDATE decision_response_histories SET state='unknown' WHERE id=? AND owner=? AND state='pending'"
      ).run(slot.id, slot.claim.owner);
  });
}
