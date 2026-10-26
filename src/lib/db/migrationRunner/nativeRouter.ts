import path from "node:path";
import type { SqliteAdapter } from "../adapters/types";
import { readNamespacedMigrationFiles } from "./extraDirs";

type Migration = { version: string; name: string; path: string };
type Marker = { version: string; name: string };
const PREFIX = "nr-";
const LEGACY = [
  { version: "213", name: "decision_application_attempts" },
  { version: "214", name: "decision_claude_uncached_input" },
  { version: "215", name: "native_selection_lanes" },
] as const;
const NAMES = new Map<string, string>([
  ...LEGACY.map((m) => [PREFIX + m.version, m.name] as [string, string]),
  ["nr-216", "native_attempt_leases"],
]);
const BASE_COLUMNS = {
  id: "TEXT",
  api_key_id: "TEXT",
  combo_id: "TEXT",
  candidate_id: "TEXT",
  provider: "TEXT",
  model: "TEXT",
  connection_id: "TEXT",
  effort: "TEXT",
  state: "TEXT",
  http_status: "INTEGER",
  application_status: "INTEGER",
  input_tokens: "INTEGER",
  output_tokens: "INTEGER",
  cost_usd: "REAL",
  reasoning_tokens: "INTEGER",
  cache_read_tokens: "INTEGER",
  cache_creation_tokens: "INTEGER",
  selection_trace: "TEXT",
  created_at: "TEXT",
  updated_at: "TEXT",
};

export function getNativeRouterMigrations(coreDirectory: string): Migration[] {
  const dir = path.join(coreDirectory, "native-router");
  return readNamespacedMigrationFiles({ namespace: "nr", dir });
}

function fail(reason: string): never {
  throw new Error(`[Migration] Native router migration provenance is ambiguous: ${reason}.`);
}

function markers(db: SqliteAdapter): Map<string, Marker> {
  const rows = db.prepare("SELECT version,name FROM _omniroute_migrations").all() as Marker[];
  return new Map(rows.map((row) => [row.version, row]));
}

function requireColumns(db: SqliteAdapter, table: string, expected: Record<string, string>): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    fail(`required physical table ${table} is missing`);
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
  }>;
  const actual = new Map(columns.map((column) => [column.name, column.type.toUpperCase()]));
  for (const [name, type] of Object.entries(expected)) {
    if (actual.get(name) !== type)
      fail(`required ${table}.${name} ${type} is missing or incompatible`);
  }
}

function requireIndex(
  db: SqliteAdapter,
  table: string,
  name: string,
  columns: string[],
  unique: number,
  where?: RegExp
): void {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const index = rows.find((row) => row.name === name);
  if (!index || index.unique !== unique || index.partial !== (where ? 1 : 0))
    fail(`required index ${name} is missing or incompatible`);
  const fields = db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>;
  if (JSON.stringify(fields.map((field) => field.name)) !== JSON.stringify(columns))
    fail(`index ${name} has incompatible columns`);
  if (where) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
      .get(name) as { sql: string };
    if (!where.test(row.sql)) fail(`index ${name} has an incompatible predicate`);
  }
}

function requireAttemptConstraints(db: SqliteAdapter, number: number): void {
  const columns = db.prepare("PRAGMA table_info(decision_application_attempts)").all() as Array<{
    name: string;
    pk: number;
    notnull: number;
  }>;
  const primary = columns.filter((column) => column.pk > 0);
  if (primary.length !== 1 || primary[0].name !== "id")
    fail("attempt id must be the sole primary key column");
  const required = [
    "api_key_id",
    "combo_id",
    "candidate_id",
    "provider",
    "model",
    "connection_id",
    "effort",
    "state",
    "created_at",
    "updated_at",
  ];
  if (number >= 215) required.push("lane", "logical_counted");
  if (required.some((name) => columns.find((column) => column.name === name)?.notnull !== 1))
    fail("required attempt NOT NULL constraint is missing");
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='decision_application_attempts'"
    )
    .get() as { sql: string };
  const state =
    /CHECK\s*\(\s*state\s+IN\s*\(\s*'reserved'\s*,\s*'started'\s*,\s*'completed'\s*,\s*'unknown'\s*,\s*'cancelled'\s*\)\s*\)/i;
  if (!state.test(row.sql)) fail("attempt state constraint is missing or incompatible");
  if (
    number >= 215 &&
    !/CHECK\s*\(\s*lane\s+IN\s*\(\s*'decision'\s*,\s*'execution'\s*\)\s*\)/i.test(row.sql)
  )
    fail("attempt lane constraint is missing or incompatible");
}

