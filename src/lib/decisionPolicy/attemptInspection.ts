import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const timestamp = z.string().max(40).datetime({ offset: true });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const money = z.number().finite().nonnegative().nullable();
const status = z.number().int().min(100).max(599).nullable();
const state = z.enum(["reserved", "started", "completed", "unknown", "cancelled"]);
const phase = z.enum(["eligibility", "selection", "output_policy", "difficulty", "preference"]);
const REASONS = [
  "eligible",
  "effort_unproven",
  "invalid_preserved_effort",
  "reasoning_effort_required",
  "client_effort_mismatch",
  "unauthorized_or_unknown",
  "unavailable_or_unknown",
  "quota_exhausted",
  "quota_unknown",
  "text_unproven",
  "images_unproven",
  "tools_unproven",
  "context_unproven_or_exceeded",
  "recursion_unproven",
  "profile_unverified",
  "continuation_pin",
  "task_preference_unresolved",
  "tool_execution_unproven",
  "execution_contract_unproven",
  "sole_eligible_no_decision",
  "deterministic_no_decision",
  "provider_native_limit_not_enforced",
  "native_choice",
  "local_difficulty_easy",
  "local_difficulty_moderate",
  "local_difficulty_difficult",
  "local_difficulty_critical",
  "local_difficulty_unknown",
  "difficulty_scoped_order",
] as const;
const reason = z.enum(REASONS);
const outcome = z
  .enum([
    "selected",
    "refused",
    "unknown",
    "invalid",
    "retryable",
    "auth",
    "denied",
    "cancelled",
    "timeout",
    "selection_unavailable",
  ])
  .nullable();
const trace = z
  .object({ phase, candidateId: identifier.nullable(), reasons: z.array(reason).max(20) })
  .strict();
const selected = z
  .object({
    candidateId: identifier.nullable(),
    provider: z.string().max(100).nullable(),
    model: z.string().max(200).nullable(),
    effort: z.string().max(20).nullable(),
  })
  .strict();
export const nativeAttemptInspectionSchema = z
  .object({
    id: identifier.nullable(),
    requestId: identifier.nullable(),
    parentAttemptId: identifier.nullable(),
    comboId: identifier.nullable(),
    candidateId: identifier.nullable(),
    provider: z.string().max(100).nullable(),
    model: z.string().max(200).nullable(),
    effort: z.string().max(20).nullable(),
    lane: z.enum(["decision", "execution"]).nullable(),
    state: state.nullable(),
    httpStatus: status,
    applicationStatus: status,
    decisionOutcome: outcome,
    inputTokens: count,
    outputTokens: count,
    reasoningTokens: count,
    cacheReadTokens: count,
    cacheCreationTokens: count,
    costUsd: money,
    selected: selected.nullable(),
    lease: z.enum(["active", "expired", "released", "unknown"]),
    createdAt: timestamp.nullable(),
    updatedAt: timestamp.nullable(),
    trace: z.array(trace).max(32),
  })
  .strict();
export const nativeAttemptInspectionPageSchema = z
  .object({
    observedAt: timestamp,
    rows: z.array(nativeAttemptInspectionSchema).max(100),
    nextCursor: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .nullable(),
  })
  .strict();
export type NativeAttemptInspectionPage = z.infer<typeof nativeAttemptInspectionPageSchema>;
const querySchema = z
  .object({
    combo: identifier.optional(),
    since: timestamp.optional(),
    until: timestamp.optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .pipe(z.number().max(100))
      .default(25),
    cursor: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .transform(Number)
      .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
      .optional(),
  })
  .strict();

