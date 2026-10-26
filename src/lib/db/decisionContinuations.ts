import { randomUUID } from "node:crypto";
import { opaqueTokenFingerprint } from "../../../open-sse/utils/opaqueTokenFingerprint.ts";
import { getDbInstance } from "./core";
import {
  assertUncappedDecision,
  cancelUnstartedDecision,
  decisionAuthorityStamp,
  assertDecisionLease,
  readCompletedDecisionOrigin,
  finishDecisionApplicationWithMetadata,
  readDecisionAttemptReceipt,
  reserveDecisionAttemptWithClaim,
  type AttemptIdentity,
} from "./decisionAttempts";

export const TOOL_CONTINUATION_LIMITS = Object.freeze({
  calls: 32,
  depth: 32,
  live: 32,
  ttlMs: 30 * 60_000,
  canonicalBytes: 262144,
});
export type ContinuationCall = { id: string; name: string; arguments: string };
export type ToolGroupProof = {
  clientPrefixJSON: string;
  toolContractJSON: string;
  calls: readonly ContinuationCall[];
};
export type ToolContinuationRequest = {
  keyId: string;
  comboId: string;
  history: readonly ToolGroupProof[];
  completedCallIds: readonly string[];
};
type Binding = Pick<
  AttemptIdentity,
  "candidateId" | "provider" | "model" | "connectionId" | "effort"
