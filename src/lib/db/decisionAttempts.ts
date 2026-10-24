import { getDbInstance } from "./core";
import { getKeyQuotaStatus, incrementKeyQuotaCounter } from "./keyQuota";
import { getTokenLimitsForRequest } from "./tokenLimits";
import { recordLedgerEntry } from "./costLedger";
import { saveCostEntry } from "./domainState";

export type AttemptIdentity = {
  id: string;
  keyId: string;
  comboId: string;
  candidateId: string;
  provider: string;
  model: string;
  connectionId: string;
  effort: string;
  trace?: Array<{ phase: string; id?: string; reason: string }>;
};
type Row = Record<string, unknown>;
export function readDecisionAttempts(keyId: string): Row[] {
  return getDbInstance()
    .prepare(
      "SELECT * FROM decision_application_attempts WHERE api_key_id = ? ORDER BY created_at,id"
    )
    .all(keyId) as Row[];
}
/** Throwing fresh reads, not getBudget's cached/fail-open absence. */
export function decisionCapKinds(keyId: string, provider: string, model: string) {
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
  const financial = !!(
    Number(budget?.daily_limit_usd) > 0 ||
    Number(budget?.weekly_limit_usd) > 0 ||
    Number(budget?.monthly_limit_usd) > 0 ||
    quota.limits.monthlyAmountUsd ||
    (key.usage_limit_enabled &&
      (Number(key.daily_usage_limit_usd) > 0 || Number(key.weekly_usage_limit_usd) > 0))
  );
  const tokens =
    !!quota.limits.tpmLimit ||
    getTokenLimitsForRequest(keyId, provider, model).length > 0 ||
    getTokenLimitsForRequest(keyId, provider, `${provider}/${model}`).length > 0;
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
export function assertUncappedDecision(keyId: string, provider: string, model: string): void {
  const caps = decisionCapKinds(keyId, provider, model);
  if (caps.scheduled) throw new Error("decision_scheduled_key_unsupported");
  if (caps.financial || caps.tokens) throw new Error("decision_capped_configuration_unsupported");
  if (caps.quota.rpmExceeded) throw new Error("decision_request_quota_exhausted");
}
/** Shared key-policy read: pending attempt cannot be overlooked by another request.
 * Unknown history is allowed for uncapped traffic, but never treated as zero under a cap. */
export function decisionAdmissionBlocked(keyId: string, ownerId?: string): boolean {
  const db = getDbInstance();
  if (
    db
      .prepare(
        "SELECT 1 FROM decision_application_attempts WHERE api_key_id=? AND state IN ('reserved','started') AND id<>? LIMIT 1"
      )
      .get(keyId, ownerId ?? "")
  )
    return true;
  const unresolved = db
    .prepare(
      `SELECT provider,model,
    MAX(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
    MAX(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens>output_tokens THEN 1 ELSE 0 END) AS unknown_tokens
    FROM decision_application_attempts WHERE api_key_id=? AND state NOT IN ('reserved','started','cancelled')
      AND (cost_usd IS NULL OR input_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens>output_tokens)
    GROUP BY provider,model`
    )
    .all(keyId) as Row[];
  return unresolved.some((row) => {
    const caps = decisionCapKinds(keyId, String(row.provider), String(row.model));
    return (caps.financial && row.unknown_cost === 1) || (caps.tokens && row.unknown_tokens === 1);
  });
}
export function reserveDecisionAttempt(identity: AttemptIdentity): void {
  const db = getDbInstance();
  db.immediate(() => {
    assertUncappedDecision(identity.keyId, identity.provider, identity.model);
    if (decisionAdmissionBlocked(identity.keyId)) throw new Error("decision_admission_pending");
    db.prepare(
      `INSERT INTO decision_application_attempts(id,api_key_id,combo_id,candidate_id,provider,model,connection_id,effort,state,created_at,updated_at,selection_trace) VALUES (?,?,?,?,?,?,?,?,'reserved',?,?,?)`
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
      JSON.stringify(identity.trace ?? [])
    );
  });
}
export function startDecisionAttempt(identity: AttemptIdentity): void {
  const db = getDbInstance();
  db.immediate(() => {
    assertUncappedDecision(identity.keyId, identity.provider, identity.model);
    const result = db
      .prepare(
        "UPDATE decision_application_attempts SET state='started',updated_at=? WHERE id=? AND state='reserved'"
      )
      .run(new Date().toISOString(), identity.id);
    if (result.changes !== 1) throw new Error("decision_attempt_already_started");
    incrementKeyQuotaCounter(identity.keyId, "rpm", 1);
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
};
/** Terminal outcome and known cost projection commit together. Idempotent, no zero substitution. */
function mergeReported(old: unknown, value: number | null): number | null {
  if (old !== null && old !== undefined && value !== null && old !== value)
    throw new Error("decision_settlement_conflict");
  return typeof old === "number" ? old : value;
}
function validUsage(usage: AttemptUsage): void {
  for (const field of ["reasoning", "cacheRead", "cacheCreation"] as const) {
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
  validUsage(usage);
  const db = getDbInstance();
  db.immediate(() => {
    const row = db
      .prepare("SELECT * FROM decision_application_attempts WHERE id=?")
      .get(identity.id) as Row | undefined;
    if (!row || !["started", "unknown", "completed"].includes(String(row.state)))
      throw new Error("decision_attempt_not_started");
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
    const consistent = reasoning === null || output === null || reasoning <= output;
    const visibleOutput = output === null || !consistent ? null : output - (reasoning ?? 0);
    const state = status === null ? "unknown" : "completed";
    db.prepare(
      "UPDATE decision_application_attempts SET state=?,http_status=?,input_tokens=?,output_tokens=?,cost_usd=?,updated_at=?,reasoning_tokens=?,cache_read_tokens=?,cache_creation_tokens=? WHERE id=?"
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
      `INSERT INTO usage_history(provider,model,connection_id,api_key_id,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_creation,status,success,timestamp,provider_cost_usd,decision_attempt_id,combo_strategy)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'decision-bounded-v1') ON CONFLICT(decision_attempt_id) DO UPDATE SET tokens_input=excluded.tokens_input,tokens_output=excluded.tokens_output,tokens_reasoning=excluded.tokens_reasoning,tokens_cache_read=excluded.tokens_cache_read,tokens_cache_creation=excluded.tokens_cache_creation,status=excluded.status,success=excluded.success,provider_cost_usd=excluded.provider_cost_usd`
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
      identity.id
    );
  });
}
export function cancelUnstartedDecision(id: string): void {
  getDbInstance()
    .prepare(
      "UPDATE decision_application_attempts SET state='cancelled',cost_usd=0,input_tokens=0,output_tokens=0,updated_at=? WHERE id=? AND state='reserved'"
    )
    .run(new Date().toISOString(), id);
}

export function decisionAuthorityStamp(identity: AttemptIdentity): string {
  const db = getDbInstance();
  const key = db
    .prepare(
      "SELECT key_hash,is_active,is_banned,revoked_at,expires_at,model_access_mode,allowed_models,blocked_models,allowed_combos,allowed_connections,allowed_quotas,disable_non_public_models,allowed_endpoints,scopes,access_schedule,forced_model,proxy_id,ip_allowlist,max_requests_per_day,max_requests_per_minute,max_sessions,rate_limits FROM api_keys WHERE id=?"
    )
    .get(identity.keyId);
  const connection = db
    .prepare(
      "SELECT provider,auth_type,is_active,api_key,provider_specific_data FROM provider_connections WHERE id=?"
    )
    .get(identity.connectionId);
  const combo = db.prepare("SELECT data FROM combos WHERE id=?").get(identity.comboId);
  const groups = db
    .prepare(
      "SELECT m.group_id,g.is_active,p.id,p.model_pattern,p.provider,p.access_type FROM key_group_members m JOIN key_groups g ON g.id=m.group_id LEFT JOIN group_model_permissions p ON p.group_id=m.group_id WHERE m.key_id=? ORDER BY m.group_id,p.id"
    )
    .all(identity.keyId);
  return JSON.stringify([key, connection, combo, groups]);
}

/** Application success is separate from raw provider HTTP success and possible billing. */
export function finishDecisionApplication(id: string, status: number): void {
  const db = getDbInstance();
  db.immediate(() => {
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
  });
}
