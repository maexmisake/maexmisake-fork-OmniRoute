import { getDbInstance } from "./core";

export type NativeAttemptInspectionQuery = {
  limit: number;
  combo?: string;
  since?: string;
  until?: string;
  cursor?: number;
};

/** Bounded metadata read only. Never expires leases, decrypts credentials or settles attempts. */
export function readNativeAttemptInspectionRows(query: NativeAttemptInspectionQuery) {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)
    throw new Error("invalid_inspection_limit");
  const conditions = ["1=1"];
  const args: Array<string | number> = [];
  const filters = [
    [query.combo, "combo_id = ?"],
    [query.since, "created_at >= ?"],
    [query.until, "created_at <= ?"],
    [query.cursor, "rowid < ?"],
  ] as const;
  for (const [value, condition] of filters) {
    if (value === undefined) continue;
    conditions.push(condition);
    args.push(value);
  }
  // Never read more than100 rows. A full page may conservatively offer an empty next page.
  args.push(query.limit);
  return getDbInstance()
    .prepare(
      `SELECT rowid AS inspection_order,id,request_id,parent_attempt_id,combo_id,candidate_id,
       provider,model,effort,lane,state,http_status,application_status,decision_outcome,
       input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_creation_tokens,
       cost_usd,selection_trace,selected_binding,lease_expires_at,created_at,updated_at
       FROM decision_application_attempts WHERE ${conditions.join(" AND ")}
       ORDER BY rowid DESC LIMIT ?`
    )
    .all(...args) as Array<Record<string, unknown>>;
}