>;
export type PreparedToolContinuation = {
  turnId: string;
  sourceAttemptId: string;
  depth: number;
  binding: Binding;
  replayOrigins: Array<{
    turnId: string;
    sourceAttemptId: string;
    depth: number;
    requiresThinkingReplay: boolean;
  }>;
};
type Row = Record<string, unknown>;
type IssueProof = ToolGroupProof & {
  expectedPolicy: string;
  expectedAuthority: string;
  previousTurnId?: string;
  thinkingBlocksJSON?: string;
};
const wireId = /^[A-Za-z0-9_-]{1,128}$/;
function fail(reason: string): never {
  throw new Error("continuation_" + reason);
}
function jsonBytes(value: string, array: boolean): number {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > TOOL_CONTINUATION_LIMITS.canonicalBytes
  )
    fail("proof");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("proof");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) !== array) fail("proof");
  return Buffer.byteLength(value);
}
function canonicalCalls(calls: readonly ContinuationCall[]): string {
  if (!Array.isArray(calls) || !calls.length || calls.length > TOOL_CONTINUATION_LIMITS.calls)
    fail("calls");
  const ids = new Set<string>();
  const copies = calls.map((call) => {
    if (
      !call ||
      typeof call !== "object" ||
      Object.keys(call).sort().join() !== "arguments,id,name"
    )
      fail("calls");
    if (
      typeof call.id !== "string" ||
      !wireId.test(call.id) ||
      ids.has(call.id) ||
      typeof call.name !== "string" ||
      !wireId.test(call.name) ||
      typeof call.arguments !== "string"
    )
      fail("calls");
    jsonBytes(call.arguments, false);
    ids.add(call.id);
    return { id: call.id, name: call.name, arguments: call.arguments };
  });
  return JSON.stringify(copies);
}
function validateHistory(history: readonly ToolGroupProof[]): void {
  if (!Array.isArray(history) || !history.length || history.length > TOOL_CONTINUATION_LIMITS.depth)
    fail("history");
  let bytes = 0;
  for (const group of history) {
    bytes += jsonBytes(group.clientPrefixJSON, true) + jsonBytes(group.toolContractJSON, false);
    bytes += Buffer.byteLength(canonicalCalls(group.calls));
  }
  if (bytes > TOOL_CONTINUATION_LIMITS.canonicalBytes) fail("proof_too_large");
}
function identityOf(row: Row): AttemptIdentity {
  return {
    id: String(row.id),
    keyId: String(row.api_key_id),
    comboId: String(row.combo_id),
    candidateId: String(row.candidate_id),
    provider: String(row.provider),
    model: String(row.model),
    connectionId: String(row.connection_id),
    effort: String(row.effort),
    leaseOwner: String(row.lease_owner),
    requestedModel: row.requested_model == null ? undefined : String(row.requested_model),
    lane: "execution",
    requestId: row.request_id == null ? undefined : String(row.request_id),
    parentAttemptId: row.parent_attempt_id == null ? undefined : String(row.parent_attempt_id),
  };
}
function originOf(turn: Row): { identity: AttemptIdentity; row: Row } {
  const identity = identityOf(readDecisionAttemptReceipt(String(turn.source_attempt_id)));
  const row = readCompletedDecisionOrigin(identity);
  if (row.api_key_id !== turn.api_key_id || row.combo_id !== turn.combo_id) fail("origin_binding");
  return { identity, row };
}
function mac(owner: string, kind: string, value: string): string {
  return opaqueTokenFingerprint("decision-tool-v1\0" + kind + "\0" + value, { key: owner });
}
function descriptor(call: ContinuationCall): string {
  return JSON.stringify({ id: call.id, name: call.name, arguments: call.arguments });
}
function issuedCallsMatch(turnId: string, proof: ToolGroupProof, owner: string): boolean {
  const rows = getDbInstance()
    .prepare(
      "SELECT ordinal,id_mac,descriptor_mac FROM decision_tool_calls WHERE turn_id=? ORDER BY ordinal LIMIT 33"
    )
    .all(turnId) as Row[];
  return (
    rows.length === proof.calls.length &&
    rows.every(
      (row, index) =>
        row.ordinal === index &&
        row.id_mac === mac(owner, "id", proof.calls[index].id) &&
        row.descriptor_mac === mac(owner, "descriptor", descriptor(proof.calls[index]))
    )
  );
}
function binding(identity: AttemptIdentity): Binding {
  return {
    candidateId: identity.candidateId,
    provider: identity.provider,
    model: identity.model,
    connectionId: identity.connectionId,
    effort: identity.effort,
  };
}
function turnById(id: string): Row {
  const row = getDbInstance().prepare("SELECT * FROM decision_tool_turns WHERE id=?").get(id) as
    Row | undefined;
  if (!row) fail("missing");
  return row;
}
function matchesProof(turn: Row, proof: ToolGroupProof, owner: string): boolean {
  return (
    turn.prefix_mac === mac(owner, "prefix", proof.clientPrefixJSON) &&
    turn.contract_mac === mac(owner, "contract", proof.toolContractJSON) &&
    turn.calls_mac === mac(owner, "calls", canonicalCalls(proof.calls)) &&
    issuedCallsMatch(String(turn.id), proof, owner)
  );
}
function assertCurrent(
  turn: Row,
  proof: ToolGroupProof,
  accountingOwner?: string
): AttemptIdentity {
  const { identity } = originOf(turn);
  if (Number(turn.expires_at) <= Date.now()) fail("expired");
  if (!matchesProof(turn, proof, identity.leaseOwner!)) fail("proof_mismatch");
  assertUncappedDecision(
    identity.keyId,
    identity.provider,
    identity.model,
    accountingOwner,
    identity.requestedModel
  );
  if (
    turn.authority_mac !== mac(identity.leaseOwner!, "authority", decisionAuthorityStamp(identity))
  )
    fail("authority_changed");
  return identity;
}
function completedIds(proof: ToolGroupProof, ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length !== proof.calls.length || new Set(ids).size !== ids.length)
    fail("results");
  if (
    ids.some(
      (id) =>
        typeof id !== "string" || !wireId.test(id) || !proof.calls.some((call) => call.id === id)
    )
  )
    fail("results");
}
function candidateTurns(request: ToolContinuationRequest): Row[] {
  const rows = getDbInstance()
    .prepare(
      "SELECT * FROM decision_tool_turns WHERE api_key_id=? AND combo_id=? AND expires_at>? AND state IN ('issued','claimed') ORDER BY created_at DESC,id LIMIT ?"
    )
    .all(request.keyId, request.comboId, Date.now(), TOOL_CONTINUATION_LIMITS.live + 1) as Row[];
  if (rows.length > TOOL_CONTINUATION_LIMITS.live) fail("live_limit");
  return rows;
}
function ancestry(turn: Row, history: readonly ToolGroupProof[], accountingOwner?: string): Row[] {
  const rows: Row[] = [];
  let current: Row | null = turn;
  while (current) {
    if (rows.length >= TOOL_CONTINUATION_LIMITS.depth || rows.some((row) => row.id === current!.id))
      fail("chain");
    rows.unshift(current);
    current = current.previous_turn_id ? turnById(String(current.previous_turn_id)) : null;
  }
  if (rows.length !== history.length) fail("history");
  const expected = JSON.stringify(binding(originOf(turn).identity));
  rows.forEach((row, index) => {
    if (index < rows.length - 1 && row.state !== "consumed") fail("chain");
    if (JSON.stringify(binding(assertCurrent(row, history[index], accountingOwner))) !== expected)
      fail("chain_binding");
  });
  return rows;
}
function locate(
  request: ToolContinuationRequest,
  accountingOwner?: string
): { turn: Row; chain: Row[] } {
  validateHistory(request.history);
  const proof = request.history.at(-1)!;
  completedIds(proof, request.completedCallIds);
  const matches = candidateTurns(request).filter((turn) => {
    const source = readDecisionAttemptReceipt(String(turn.source_attempt_id));
    return typeof source.lease_owner === "string" && matchesProof(turn, proof, source.lease_owner);
  });
  if (matches.length !== 1) fail("missing_or_ambiguous");
  const turn = matches[0];
  return { turn, chain: ancestry(turn, request.history, accountingOwner) };
}
function prepared(turn: Row, chain: Row[]): PreparedToolContinuation {
  return {
    turnId: String(turn.id),
    sourceAttemptId: String(turn.source_attempt_id),
    depth: Number(turn.depth),
    binding: binding(originOf(turn).identity),
    replayOrigins: chain.map((row) => ({
      turnId: String(row.id),
      sourceAttemptId: String(row.source_attempt_id),
      depth: Number(row.depth),
      requiresThinkingReplay: row.thinking_mac !== null,
    })),
  };
}
export function prepareToolContinuation(
  request: ToolContinuationRequest
): PreparedToolContinuation {
  const { turn, chain } = locate(request);
  return prepared(turn, chain);
}
function requirePrevious(origin: AttemptIdentity, previousId: string | undefined): Row | null {
  const parent = getDbInstance()
    .prepare("SELECT id FROM decision_tool_turns WHERE claimed_attempt_id=?")
    .get(origin.id) as Row | undefined;
  if (!previousId) {
    if (parent) fail("previous_required");
    return null;
  }
  if (!parent || parent.id !== previousId) fail("previous");
  const previous = turnById(previousId);
  if (
    previous.state !== "claimed" ||
    previous.claimed_attempt_id !== origin.id ||
    Number(previous.expires_at) <= Date.now()
  )
    fail("previous");
  if (JSON.stringify(binding(originOf(previous).identity)) !== JSON.stringify(binding(origin)))
    fail("chain_binding");
  return previous;
}
function checkedThinking(value: string): void {
  jsonBytes(value, true);
  const blocks = JSON.parse(value) as Array<Record<string, unknown>>;
  if (
    !blocks.length ||
    blocks.length > 32 ||
    !blocks.every(
      (block) =>
        block &&
        ((block.type === "thinking" &&
          typeof block.thinking === "string" &&
          typeof block.signature === "string" &&
          block.signature.length > 0) ||
          (block.type === "redacted_thinking" &&
            typeof block.data === "string" &&
            block.data.length > 0))
    )
  )
    fail("thinking_shape");
}
function validateIssue(proof: IssueProof): void {
  validateHistory([proof]);
  if (
    typeof proof.expectedPolicy !== "string" ||
    typeof proof.expectedAuthority !== "string" ||
    Buffer.byteLength(proof.expectedAuthority) > 1048576
  )
    fail("authority");
  if (proof.thinkingBlocksJSON !== undefined) checkedThinking(proof.thinkingBlocksJSON);
}
function cleanupExpired(keyId: string, comboId: string, now: number): void {
  // Retain lineage while either the source or its claimed descendant can mint again.
  const threshold = new Date(now - TOOL_CONTINUATION_LIMITS.ttlMs).toISOString();
  getDbInstance()
    .prepare(
      "DELETE FROM decision_tool_turns WHERE id IN (SELECT t.id FROM decision_tool_turns t JOIN decision_application_attempts source ON source.id=t.source_attempt_id WHERE t.api_key_id=? AND t.combo_id=? AND t.expires_at<=? AND julianday(source.created_at)<=julianday(?) AND NOT EXISTS(SELECT 1 FROM decision_tool_turns child WHERE child.previous_turn_id=t.id) AND (t.claimed_attempt_id IS NULL OR EXISTS(SELECT 1 FROM decision_application_attempts claimed WHERE claimed.id=t.claimed_attempt_id AND julianday(claimed.created_at)<=julianday(?))) LIMIT 32)"
    )
    .run(keyId, comboId, now, threshold, threshold);
}
function issueInTransaction(
  origin: AttemptIdentity,
  proof: IssueProof,
  id: string,
  now: number
): void {
  const originRow = readCompletedDecisionOrigin(origin);
  const originExpiry = Date.parse(String(originRow.created_at)) + TOOL_CONTINUATION_LIMITS.ttlMs;
  if (!Number.isFinite(originExpiry) || originExpiry <= now) fail("origin_expired");
  assertUncappedDecision(
    origin.keyId,
    origin.provider,
    origin.model,
    origin.parentAttemptId ?? origin.id,
    origin.requestedModel
  );
  if (decisionAuthorityStamp(origin, proof.expectedPolicy) !== proof.expectedAuthority)
    fail("authority_changed");
  const previous = requirePrevious(origin, proof.previousTurnId);
  const depth = previous ? Number(previous.depth) + 1 : 0;
  if (depth >= TOOL_CONTINUATION_LIMITS.depth) fail("depth");
  cleanupExpired(origin.keyId, origin.comboId, now);
  const live = getDbInstance()
    .prepare(
      "SELECT COUNT(*) n FROM decision_tool_turns WHERE api_key_id=? AND combo_id=? AND expires_at>?"
    )
    .get(origin.keyId, origin.comboId, now) as { n: number };
  if (live.n >= TOOL_CONTINUATION_LIMITS.live) fail("live_limit");
  const owner = origin.leaseOwner!;
  getDbInstance()
    .prepare(
      "INSERT INTO decision_tool_turns(id,source_attempt_id,api_key_id,combo_id,previous_turn_id,depth,state,prefix_mac,contract_mac,calls_mac,authority_mac,thinking_mac,created_at,expires_at) VALUES(?,?,?,?,?,?,'issued',?,?,?,?,?,?,?)"
    )
    .run(
      id,
      origin.id,
      origin.keyId,
      origin.comboId,
      proof.previousTurnId ?? null,
      depth,
      mac(owner, "prefix", proof.clientPrefixJSON),
      mac(owner, "contract", proof.toolContractJSON),
      mac(owner, "calls", canonicalCalls(proof.calls)),
      mac(owner, "authority", proof.expectedAuthority),
      proof.thinkingBlocksJSON === undefined
        ? null
        : mac(owner, "thinking", proof.thinkingBlocksJSON),
      now,
      previous ? Math.min(Number(previous.expires_at), originExpiry) : originExpiry
    );
  proof.calls.forEach((call, index) =>
    getDbInstance()
      .prepare(
        "INSERT INTO decision_tool_calls(turn_id,ordinal,id_mac,descriptor_mac) VALUES(?,?,?,?)"
      )
      .run(id, index, mac(owner, "id", call.id), mac(owner, "descriptor", descriptor(call)))
  );
  if (previous)
    getDbInstance()
      .prepare("UPDATE decision_tool_turns SET state='consumed' WHERE id=?")
      .run(previous.id);
}
export function issueToolContinuation(origin: AttemptIdentity, proof: IssueProof): string {
  validateIssue(proof);
  const id = randomUUID(),
    now = Date.now();
  getDbInstance().immediate(() => issueInTransaction(origin, proof, id, now));
  return id;
}
export function commitToolContinuation(origin: AttemptIdentity, proof: IssueProof): string {
  validateIssue(proof);
  const id = randomUUID(),
    now = Date.now();
  finishDecisionApplicationWithMetadata(origin, () => issueInTransaction(origin, proof, id, now));
  return id;
}