function requireSchema(db: SqliteAdapter, number: number, leased: boolean): void {
  requireColumns(db, "decision_application_attempts", BASE_COLUMNS);
  requireAttemptConstraints(db, number);
  requireColumns(db, "usage_history", { decision_attempt_id: "TEXT" });
  requireIndex(
    db,
    "decision_application_attempts",
    "idx_decision_attempt_key",
    ["api_key_id", "state"],
    0
  );
  requireIndex(db, "usage_history", "idx_usage_decision_attempt", ["decision_attempt_id"], 1);
  if (!leased)
    requireIndex(
      db,
      "decision_application_attempts",
      "idx_decision_active_key",
      ["api_key_id"],
      1,
      /WHERE\s+state\s+IN\s*\(\s*'reserved'\s*,\s*'started'\s*\)/i
    );
  if (number >= 214)
    requireColumns(db, "decision_application_attempts", { uncached_input_tokens: "INTEGER" });
  if (number >= 215) {
    requireColumns(db, "decision_application_attempts", {
      lane: "TEXT",
      request_id: "TEXT",
      parent_attempt_id: "TEXT",
      logical_counted: "INTEGER",
      decision_outcome: "TEXT",
      selected_binding: "TEXT",
    });
    requireColumns(db, "usage_history", { decision_lane: "TEXT", decision_request_id: "TEXT" });
    requireIndex(
      db,
      "decision_application_attempts",
      "idx_native_execution_child",
      ["parent_attempt_id"],
      1,
      /WHERE\s+parent_attempt_id\s+IS\s+NOT\s+NULL/i
    );
  }
  if (number >= 216) {
    requireColumns(db, "decision_application_attempts", {
      lease_owner: "TEXT",
      lease_expires_at: "INTEGER",
      requested_model: "TEXT",
    });
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_decision_active_key'"
        )
        .get()
    )
      fail("obsolete exclusive active-key index remains");
  }
}

function relevant(files: Migration[]): Migration[] {
  return files.filter((file) => file.version.startsWith(PREFIX));
}

function requirePredecessors(applied: Map<string, Marker>, number: number): void {
  for (const predecessor of LEGACY) {
    if (Number(predecessor.version) >= number) continue;
    const old = applied.get(predecessor.version)?.name === predecessor.name;
    const current = applied.get(PREFIX + predecessor.version)?.name === predecessor.name;
    if (!old && !current) fail(`predecessor ${PREFIX + predecessor.version} is not recorded`);
  }
}

function validateLegacyMarkers(
  db: SqliteAdapter,
  bundled: Migration[],
  applied: Map<string, Marker>
): void {
  for (const legacy of LEGACY) {
    const row = applied.get(legacy.version);
    if (row?.name !== legacy.name) continue;
    const target = PREFIX + legacy.version;
    if (!bundled.some((file) => file.version === target && file.name === legacy.name))
      fail(`target ${target} is missing`);
    if (applied.has(target))
      fail(`both legacy ${legacy.version} and target ${target} are recorded`);
    requirePredecessors(applied, Number(legacy.version));
    requireSchema(db, Number(legacy.version), false);
  }
}

/** Read-only validation also covers an already-current/no-pending database. */
export function validateNativeRouterMigrations(db: SqliteAdapter, files: Migration[]): void {
  const bundled = relevant(files);
  if (bundled.length === 0) return;
  const applied = markers(db);
  const unknown = [...applied.values()].find(
    (row) => row.version.startsWith(PREFIX) && !NAMES.has(row.version)
  );
  if (unknown) fail(`unknown recorded namespace version ${unknown.version}`);
  const leased = applied.get("nr-216")?.name === NAMES.get("nr-216");
  for (const file of bundled) {
    if (NAMES.get(file.version) !== file.name)
      fail(`unknown bundled identity ${file.version}_${file.name}`);
    const row = applied.get(file.version);
    if (!row) continue;
    if (row.name !== file.name) fail(`target ${file.version} is occupied by ${row.name}`);
    requirePredecessors(applied, Number(file.version.slice(PREFIX.length)));
    requireSchema(db, Number(file.version.slice(PREFIX.length)), leased);
  }
  validateLegacyMarkers(db, bundled, applied);
}

export function hasNativeRouterLedgerRepair(db: SqliteAdapter, files: Migration[]): boolean {
  if (relevant(files).length === 0) return false;
  const applied = markers(db);
  return LEGACY.some((legacy) => applied.get(legacy.version)?.name === legacy.name);
}

/** Called under the runner's existing snapshot + IMMEDIATE safety transaction. */
export function reconcileNativeRouterMigrations(db: SqliteAdapter, files: Migration[]): void {
  validateNativeRouterMigrations(db, files);
  if (relevant(files).length === 0) return;
  for (const legacy of LEGACY) {
    db.prepare("UPDATE _omniroute_migrations SET version=? WHERE version=? AND name=?").run(
      PREFIX + legacy.version,
      legacy.version,
      legacy.name
    );
  }
}
