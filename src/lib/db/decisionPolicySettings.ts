/** Local-only, synchronous CAS for the decision-policy subtree and Zen tier marker. */
import { createHash } from "node:crypto";
import { getDbInstance, rowToCamel } from "./core";
import { decryptConnectionFields } from "./encryption";
import { invalidateDbCache } from "./readCache";

type Row = Record<string, unknown>;
export class DecisionSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      "not_found" | "stale_revision" | "invalid_settings" | "unsupported_connection" | "cancelled"
  ) {
    super(code);
  }
}
export function settingsRecord(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}
function parsedRecord(value: unknown): Row | null {
  if (typeof value !== "string") return null;
  try {
    return settingsRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
function revision(row: Row): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}
function nextTimestamp(previous: unknown): string {
  const parsed = typeof previous === "string" ? Date.parse(previous) : NaN;
  return new Date(Math.max(Date.now(), Number.isFinite(parsed) ? parsed + 1 : 0)).toISOString();
}
function notCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DecisionSettingsError(499, "cancelled");
}
function comboRow(id: string): Row {
  const row = getDbInstance().prepare("SELECT id,name,data FROM combos WHERE id=?").get(id) as
    Row | undefined;
  if (!row) throw new DecisionSettingsError(404, "not_found");
  return row;
}
export function readStoredDecisionSettings(id: string) {
  const row = comboRow(id);
  const data = parsedRecord(row.data);
  if (!data) throw new DecisionSettingsError(400, "invalid_settings");
  const config = settingsRecord(data.config);
  return {
    comboId: String(row.id),
    name: String(row.name),
    revision: revision(row),
    hasPolicy: !!config && Object.hasOwn(config, "decisionPolicy"),
    rawPolicy: config?.decisionPolicy ?? null,
  };
}
export function listDecisionComboNames(): Array<{ id: string; name: string }> {
  return getDbInstance().prepare("SELECT id,name FROM combos ORDER BY name,id").all() as Array<{
    id: string;
    name: string;
  }>;
}
function connectionView(row: Row): Row {
  return {
    id: row.id,
    provider: row.provider,
    auth_type: row.auth_type,
    is_active: row.is_active,
    provider_specific_data: row.provider_specific_data,
    updated_at: row.updated_at,
    credential_present: [
      row.auth_type === "oauth"
        ? row.access_token
        : row.auth_type === "apikey"
          ? row.api_key
          : null,
    ].some((value) => typeof value === "string" && value.trim())
      ? 1
      : 0,
    revision: revision(row),
  };
}
export function readDecisionConnectionRows(): Row[] {
  return (
    getDbInstance()
      .prepare("SELECT * FROM provider_connections ORDER BY provider,id")
      .all() as Row[]
  ).map(connectionView);
}
function connectionRow(id: string): Row {
  const row = getDbInstance().prepare("SELECT * FROM provider_connections WHERE id=?").get(id) as
    Row | undefined;
  if (!row) throw new DecisionSettingsError(404, "not_found");
  return connectionView(row);
}
export function connectionSettingsRevision(row: Row): string {
  return String(row.revision);
}
export function storedConnectionMetadata(row: Row): Row | null {
  return row.provider_specific_data == null ? {} : parsedRecord(row.provider_specific_data);
}
/** Internal activation validation only; never used by a response projector. */
export function readDecisionActivationConnection(id: string): Row | null {
  const row = getDbInstance().prepare("SELECT * FROM provider_connections WHERE id=?").get(id);
  return row ? decryptConnectionFields(rowToCamel(row)) : null;
}
export function compareAndSetDecisionPolicy(options: {
  id: string;
  expectedRevision: string;
  action: "save" | "disable";
  policy?: unknown;
  validate: (policy: unknown) => void;
  signal?: AbortSignal;
}): void {
  notCancelled(options.signal);
  const db = getDbInstance();
  db.immediate(() => {
    notCancelled(options.signal);
    const row = comboRow(options.id);
    if (revision(row) !== options.expectedRevision)
      throw new DecisionSettingsError(409, "stale_revision");
    const data = parsedRecord(row.data);
    if (!data) throw new DecisionSettingsError(400, "invalid_settings");
    const config = settingsRecord(data.config);
    if (data.config != null && !config) throw new DecisionSettingsError(400, "invalid_settings");
    const nextConfig = { ...config };
    if (options.action === "save") {
      options.validate(options.policy);
      nextConfig.decisionPolicy = options.policy;
    } else if (Object.hasOwn(nextConfig, "decisionPolicy")) {
      nextConfig.decisionPolicy = { ...settingsRecord(nextConfig.decisionPolicy), enabled: false };
    }
    const now = nextTimestamp(data.updatedAt);
    const next = { ...data, config: nextConfig, updatedAt: now };
    notCancelled(options.signal);
    const changed = db
      .prepare("UPDATE combos SET data=?,updated_at=? WHERE id=? AND data=?")
      .run(JSON.stringify(next), now, options.id, row.data);
    if (changed.changes !== 1) throw new DecisionSettingsError(409, "stale_revision");
  });
  invalidateDbCache("combos");
}
export function compareAndSetZenTier(options: {
  id: string;
  expectedRevision: string;
  tier: "free" | "paid";
  signal?: AbortSignal;
}): void {
  notCancelled(options.signal);
  const db = getDbInstance();
  db.immediate(() => {
    notCancelled(options.signal);
    const row = connectionRow(options.id);
    if (connectionSettingsRevision(row) !== options.expectedRevision)
      throw new DecisionSettingsError(409, "stale_revision");
    if (row.provider !== "opencode-zen")
      throw new DecisionSettingsError(400, "unsupported_connection");
    const metadata = storedConnectionMetadata(row);
    if (!metadata) throw new DecisionSettingsError(400, "invalid_settings");
    // Only this own marker changes; ciphertext and unrelated/unsupported metadata remain intact.
    const next = { ...metadata };
    if (options.tier === "free") next.systemOneTier = "free";
    else delete next.systemOneTier;
    notCancelled(options.signal);
    db.prepare(
      "UPDATE provider_connections SET provider_specific_data=?,updated_at=? WHERE id=?"
    ).run(JSON.stringify(next), nextTimestamp(row.updated_at), options.id);
  });
  invalidateDbCache("connections");
}
