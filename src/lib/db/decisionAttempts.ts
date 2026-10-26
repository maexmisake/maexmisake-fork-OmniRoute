import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";
import { getKeyQuotaStatus, incrementKeyQuotaCounter } from "./keyQuota";
import { getTokenLimitsForRequest } from "./tokenLimits";
import { recordLedgerEntry } from "./costLedger";
import { saveCostEntry } from "./domainState";

export type AttemptIdentity = {
  id: string;
  /** Internal fencing capability, never accepted from a request or projected publicly. */
  leaseOwner?: string;
  requestedModel?: string;
  keyId: string;
  comboId: string;
  candidateId: string;
  provider: string;
  model: string;
  connectionId: string;
  effort: string;
  outputPolicy?: "provider-native";
  lane?: "decision" | "execution";
  requestId?: string;
  parentAttemptId?: string;
  trace?: Array<{ phase: string; id?: string; reason: string }>;
};
type Row = Record<string, unknown>;
export const DECISION_STAGE_CONCURRENCY = 4;
export const DECISION_STAGE_LEASE_MS = 45_000;
function sharedDecisionStorage(): boolean {
  const db = getDbInstance();
  return (
    ["better-sqlite3", "node:sqlite", "bun:sqlite"].includes(db.driver) &&
    !!db.name &&
    db.name !== ":memory:" &&
    !db.name.startsWith("file:")
  );
}
function assertSharedDecisionStorage(): void {
  if (!sharedDecisionStorage()) throw new Error("decision_storage_unsupported");
}
/** Releasing occupancy never establishes whether a previously started remote call stopped. */
function expireDecisionLeases(keyId: string): void {
  const db = getDbInstance();
  const now = Date.now();
  db.prepare(
    `UPDATE decision_application_attempts SET state='cancelled',
    cost_usd=COALESCE(cost_usd,0),input_tokens=COALESCE(input_tokens,0),
    output_tokens=COALESCE(output_tokens,0),updated_at=?
    WHERE api_key_id=? AND state='reserved' AND lease_expires_at<=?`
  ).run(new Date(now).toISOString(), keyId, now);
  db.prepare(
    `UPDATE decision_application_attempts SET state='unknown',updated_at=?
    WHERE api_key_id=? AND state='started' AND lease_expires_at<=?`
  ).run(new Date(now).toISOString(), keyId, now);
}
function assertLeaseOwner(identity: Pick<AttemptIdentity, "leaseOwner">, row: Row): void {
  if (!row.lease_owner || row.lease_owner !== identity.leaseOwner)
    throw new Error("decision_lease_owner");
}
export function assertDecisionLease(identity: AttemptIdentity): void {
  assertSharedDecisionStorage();
  const row = readDecisionAttemptReceipt(identity.id);
  assertIdentityRow(identity, row);
  assertLeaseOwner(identity, row);
  if (
    !identity.leaseOwner ||
    !row.lease_owner ||
    !["reserved", "started"].includes(String(row.state)) ||
    typeof row.lease_expires_at !== "number" ||
    row.lease_expires_at <= Date.now()
  )
    throw new Error("decision_lease_expired");
}
/** No takeover or renewal. Late same-owner settlement remains possible after release. */
export function releaseDecisionAttempt(identity: AttemptIdentity): void {
  assertSharedDecisionStorage();
  const db = getDbInstance();
  db.immediate(() => {
    const row = readDecisionAttemptReceipt(identity.id);
    assertIdentityRow(identity, row);
    assertLeaseOwner(identity, row);
    if (row.state === "reserved") cancelUnstartedDecision(identity.id, identity.leaseOwner);
    else if (row.state === "started")
      db.prepare(
        "UPDATE decision_application_attempts SET state='unknown',updated_at=? WHERE id=?"
      ).run(new Date().toISOString(), identity.id);
  });
}
export function readDecisionAttempts(keyId: string): Row[] {
  return getDbInstance()
    .prepare(
      "SELECT * FROM decision_application_attempts WHERE api_key_id = ? ORDER BY created_at,id"
    )
    .all(keyId)
    .map((value) => {
      const { lease_owner: _owner, ...publicRow } = value as Row;
      return publicRow;
    });
}
export function readDecisionAttemptReceipt(id: string): Row {
  const row = getDbInstance()
    .prepare("SELECT * FROM decision_application_attempts WHERE id=?")
    .get(id) as Row | undefined;
  if (!row) throw new Error("decision_receipt_missing");
  return row;
}
function financialDecisionCap(
  key: Row,
  budget: Row | undefined,
  monthlyAmountUsd: number | null
): boolean {
  return !!(
    Number(budget?.daily_limit_usd) > 0 ||
    Number(budget?.weekly_limit_usd) > 0 ||
    Number(budget?.monthly_limit_usd) > 0 ||
    monthlyAmountUsd ||
    (key.usage_limit_enabled &&
      (Number(key.daily_usage_limit_usd) > 0 || Number(key.weekly_usage_limit_usd) > 0))
  );
}
/** Throwing fresh reads, not getBudget's cached/fail-open absence. */
export function decisionCapKinds(
  keyId: string,
  provider: string,
  model: string,
  requestedModel?: string
) {
  const db = getDbInstance();
  const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as Row | undefined;
  if (
    !key ||
    key.is_active === 0 ||
    key.is_banned === 1 ||
    key.revoked_at ||
    (key.expires_at && Date.parse(String(key.expires_at)) <= Date.now())
  )
    throw new Error("decision_key_unavailable");
  const budget = db.prepare("SELECT * FROM domain_budgets WHERE api_key_id = ?").get(keyId) as
    Row | undefined;
  const quota = getKeyQuotaStatus(keyId, { enforcementOnly: true });
  const financial = financialDecisionCap(key, budget, quota.limits.monthlyAmountUsd);
  const tokens =
    !!quota.limits.tpmLimit ||
    getTokenLimitsForRequest(keyId, provider, model).length > 0 ||
    getTokenLimitsForRequest(keyId, provider, `${provider}/${model}`).length > 0 ||
    (requestedModel != null && getTokenLimitsForRequest(keyId, "", requestedModel).length > 0);
  let scheduled = false;
  if (key.access_schedule) {
    try {
      scheduled = JSON.parse(String(key.access_schedule))?.enabled === true;
    } catch {
      scheduled = true;
    }
  }
  return { financial, tokens, quota, scheduled };
}
export function assertUncappedDecision(
  keyId: string,
  provider: string,
  model: string,
  ownerId?: string,
  requestedModel?: string
): void {
  const caps = decisionCapKinds(keyId, provider, model, requestedModel);
  if (caps.scheduled) throw new Error("decision_scheduled_key_unsupported");
  if (caps.financial || caps.tokens) throw new Error("decision_capped_configuration_unsupported");
  if (caps.quota.rpmExceeded && !countedLogicalRequest(keyId, ownerId))
    throw new Error("decision_request_quota_exhausted");
}
type AdmissionTarget = {
  provider?: string | null;
  model?: string | null;
  requestedModel?: string | null;
  requestedCombo?: boolean;
};
function applicableTokenLimits(keyId: string, target: AdmissionTarget) {
  return [
    ...getTokenLimitsForRequest(keyId, target.provider ?? "", target.model ?? ""),
    ...getTokenLimitsForRequest(
      keyId,
      target.provider ?? "",
      target.requestedModel ??
        (target.provider && target.model ? `${target.provider}/${target.model}` : "")
    ),
  ];
}
/** Ordinary admission only blocks shared capped liability, never native occupancy. */
export function decisionAdmissionBlocked(
  keyId: string,
  ownerId?: string,
  target: AdmissionTarget = {}
): boolean {
  const db = getDbInstance();
  // Expiry cleanup belongs to atomic native reservation, not ordinary admission.
  // started/unknown share liability flags; reserved/cancelled are both ignored.
  // Taking a writer lock here needlessly blocks unrelated WAL readers.
  const limits = applicableTokenLimits(keyId, target);
  const requestedLimits = new Set(limits.map((limit) => limit.id));
  const requestedComboCapped =
    target.requestedCombo === true &&
    limits.some(
      (limit) => limit.scopeType === "model" && limit.scopeValue === target.requestedModel
    );
  const unresolved = db
    .prepare(
      `SELECT provider,model,requested_model,
    MAX(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
    MAX(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens>output_tokens THEN 1 ELSE 0 END) AS unknown_tokens
    FROM decision_application_attempts WHERE api_key_id=? AND id<>?
      AND state NOT IN ('reserved','cancelled')
      AND (cost_usd IS NULL OR input_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens>output_tokens)
    GROUP BY provider,model,requested_model`
    )
    .all(keyId, ownerId ?? "") as Row[];
  return unresolved.some((row) => {
    const caps = decisionCapKinds(keyId, String(row.provider), String(row.model));
    if (caps.financial && row.unknown_cost === 1) return true;
    if (row.unknown_tokens !== 1) return false;
    if (caps.quota.limits.tpmLimit) return true;
    // A legacy receipt cannot establish which requested combo consumed these tokens.
    if (row.requested_model == null && requestedComboCapped) return true;
    return applicableTokenLimits(keyId, {
      provider: String(row.provider),
      model: String(row.model),
      requestedModel: typeof row.requested_model === "string" ? row.requested_model : undefined,
    }).some((limit) => requestedLimits.has(limit.id));
  });
}
export function reserveDecisionAttempt(identity: AttemptIdentity): void {
  assertSharedDecisionStorage();
  const db = getDbInstance();
  db.immediate(() => reserveInTransaction(identity));
}
/** Internal DB-domain seam: a continuation claim and its fresh reservation commit together. */
export function reserveDecisionAttemptWithClaim(
  identity: AttemptIdentity,
  claim: () => void
): void {
  assertSharedDecisionStorage();
  getDbInstance().immediate(() => {
    reserveInTransaction(identity);
    claim();
  });
}
/** Private origin capability is checked without exposing it through public receipt projections. */
export function readCompletedDecisionOrigin(identity: AttemptIdentity): Row {
  assertSharedDecisionStorage();
  const row = readDecisionAttemptReceipt(identity.id);
  assertIdentityRow(identity, row);
  assertLeaseOwner(identity, row);
  if (
    row.lane !== "execution" ||
    row.state !== "completed" ||
    row.http_status !== 200 ||
    row.application_status !== 200
  )
    throw new Error("continuation_origin_incomplete");
  return row;
}
/** Only a verified complete provider response may atomically commit client success with metadata. */
export function finishDecisionApplicationWithMetadata(
  identity: AttemptIdentity,
  publish: () => void
): void {
  assertSharedDecisionStorage();
  getDbInstance().immediate(() => {
    const row = readDecisionAttemptReceipt(identity.id);
    assertIdentityRow(identity, row);
    assertLeaseOwner(identity, row);
    if (
      row.lane !== "execution" ||
      row.state !== "completed" ||
      row.http_status !== 200 ||
      (row.application_status != null && row.application_status !== 200)
    )
      throw new Error("continuation_origin_incomplete");
    finishInTransaction(identity.id, 200);
    publish();
  });
}
function reserveInTransaction(identity: AttemptIdentity): void {
  assertSharedDecisionStorage();
  const db = getDbInstance();
  assertUncappedDecision(
    identity.keyId,
    identity.provider,
    identity.model,
    identity.parentAttemptId,
    identity.requestedModel
  );
  if (identity.parentAttemptId) assertSelectedParent(identity);
  else if (identity.requestId && identity.requestId !== identity.id)
    throw new Error("decision_request_identity");
  expireDecisionLeases(identity.keyId);
  const active = db
    .prepare(
      "SELECT COUNT(*) AS n FROM decision_application_attempts WHERE api_key_id=? AND state IN ('reserved','started')"
    )
    .get(identity.keyId) as Row;
  if (Number(active.n) >= DECISION_STAGE_CONCURRENCY)
    throw new Error("decision_concurrency_exhausted");
  const leaseOwner = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO decision_application_attempts(id,api_key_id,combo_id,candidate_id,provider,model,connection_id,effort,state,created_at,updated_at,selection_trace,lane,request_id,parent_attempt_id,lease_owner,lease_expires_at,requested_model) VALUES (?,?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?)`
  ).run(
    identity.id,
    identity.keyId,
    identity.comboId,
    identity.candidateId,
    identity.provider,
    identity.model,
    identity.connectionId,
    identity.effort,
    new Date().toISOString(),
    new Date().toISOString(),
    JSON.stringify(identity.trace ?? []),
    identity.lane ?? "execution",
    identity.requestId ?? identity.id,
    identity.parentAttemptId ?? null,
    leaseOwner,
    now + DECISION_STAGE_LEASE_MS,
    identity.requestedModel ?? null
  );
  identity.leaseOwner = leaseOwner;
}

export function startDecisionAttempt(identity: AttemptIdentity): void {
  assertSharedDecisionStorage();
  const db = getDbInstance();
  db.immediate(() => {
    assertDecisionLease(identity);
    assertUncappedDecision(
      identity.keyId,
      identity.provider,
      identity.model,
      identity.parentAttemptId ?? identity.id,
      identity.requestedModel
    );
    if (identity.parentAttemptId) assertSelectedParent(identity);
    const result = db
      .prepare(
        "UPDATE decision_application_attempts SET state='started',logical_counted=?,updated_at=? WHERE id=? AND state='reserved' AND lease_owner=? AND lease_expires_at>?"
      )
      .run(
        identity.parentAttemptId ? 0 : 1,
        new Date().toISOString(),
        identity.id,
        identity.leaseOwner,
        Date.now()
      );
    if (result.changes !== 1) throw new Error("decision_attempt_already_started");
    if (!identity.parentAttemptId) incrementKeyQuotaCounter(identity.keyId, "rpm", 1);
  });
}
export type AttemptUsage = {
  status: number | null;
  input: number | null;
  output: number | null;
  cost: number | null;
  reasoning?: number | null;
  cacheRead?: number | null;
  cacheCreation?: number | null;
  uncachedInput?: number | null;
};
/** Terminal outcome and known cost projection commit together. Idempotent, no zero substitution. */
function mergeReported(old: unknown, value: number | null): number | null {
  if (old !== null && old !== undefined && value !== null && old !== value)
    throw new Error("decision_settlement_conflict");
  return typeof old === "number" ? old : value;
}
function validUsage(usage: AttemptUsage): void {
  for (const field of ["reasoning", "cacheRead", "cacheCreation", "uncachedInput"] as const) {
    const value = usage[field];
    if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("decision_usage_invalid");
  }
  for (const field of ["input", "output", "status"] as const)
    if (usage[field] !== null && (!Number.isSafeInteger(usage[field]) || usage[field]! < 0))
      throw new Error("decision_usage_invalid");
  if (usage.cost !== null && (!Number.isFinite(usage.cost) || usage.cost < 0))
    throw new Error("decision_usage_invalid");
}
export function settleDecisionAttempt(identity: AttemptIdentity, usage: AttemptUsage): void {
  assertSharedDecisionStorage();
  validUsage(usage);
  const db = getDbInstance();
  db.immediate(() => settleInTransaction(identity, usage));
}
function settleInTransaction(identity: AttemptIdentity, usage: AttemptUsage): void {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT * FROM decision_application_attempts WHERE id=?")
    .get(identity.id) as Row | undefined;
  if (!row || !["started", "unknown", "completed"].includes(String(row.state)))
    throw new Error("decision_attempt_not_started");
  assertIdentityRow(identity, row);
  assertLeaseOwner(identity, row);
  if (
    row.api_key_id !== identity.keyId ||
    row.connection_id !== identity.connectionId ||
    row.provider !== identity.provider ||
    row.model !== identity.model
  )
    throw new Error("decision_settlement_identity");
  const status = mergeReported(row.http_status, usage.status),
    input = mergeReported(row.input_tokens, usage.input),
    output = mergeReported(row.output_tokens, usage.output),
    cost = mergeReported(row.cost_usd, usage.cost);
  const reasoning = mergeReported(row.reasoning_tokens, usage.reasoning ?? null),
    cacheRead = mergeReported(row.cache_read_tokens, usage.cacheRead ?? null),
    cacheCreation = mergeReported(row.cache_creation_tokens, usage.cacheCreation ?? null);
  const uncachedInput = mergeReported(row.uncached_input_tokens, usage.uncachedInput ?? null);
  const consistent = reasoning === null || output === null || reasoning <= output;
  const visibleOutput =
    output === null ||
    !consistent ||
    (["claude", "codex"].includes(identity.provider) && reasoning === null)
      ? null
      : output - (reasoning ?? 0);
  const state = status === null ? "unknown" : "completed";
  db.prepare(
    "UPDATE decision_application_attempts SET state=?,http_status=?,input_tokens=?,output_tokens=?,cost_usd=?,updated_at=?,reasoning_tokens=?,cache_read_tokens=?,cache_creation_tokens=?,uncached_input_tokens=? WHERE id=?"
  ).run(
    state,
    status,
    input,
    output,
    cost,
    new Date().toISOString(),
    reasoning,
    cacheRead,
    cacheCreation,
    uncachedInput,
    identity.id
  );
  if (
    input !== null &&
    output !== null &&
    consistent &&
    (row.input_tokens === null || row.output_tokens === null)
  )
    incrementKeyQuotaCounter(identity.keyId, "tpm", input + output);
  if (cost !== null && row.cost_usd === null) {
    recordLedgerEntry({
      apiKeyId: identity.keyId,
      provider: identity.provider,
      model: identity.model,
      amountUsd: cost,
      tokensInput: input ?? undefined,
      tokensOutput: visibleOutput ?? undefined,
      tokensReasoning: reasoning ?? undefined,
      tokensCacheRead: cacheRead ?? undefined,
      tokensCacheCreation: cacheCreation ?? undefined,
      success: row.application_status !== null && Number(row.application_status) < 400,
      requestId: identity.id,
    });
    saveCostEntry(identity.keyId, cost, Date.parse(String(row.created_at)));
  }
  if (cost !== null)
    db.prepare(
      "UPDATE request_cost_ledger SET tokens_input=COALESCE(?,tokens_input),tokens_output=COALESCE(?,tokens_output),tokens_reasoning=COALESCE(?,tokens_reasoning),tokens_cache_read=COALESCE(?,tokens_cache_read),tokens_cache_creation=COALESCE(?,tokens_cache_creation) WHERE request_id=?"
    ).run(input, visibleOutput, reasoning, cacheRead, cacheCreation, identity.id);
  db.prepare(
    `INSERT INTO usage_history(provider,model,connection_id,api_key_id,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_creation,status,success,timestamp,provider_cost_usd,decision_attempt_id,combo_strategy,decision_lane,decision_request_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(decision_attempt_id) DO UPDATE SET tokens_input=excluded.tokens_input,tokens_output=excluded.tokens_output,tokens_reasoning=excluded.tokens_reasoning,tokens_cache_read=excluded.tokens_cache_read,tokens_cache_creation=excluded.tokens_cache_creation,status=excluded.status,success=excluded.success,provider_cost_usd=excluded.provider_cost_usd`
  ).run(
    identity.provider,
    identity.model,
    identity.connectionId,
    identity.keyId,
    input,
    visibleOutput,
    reasoning,
    cacheRead,
    cacheCreation,
    row.application_status === null ? "pending" : String(row.application_status),
    row.application_status !== null && Number(row.application_status) < 400 ? 1 : 0,
    String(row.created_at),
    cost,
    identity.id,
    identity.outputPolicy === "provider-native"
      ? "decision-provider-native-output-v1"
      : "decision-bounded-v1",
    identity.lane ?? "execution",
    identity.requestId ?? identity.id
  );
}

export function cancelUnstartedDecision(id: string, leaseOwner?: string): void {
  assertSharedDecisionStorage();
  const row = readDecisionAttemptReceipt(id);
  assertLeaseOwner({ leaseOwner }, row);
  getDbInstance()
    .prepare(
      "UPDATE decision_application_attempts SET state='cancelled',cost_usd=0,input_tokens=0,output_tokens=0,updated_at=? WHERE id=? AND state='reserved'"
    )
    .run(new Date().toISOString(), id);
}

export function decisionAuthorityStamp(identity: AttemptIdentity, expectedPolicy?: string): string {
  const db = getDbInstance();
  const key = db
    .prepare(
      "SELECT key_hash,is_active,is_banned,revoked_at,expires_at,model_access_mode,allowed_models,blocked_models,allowed_combos,allowed_connections,allowed_quotas,disable_non_public_models,allowed_endpoints,scopes,access_schedule,forced_model,proxy_id,ip_allowlist,max_requests_per_day,max_requests_per_minute,max_sessions,rate_limits FROM api_keys WHERE id=?"
    )
    .get(identity.keyId);
  const connection = db
    .prepare(
      "SELECT provider,auth_type,is_active,api_key,access_token,refresh_token,expires_at,token_expires_at,provider_specific_data,quota_window_thresholds_json,max_concurrent,rate_limit_protection,rate_limit_overrides_json,proxy_enabled,per_key_proxy_enabled FROM provider_connections WHERE id=?"
    )
    .get(identity.connectionId);
  const combo = db.prepare("SELECT data FROM combos WHERE id=?").get(identity.comboId);
  if (expectedPolicy !== undefined) {
    const parsed = JSON.parse(String((combo as Row | undefined)?.data ?? "null"));
    if (JSON.stringify(parsed?.config?.decisionPolicy) !== expectedPolicy)
      throw new Error("decision_plan_changed");
  }
  const groups = db
    .prepare(
      "SELECT m.group_id,g.is_active,p.id,p.model_pattern,p.provider,p.access_type FROM key_group_members m JOIN key_groups g ON g.id=m.group_id LEFT JOIN group_model_permissions p ON p.group_id=m.group_id WHERE m.key_id=? ORDER BY m.group_id,p.id"
    )
    .all(identity.keyId);
  const quotaSettings = db
    .prepare(
      "SELECT key,value FROM key_value WHERE namespace='settings' AND key IN ('resilienceSettings','memoryEnabled','semanticCacheEnabled','compressionEnabled','autoWebSearchEnabled','webSearchEnabled','proxyEnabled','perKeyProxyEnabled') ORDER BY key"
    )
    .all();
  return JSON.stringify([
    key,
    connection,
    combo,
    groups,
    quotaSettings,
    process.env.QUOTA_PREFLIGHT_CUTOFF_ENABLED,
  ]);
}

/** Application success is separate from raw provider HTTP success and possible billing. */
export function finishDecisionApplication(id: string, status: number): void {
  assertSharedDecisionStorage();
  const db = getDbInstance();
  db.immediate(() => finishInTransaction(id, status));
}
function finishInTransaction(id: string, status: number): void {
  const db = getDbInstance();
  db.prepare("UPDATE decision_application_attempts SET application_status=? WHERE id=?").run(
    status,
    id
  );
  db.prepare("UPDATE usage_history SET status=?,success=? WHERE decision_attempt_id=?").run(
    String(status),
    status >= 200 && status < 300 ? 1 : 0,
    id
  );
  db.prepare("UPDATE request_cost_ledger SET success=? WHERE request_id=?").run(
    status >= 200 && status < 300 ? 1 : 0,
    id
  );
}

function selectedBinding(identity: AttemptIdentity): string {
  return JSON.stringify([
    identity.candidateId,
    identity.provider,
    identity.model,
    identity.effort,
    identity.connectionId,
  ]);
}
function assertIdentityRow(identity: AttemptIdentity, row: Row): void {
  const expected = [
    identity.keyId,
    identity.comboId,
    identity.candidateId,
    identity.provider,
    identity.model,
    identity.connectionId,
    identity.effort,
    identity.lane ?? "execution",
    identity.requestId ?? identity.id,
    identity.parentAttemptId ?? null,
    identity.requestedModel ?? null,
  ];
  const actual = [
    row.api_key_id,
    row.combo_id,
    row.candidate_id,
    row.provider,
    row.model,
    row.connection_id,
    row.effort,
    row.lane,
    row.request_id,
    row.parent_attempt_id,
    row.requested_model,
  ];
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("decision_attempt_identity");
}
function assertSelectedParent(child: AttemptIdentity): void {
  if (!child.parentAttemptId || child.lane !== "execution")
    throw new Error("decision_parent_invalid");
  const parent = readDecisionAttemptReceipt(child.parentAttemptId);
  const expected = [
    child.keyId,
    child.comboId,
    child.requestId,
    "decision",
    "completed",
    200,
    200,
    "selected",
    1,
    selectedBinding(child),
    child.requestedModel ?? null,
  ];
  const actual = [
    parent.api_key_id,
    parent.combo_id,
    parent.request_id,
    parent.lane,
    parent.state,
    parent.http_status,
    parent.application_status,
    parent.decision_outcome,
    parent.logical_counted,
    parent.selected_binding,
    parent.requested_model,
  ];
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("decision_parent_invalid");
}
function countedLogicalRequest(keyId: string, ownerId?: string): boolean {
  if (!ownerId) return false;
  const db = getDbInstance();
  const row = db
    .prepare("SELECT * FROM decision_application_attempts WHERE id=? AND api_key_id=?")
    .get(ownerId, keyId) as Row | undefined;
  if (!row) return false;
  if (row.parent_attempt_id) {
    try {
      assertSelectedParent({
        id: String(row.id),
        keyId,
        comboId: String(row.combo_id),
        candidateId: String(row.candidate_id),
        provider: String(row.provider),
        model: String(row.model),
        connectionId: String(row.connection_id),
        effort: String(row.effort),
        lane: "execution",
        requestId: String(row.request_id),
        parentAttemptId: String(row.parent_attempt_id),
        requestedModel: typeof row.requested_model === "string" ? row.requested_model : undefined,
      });
      return true;
    } catch {
      return false;
    }
  }
  return (
    row.logical_counted === 1 && ["started", "completed", "unknown"].includes(String(row.state))
  );
}
/** One transaction keeps the logical key slot occupied while ownership moves to execution. */
export function handoverNativeDecision(
  parent: AttemptIdentity,
  child: AttemptIdentity,
  usage: AttemptUsage
): void {
  assertSharedDecisionStorage();
  validUsage(usage);
  const db = getDbInstance();
  db.immediate(() => {
    const row = readDecisionAttemptReceipt(parent.id);
    assertIdentityRow(parent, row);
    assertLeaseOwner(parent, row);
    if (
      row.lane !== "decision" ||
      usage.status !== 200 ||
      row.logical_counted !== 1 ||
      child.parentAttemptId !== parent.id ||
      child.requestId !== parent.id
    )
      throw new Error("decision_handover_invalid");
    if (row.decision_outcome === "selected") {
      assertSelectedParent(child);
      const existingChild = readDecisionAttemptReceipt(child.id);
      assertIdentityRow(child, existingChild);
      assertLeaseOwner(child, existingChild);
      settleInTransaction(parent, usage);
      return;
    }
    assertDecisionLease(parent);
    if (row.state !== "started") throw new Error("decision_handover_invalid");
    db.prepare(
      "UPDATE decision_application_attempts SET decision_outcome='selected',selected_binding=? WHERE id=?"
    ).run(selectedBinding(child), parent.id);
    settleInTransaction(parent, usage);
    finishInTransaction(parent.id, 200);
    reserveInTransaction(child);
  });
}
export function finishNativeDecision(
  parent: AttemptIdentity,
  usage: AttemptUsage,
  outcome: string,
  status: number
): void {
  assertSharedDecisionStorage();
  validUsage(usage);
  const db = getDbInstance();
  db.immediate(() => {
    const row = readDecisionAttemptReceipt(parent.id);
    assertIdentityRow(parent, row);
    assertLeaseOwner(parent, row);
    if (row.lane !== "decision" || row.decision_outcome === "selected")
      throw new Error("decision_outcome_invalid");
    db.prepare("UPDATE decision_application_attempts SET decision_outcome=? WHERE id=?").run(
      outcome,
      parent.id
    );
    if (row.state === "reserved") cancelUnstartedDecision(parent.id, parent.leaseOwner);
    else settleInTransaction(parent, usage);
    finishInTransaction(parent.id, status);
  });
}
export function readLogicalDecisionCost(requestId: string): {
  knownUsd: number;
  unknownStages: number;
  totalUsd: number | null;
} {
  const rows = getDbInstance()
    .prepare("SELECT cost_usd FROM decision_application_attempts WHERE request_id=?")
    .all(requestId) as Row[];
  const unknownStages = rows.filter((row) => row.cost_usd === null).length;
  const knownUsd = rows.reduce(
    (sum, row) => sum + (typeof row.cost_usd === "number" ? row.cost_usd : 0),
    0
  );
  return { knownUsd, unknownStages, totalUsd: unknownStages ? null : knownUsd };
}