function replayChecked(chain: Row[], replay: Readonly<Record<string, string>>): void {
  const allowed = new Set(chain.map((row) => String(row.source_attempt_id)));
  if (Object.keys(replay).some((id) => !allowed.has(id))) fail("replay_unknown");
  let bytes = 0;
  for (const row of chain) {
    if (row.thinking_mac === null) continue;
    const value = replay[String(row.source_attempt_id)];
    if (typeof value !== "string") fail("replay_missing");
    bytes += jsonBytes(value, true);
    if (bytes > TOOL_CONTINUATION_LIMITS.canonicalBytes) fail("replay_too_large");
    const { identity } = originOf(row);
    if (row.thinking_mac !== mac(identity.leaseOwner!, "thinking", value)) fail("replay_mismatch");
    checkedThinking(value);
  }
}
function reclaimExpired(turn: Row): void {
  if (turn.state === "issued") return;
  if (turn.state !== "claimed" || !turn.claimed_attempt_id) fail("already_consumed");
  const attempt = readDecisionAttemptReceipt(String(turn.claimed_attempt_id));
  if (!["reserved", "cancelled"].includes(String(attempt.state)) || attempt.logical_counted !== 0)
    fail("uncertain_attempt");
  const knownCancelled =
    attempt.state === "cancelled" &&
    attempt.http_status == null &&
    attempt.cost_usd === 0 &&
    attempt.input_tokens === 0 &&
    attempt.output_tokens === 0;
  if (attempt.state === "cancelled" && !knownCancelled) fail("uncertain_attempt");
  if (!knownCancelled && Number(attempt.lease_expires_at) > Date.now()) fail("claimed");
  if (attempt.state === "reserved")
    cancelUnstartedDecision(String(attempt.id), String(attempt.lease_owner));
  getDbInstance()
    .prepare(
      "UPDATE decision_tool_turns SET state='issued',claimed_attempt_id=NULL WHERE id=? AND state='claimed'"
    )
    .run(turn.id);
}
function assertBinding(
  request: ToolContinuationRequest,
  identity: AttemptIdentity,
  origin: AttemptIdentity
): void {
  if (
    identity.id === origin.id ||
    identity.keyId !== request.keyId ||
    identity.comboId !== request.comboId ||
    identity.requestedModel !== origin.requestedModel ||
    JSON.stringify(binding(identity)) !== JSON.stringify(binding(origin))
  )
    fail("binding");
}
export function claimToolContinuation(
  request: ToolContinuationRequest,
  identity: AttemptIdentity,
  replay: Readonly<Record<string, string>> = {}
): PreparedToolContinuation {
  if (
    identity.parentAttemptId ||
    (identity.requestId && identity.requestId !== identity.id) ||
    identity.leaseOwner ||
    (identity.lane && identity.lane !== "execution")
  )
    fail("fresh_request_required");
  let result!: PreparedToolContinuation;
  reserveDecisionAttemptWithClaim(identity, () => {
    const { turn, chain } = locate(request);
    const origin = originOf(turn).identity;
    assertBinding(request, identity, origin);
    replayChecked(chain, replay);
    reclaimExpired(turn);
    const changed = getDbInstance()
      .prepare(
        "UPDATE decision_tool_turns SET state='claimed',claimed_attempt_id=? WHERE id=? AND state='issued'"
      )
      .run(identity.id, turn.id);
    if (changed.changes !== 1) fail("claimed");
    result = prepared(turn, chain);
  });
  return result;
}
/** Admission is not permanent authorization. The handler must call this at its final-send fence. */
export function assertToolContinuationClaim(
  request: ToolContinuationRequest,
  identity: AttemptIdentity,
  replay: Readonly<Record<string, string>> = {}
): void {
  assertDecisionLease(identity);
  const { turn, chain } = locate(request, identity.id);
  if (turn.state !== "claimed" || turn.claimed_attempt_id !== identity.id) fail("claimed");
  assertBinding(request, identity, originOf(turn).identity);
  replayChecked(chain, replay);
}
function finishToolInTransaction(turnId: string, identity: AttemptIdentity): void {
  const turn = turnById(turnId);
  readCompletedDecisionOrigin(identity);
  if (turn.state !== "claimed" || turn.claimed_attempt_id !== identity.id) fail("claimed");
  getDbInstance().prepare("UPDATE decision_tool_turns SET state='consumed' WHERE id=?").run(turnId);
}
export function finishToolContinuation(turnId: string, identity: AttemptIdentity): void {
  getDbInstance().immediate(() => finishToolInTransaction(turnId, identity));
}
export function commitToolContinuationEnd(turnId: string, identity: AttemptIdentity): void {
  finishDecisionApplicationWithMetadata(identity, () => finishToolInTransaction(turnId, identity));
}
export function readToolContinuations(
  keyId: string,
  comboId: string
): Array<Record<string, unknown>> {
  return getDbInstance()
    .prepare(
      "SELECT id,source_attempt_id,depth,state,created_at,expires_at FROM decision_tool_turns WHERE api_key_id=? AND combo_id=? AND expires_at>? ORDER BY created_at DESC,id LIMIT 32"
    )
    .all(keyId, comboId, Date.now()) as Array<Record<string, unknown>>;
}
