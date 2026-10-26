import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-migrations-"));
const original = path.resolve("src/lib/db/migrations/native-router");
process.env.OMNIROUTE_MIGRATIONS_DIR = fixture;
const { runMigrations } = await import("../../../src/lib/db/migrationRunner.ts");
const names = [
  "213_decision_application_attempts.sql",
  "214_decision_claude_uncached_input.sql",
  "215_native_selection_lanes.sql",
  "216_native_attempt_leases.sql",
  "217_tool_continuations.sql",
];
function dbFixture(change?: (sql: string) => string) {
  fs.mkdirSync(path.join(fixture, "native-router"), { recursive: true });
  for (const name of names) {
    const sql = fs.readFileSync(path.join(original, name), "utf8");
    fs.writeFileSync(
      path.join(fixture, "native-router", name),
      name.startsWith("217_") && change ? change(sql) : sql
    );
  }
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE usage_history(id TEXT PRIMARY KEY); CREATE TABLE _omniroute_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT(datetime('now')))"
  );
  return db;
}
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
test("nr217 applies once and leaves an unrelated bare217 marker intact", () => {
  const db = dbFixture();
  db.prepare(
    "INSERT INTO _omniroute_migrations(version,name) VALUES('217','upstream_other')"
  ).run();
  try {
    assert.equal(runMigrations(db), 5);
    assert.equal(runMigrations(db), 0);
    assert.deepEqual(
      db
        .prepare(
          "SELECT version,name FROM _omniroute_migrations WHERE version IN ('217','nr-217') ORDER BY version"
        )
        .all(),
      [
        { version: "217", name: "upstream_other" },
        { version: "nr-217", name: "tool_continuations" },
      ]
    );
  } finally {
    db.close();
  }
});
for (const [label, change] of [
  ["primary", (sql: string) => sql.replace("id TEXT NOT NULL PRIMARY KEY", "id TEXT NOT NULL")],
  [
    "source-unique",
    (sql: string) =>
      sql.replace("source_attempt_id TEXT NOT NULL UNIQUE", "source_attempt_id TEXT NOT NULL"),
  ],
  [
    "claim-unique",
    (sql: string) => sql.replace("claimed_attempt_id TEXT UNIQUE", "claimed_attempt_id TEXT"),
  ],
  ["ordinal-unique", (sql: string) => sql.replace("UNIQUE(turn_id,ordinal)", "CHECK(1)")],
  [
    "foreign-key",
    (sql: string) =>
      sql.replace(
        "previous_turn_id TEXT REFERENCES decision_tool_turns(id) ON DELETE CASCADE",
        "previous_turn_id TEXT"
      ),
  ],
  [
    "state",
    (sql: string) =>
      sql.replace("CHECK(state IN ('issued','claimed','consumed','unknown'))", "CHECK(1)"),
  ],
  ["depth", (sql: string) => sql.replace("CHECK(depth BETWEEN 0 AND 31)", "CHECK(1)")],
  ["ordinal", (sql: string) => sql.replace("CHECK(ordinal BETWEEN 0 AND 31)", "CHECK(1)")],
] as const) {
  test(`an applied nr217 marker cannot hide malformed ${label} constraints`, () => {
    const db = dbFixture(change);
    try {
      for (const name of names) {
        db.exec(fs.readFileSync(path.join(fixture, "native-router", name), "utf8"));
        db.prepare("INSERT INTO _omniroute_migrations(version,name) VALUES(?,?)").run(
          "nr-" + name.slice(0, 3),
          name.slice(4, -4)
        );
      }
      assert.throws(() => runMigrations(db), /provenance is ambiguous/);
    } finally {
      db.close();
    }
  });
}