export function parseNativeAttemptInspectionQuery(params: URLSearchParams) {
  const entries = [...params.entries()];
  if (
    entries.length > 5 ||
    entries.some(([key, value]) => key.length > 10 || value.length > 200) ||
    new Set(params.keys()).size !== entries.length
  )
    return null;
  const parsed = querySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return null;
  const result = parsed.data;
  if (result.since && result.until && Date.parse(result.since) > Date.parse(result.until))
    return null;
  return {
    ...result,
    ...(result.since ? { since: new Date(result.since).toISOString() } : {}),
    ...(result.until ? { until: new Date(result.until).toISOString() } : {}),
  };
}
function safeText(value: unknown, max = 200): string | null {
  return typeof value === "string" &&
    value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) &&
    !/(?:oc_sk_|sk-(?:proj-|or-v1-)?|bearer|https?:|eyJ)/i.test(value)
    ? value
    : null;
}
function safeId(value: unknown): string | null {
  return identifier.safeParse(value).success ? safeText(value) : null;
}
function safeCount(value: unknown): number | null {
  return count.safeParse(value).success ? (value as number | null) : null;
}
function safeTime(value: unknown): string | null {
  return timestamp.safeParse(value).success ? (value as string) : null;
}
function safeSelection(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const record: unknown = JSON.parse(value);
    if (!Array.isArray(record) || record.length !== 5) return null;
    return {
      candidateId: safeId(record[0]),
      provider: safeText(record[1], 100),
      model: safeText(record[2]),
      effort: safeText(record[3], 20),
    };
  } catch {
    return null;
  }
}

function safeTrace(value: unknown): z.infer<typeof trace>[] {
  if (typeof value !== "string" || value.length > 32768) return [];
  try {
    const records: unknown = JSON.parse(value);
    if (!Array.isArray(records)) return [];
    return records.slice(0, 32).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (!phase.safeParse(row.phase).success || typeof row.reason !== "string") return [];
      const reasons = row.reason.split(",");
      const result = trace.safeParse({ phase: row.phase, candidateId: safeId(row.id), reasons });
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}
function observedLease(row: Record<string, unknown>, now: number) {
  if (!state.safeParse(row.state).success) return "unknown" as const;
  if (row.state !== "reserved" && row.state !== "started") return "released" as const;
  if (typeof row.lease_expires_at !== "number" || !Number.isFinite(row.lease_expires_at))
    return "unknown" as const;
  return row.lease_expires_at <= now ? ("expired" as const) : ("active" as const);
}
export function projectNativeAttempt(row: Record<string, unknown>, now: number) {
  return nativeAttemptInspectionSchema.parse({
    id: safeId(row.id),
    requestId: safeId(row.request_id),
    parentAttemptId: safeId(row.parent_attempt_id),
    comboId: safeId(row.combo_id),
    candidateId: safeId(row.candidate_id),
    provider: safeText(row.provider, 100),
    model: safeText(row.model),
    effort: safeText(row.effort, 20),
    lane: row.lane === "decision" || row.lane === "execution" ? row.lane : null,
    state: state.safeParse(row.state).success ? row.state : null,
    httpStatus: status.safeParse(row.http_status).success ? row.http_status : null,
    applicationStatus: status.safeParse(row.application_status).success
      ? row.application_status
      : null,
    decisionOutcome: outcome.safeParse(row.decision_outcome).success ? row.decision_outcome : null,
    inputTokens: safeCount(row.input_tokens),
    outputTokens: safeCount(row.output_tokens),
    reasoningTokens: safeCount(row.reasoning_tokens),
    cacheReadTokens: safeCount(row.cache_read_tokens),
    cacheCreationTokens: safeCount(row.cache_creation_tokens),
    costUsd: money.safeParse(row.cost_usd).success ? row.cost_usd : null,
    selected: safeSelection(row.selected_binding),
    lease: observedLease(row, now),
    createdAt: safeTime(row.created_at),
    updatedAt: safeTime(row.updated_at),
    trace: safeTrace(row.selection_trace),
  });
}
export function projectNativeAttemptPage(
  rows: Record<string, unknown>[],
  limit: number,
  now = Date.now()
) {
  const page = rows.slice(0, limit);
  const last = page.at(-1)?.inspection_order;
  return nativeAttemptInspectionPageSchema.parse({
    observedAt: new Date(now).toISOString(),
    rows: page.map((row) => projectNativeAttempt(row, now)),
    nextCursor: rows.length === limit && typeof last === "number" ? String(last) : null,
  });
}
