import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.ts";

const source = path.resolve("src/lib/db/migrations");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "native-migrations-"));
process.env.OMNIROUTE_MIGRATIONS_DIR = fixture;
const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");
const { getPlausiblePendingCount } =
  await import("../../src/lib/db/migrationRunner/schemaState.ts");
const originals = [
  "213_decision_application_attempts.sql",
  "214_decision_claude_uncached_input.sql",
  "215_native_selection_lanes.sql",
];
const timestamp = "2026-10-24T12:00:00.000Z";

function originalSql(name: string): string {
  const bundled = path.join(source, "native-router", name);
  return fs.readFileSync(fs.existsSync(bundled) ? bundled : path.join(source, name), "utf8");
}

function installBundle(): void {
  const target = path.join(fixture, "native-router");
  fs.mkdirSync(target, { recursive: true });
  for (const name of originals) fs.writeFileSync(path.join(target, name), originalSql(name));
  const lease = path.join(source, "native-router", "216_native_attempt_leases.sql");
  if (fs.existsSync(lease)) fs.copyFileSync(lease, path.join(target, path.basename(lease)));
}

function baseDb(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE usage_history(id TEXT PRIMARY KEY);
    CREATE TABLE _omniroute_migrations(
      version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function applyLegacy(db: Database.Database, count = 3): void {
  for (const name of originals.slice(0, count)) {
    db.exec(originalSql(name));
    db.prepare("INSERT INTO _omniroute_migrations VALUES(?,?,?)").run(
      name.slice(0, 3),
      name.slice(4, -4),
      timestamp
    );
  }
}

function attempt(db: Database.Database, id: string, state: string, cost: number | null): void {
  db.prepare(
    `INSERT INTO decision_application_attempts
    (id,api_key_id,combo_id,candidate_id,provider,model,connection_id,effort,state,cost_usd,created_at,updated_at)
    VALUES(?, ?, 'fixture-combo', 'fixture-candidate', 'fixture-provider', 'fixture-model',
      'fixture-connection', 'high', ?, ?, ?, ?)`
  ).run(id, `fixture-key-${id}`, state, cost, timestamp, timestamp);
}

test.beforeEach(() => {
  for (const name of fs.readdirSync(fixture)) {
    fs.rmSync(path.join(fixture, name), { recursive: true, force: true });
  }
});
test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test("fresh native migrations use a bundled namespace and can run twice", () => {
  installBundle();
  const db = baseDb();
  try {
    assert.equal(runMigrations(db), 4);
    assert.deepEqual(
      db.prepare("SELECT version FROM _omniroute_migrations ORDER BY version").all(),
      ["nr-213", "nr-214", "nr-215", "nr-216"].map((version) => ({ version }))
    );
    assert.equal(runMigrations(db), 0);
    const columns = db.prepare("PRAGMA table_info(decision_application_attempts)").all() as Array<{
      name: string;
    }>;
    assert.ok(columns.some((c) => c.name === "lease_owner"));
    assert.ok(columns.some((c) => c.name === "lease_expires_at"));
    assert.ok(columns.some((c) => c.name === "requested_model"));
  } finally {
    db.close();
  }
});

test("the three relocated legacy SQL files retain their published feature bytes", () => {
  const hashes = [
    "5bae9ae34c3d459297911707b177fea4c440fb59f11c2b1d63cf166940165a5f",
    "e62fce4136cb7bcc1adc78cfa18d8eb74b30d083108859aac5888e1d4e5e4773",
    "44b816f0644364e0cf04a3f07d765a43cb44d5b57d299053d743f56795a4a56b",
  ];
  originals.forEach((name, index) =>
    assert.equal(createHash("sha256").update(originalSql(name)).digest("hex"), hashes[index])
  );
});

test("legacy marker names cannot certify a table missing primary-key or state constraints", () => {
  for (const broken of [
    { from: "id TEXT PRIMARY KEY", to: "id TEXT" },
    { from: "id TEXT PRIMARY KEY", to: "id TEXT", composite: true },
    { from: "CHECK (state IN ('reserved','started','completed','unknown','cancelled'))", to: "" },
  ]) {
    const db = baseDb();
    try {
      for (const name of originals) {
        const sql = originalSql(name);
        let changed = name.startsWith("213_") ? sql.replace(broken.from, broken.to) : sql;
        if (name.startsWith("213_") && "composite" in broken) {
          changed = changed.replace(
            "updated_at TEXT NOT NULL\n);",
            "updated_at TEXT NOT NULL,\n  PRIMARY KEY(id,api_key_id)\n);"
          );
        }
        db.exec(changed);
        db.prepare("INSERT INTO _omniroute_migrations VALUES(?,?,?)").run(
          name.slice(0, 3),
          name.slice(4, -4),
          timestamp
        );
      }
      installBundle();
      const before = db.prepare("SELECT * FROM _omniroute_migrations ORDER BY version").all();
      assert.throws(() => runMigrations(db));
      assert.deepEqual(
        db.prepare("SELECT * FROM _omniroute_migrations ORDER BY version").all(),
        before
      );
    } finally {
      db.close();
    }
  }
});

test("mass-migration safety includes required namespaced work in its plausible bound", () => {
  const files = ["212", "nr-213", "nr-214", "nr-215", "nr-216"].map((version) => ({
    version,
    name: "fixture",
    path: "fixture",
  }));
  assert.equal(getPlausiblePendingCount(files, "211"), 5);
});

test("legacy applied markers retain their timestamps and known receipts", () => {
  const db = baseDb();
  try {
    applyLegacy(db);
    attempt(db, "completed", "completed", 0.125);
    installBundle();
    assert.equal(runMigrations(db), 1);
    const records = db
      .prepare(
        "SELECT version,applied_at FROM _omniroute_migrations WHERE version != 'nr-216' ORDER BY version"
      )
      .all();
    assert.deepEqual(
      records,
      ["nr-213", "nr-214", "nr-215"].map((version) => ({ version, applied_at: timestamp }))
    );
    assert.deepEqual(
      db
        .prepare("SELECT state,cost_usd FROM decision_application_attempts WHERE id='completed'")
        .get(),
      { state: "completed", cost_usd: 0.125 }
    );
    assert.equal(
      (
        db
          .prepare("SELECT requested_model FROM decision_application_attempts WHERE id='completed'")
          .get() as { requested_model: string | null }
      ).requested_model,
      null
    );
    assert.equal(runMigrations(db), 0);
  } finally {
    db.close();
  }
});

test("a future numeric 213 fixture remains independent of old feature 213", () => {
  const db = baseDb();
  try {
    applyLegacy(db);
    installBundle();
    fs.writeFileSync(
      path.join(fixture, "213_synthetic_upstream_fixture.sql"),
      "CREATE TABLE upstream_fixture(id TEXT PRIMARY KEY);"
    );
    assert.equal(runMigrations(db), 2);
    assert.ok(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upstream_fixture'")
        .get()
    );
    assert.equal(
      (
        db.prepare("SELECT name FROM _omniroute_migrations WHERE version='213'").get() as {
          name: string;
        }
      ).name,
      "synthetic_upstream_fixture"
    );
    assert.equal(
      (
        db.prepare("SELECT name FROM _omniroute_migrations WHERE version='nr-213'").get() as {
          name: string;
        }
      ).name,
      "decision_application_attempts"
    );
  } finally {
    db.close();
  }
});

test("partial physical schema or occupied namespaced targets fail without changing legacy markers", () => {
  for (const scenario of [
    "missing-column",
    "missing-index",
    "missing-predecessor",
    "unknown-namespace",
    "occupied-target",
    "duplicate-target",
  ]) {
    const db = baseDb();
    try {
      applyLegacy(db);
      if (scenario === "missing-column")
        db.exec("ALTER TABLE decision_application_attempts DROP COLUMN selected_binding");
      else if (scenario === "missing-index") db.exec("DROP INDEX idx_native_execution_child");
      else if (scenario === "missing-predecessor")
        db.exec("DELETE FROM _omniroute_migrations WHERE version='214'");
      else if (scenario === "unknown-namespace")
        db.prepare("INSERT INTO _omniroute_migrations VALUES(?,?,?)").run(
          "nr-999",
          "unknown_fixture",
          timestamp
        );
      else
        db.prepare("INSERT INTO _omniroute_migrations VALUES(?,?,?)").run(
          "nr-213",
          scenario === "duplicate-target" ? "decision_application_attempts" : "unknown_fixture",
          timestamp
        );
      installBundle();
      const before = db.prepare("SELECT * FROM _omniroute_migrations ORDER BY version").all();
      assert.throws(() => runMigrations(db));
      assert.deepEqual(
        db.prepare("SELECT * FROM _omniroute_migrations ORDER BY version").all(),
        before
      );
    } finally {
      db.close();
    }
  }
});

test("an already applied unrelated numeric 213 does not shadow the native namespace", () => {
  const db = baseDb();
  try {
    db.exec("CREATE TABLE upstream_fixture(id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO _omniroute_migrations VALUES(?,?,?)").run(
      "213",
      "synthetic_upstream_fixture",
      timestamp
    );
    fs.writeFileSync(
      path.join(fixture, "213_synthetic_upstream_fixture.sql"),
      "CREATE TABLE upstream_fixture(id TEXT PRIMARY KEY);"
    );
    installBundle();
    assert.equal(runMigrations(db), 4);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE name='decision_application_attempts'").get()
    );
    assert.equal(runMigrations(db), 0);
  } finally {
    db.close();
  }
});

test("a database with only original feature 213 upgrades remaining native migrations", () => {
  const db = baseDb();
  try {
    applyLegacy(db, 1);
    installBundle();
    assert.equal(runMigrations(db), 3);
    assert.equal(
      (
        db.prepare("SELECT applied_at FROM _omniroute_migrations WHERE version='nr-213'").get() as {
          applied_at: string;
        }
      ).applied_at,
      timestamp
    );
  } finally {
    db.close();
  }
});

test("the actual ad6 stable SQL set upgrades without replacing core migration identities", () => {
  // Retained core bytes are pinned to ad6; no sibling checkout is required in CI.
  const stable = source;
  const files = fs
    .readdirSync(stable)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.equal(files.length, 209);
  const fingerprint = files.map((name) => [
    name,
    createHash("sha256")
      .update(fs.readFileSync(path.join(stable, name)))
      .digest("hex"),
  ]);
  assert.equal(
    createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
    "5fe9c4180e9edfab6ec35e53e491f5f3888ee5398f093ff5e676cf942fae515b"
  );
  for (const name of files) fs.copyFileSync(path.join(stable, name), path.join(fixture, name));
  const db = new Database(":memory:");
  try {
    // Normal startup creates the inline base tables before invoking the SQL runner.
    const core = fs.readFileSync(path.join(stable, "..", "core.ts"), "utf8");
    const schema = core.match(/const SCHEMA_SQL = `([\s\S]*?)`;/)?.[1];
    assert.ok(schema && !schema.includes("${"), "pinned base schema must remain literal SQL");
    assert.equal(
      createHash("sha256").update(schema).digest("hex"),
      "c9898e5ee1be915eab99fe261e466aefc68716b21e9c165adfc740bf48e2c781"
    );
    db.exec(schema);
    assert.equal(runMigrations(db, { isNewDb: true }), 209);
    const before = db.prepare("SELECT * FROM _omniroute_migrations ORDER BY version").all();
    installBundle();
    assert.equal(runMigrations(db), 4);
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM _omniroute_migrations WHERE version NOT LIKE 'nr-%' ORDER BY version"
        )
        .all(),
      before
    );
    assert.equal(runMigrations(db), 0);
    const fresh = new Database(":memory:");
    try {
      fresh.exec(schema);
      assert.equal(runMigrations(fresh, { isNewDb: true }), 213);
      assert.equal(runMigrations(fresh), 0);
    } finally {
      fresh.close();
    }
  } finally {
    db.close();
  }
});

test("lease upgrade cancels only never-started work and retains unknown or reported charges", () => {
  const db = baseDb();
  try {
    applyLegacy(db);
    attempt(db, "reserved", "reserved", null);
    attempt(db, "started", "started", 0.25);
    attempt(db, "unknown", "unknown", null);
    installBundle();
    assert.equal(runMigrations(db), 1);
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,state,input_tokens,output_tokens,cost_usd FROM decision_application_attempts ORDER BY id"
        )
        .all(),
      [
        { id: "reserved", state: "cancelled", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        {
          id: "started",
          state: "unknown",
          input_tokens: null,
          output_tokens: null,
          cost_usd: 0.25,
        },
        {
          id: "unknown",
          state: "unknown",
          input_tokens: null,
          output_tokens: null,
          cost_usd: null,
        },
      ]
    );
    const indexes = db.prepare("PRAGMA index_list(decision_application_attempts)").all() as Array<{
      name: string;
      unique: number;
    }>;
    assert.equal(
      indexes.some((i) => i.name === "idx_decision_active_key"),
      false
    );
    assert.equal(indexes.find((i) => i.name === "idx_native_execution_child")?.unique, 1);
  } finally {
    db.close();
  }
});

test("a disposable native database reopens with namespaced markers and original receipts intact", () => {
  const filename = path.join(fixture, "fixture.sqlite");
  const raw = baseDb(filename);
  applyLegacy(raw);
  attempt(raw, "known-receipt", "completed", 0.5);
  installBundle();
  const first = createBetterSqliteAdapter(raw);
  try {
    assert.equal(runMigrations(first), 1);
  } finally {
    first.close();
  }
  const reopened = createBetterSqliteAdapter(new Database(filename));
  try {
    assert.equal(runMigrations(reopened), 0);
    assert.deepEqual(
      reopened
        .prepare(
          "SELECT state,cost_usd,requested_model FROM decision_application_attempts WHERE id='known-receipt'"
        )
        .get(),
      { state: "completed", cost_usd: 0.5, requested_model: null }
    );
    assert.equal(
      (
        reopened
          .prepare("SELECT applied_at FROM _omniroute_migrations WHERE version='nr-213'")
          .get() as { applied_at: string }
      ).applied_at,
      timestamp
    );
  } finally {
    reopened.close();
  }
});
function installSessionBundle(change?: (sql: string) => string) {
  installBundle();
  const dir = path.join(fixture, "native-router");
  fs.copyFileSync(
    path.join(source, "native-router/217_tool_continuations.sql"),
    path.join(dir, "217_tool_continuations.sql")
  );
  const sql = fs.readFileSync(path.join(source, "native-router/218_routing_sessions.sql"), "utf8");
  fs.writeFileSync(path.join(dir, "218_routing_sessions.sql"), change ? change(sql) : sql);
}
test("session migration has a distinct namespace, validates ownership keys and reopens idempotently", () => {
  installSessionBundle();
  const db = createBetterSqliteAdapter(baseDb());
  try {
    assert.equal(runMigrations(db), 6);
    assert.equal(runMigrations(db), 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM decision_routing_sessions").get() as { n: number }).n,
      0
    );
  } finally {
    db.close();
  }
});
for (const [name, from, to] of [
  ["primary key", "id TEXT PRIMARY KEY NOT NULL", "id TEXT NOT NULL"],
  ["owner nullability", "api_key_id TEXT NOT NULL", "api_key_id TEXT"],
  ["counter default", "turns INTEGER NOT NULL DEFAULT 0", "turns INTEGER NOT NULL DEFAULT 1"],
  ["state check", "CHECK(state IN ('idle','claimed','unknown'))", ""],
])
  test(`session migration rejects incompatible ${name} without recording nr218`, () => {
    installSessionBundle((sql) => {
      assert.ok(sql.includes(from));
      return sql.replace(from, to);
    });
    const db = createBetterSqliteAdapter(baseDb());
    try {
      assert.throws(() => runMigrations(db), /migration provenance is ambiguous/i);
      assert.equal(
        db.prepare("SELECT 1 FROM _omniroute_migrations WHERE version='nr-218'").get(),
        undefined
      );
      assert.equal(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='decision_routing_sessions'"
          )
          .get(),
        undefined
      );
    } finally {
      db.close();
    }
  });

function installResponseBundle(change?: (sql: string) => string) {
  installSessionBundle();
  const sql = fs.readFileSync(
    path.join(source, "native-router/219_response_histories.sql"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(fixture, "native-router/219_response_histories.sql"),
    change ? change(sql) : sql
  );
}
test("encrypted Responses history migration validates its own namespace and reopens idempotently", () => {
  installResponseBundle();
  const db = createBetterSqliteAdapter(baseDb());
  try {
    assert.equal(runMigrations(db), 7);
    assert.equal(runMigrations(db), 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM decision_response_histories").get() as { n: number })
        .n,
      0
    );
  } finally {
    db.close();
  }
});
for (const [name, from, to] of [
  ["primary key", "id TEXT PRIMARY KEY NOT NULL", "id TEXT NOT NULL"],
  ["owner nullability", "owner TEXT NOT NULL", "owner TEXT"],
  ["state check", "CHECK(state IN ('pending','ready','unknown'))", ""],
])
  test(`Responses history migration rejects incompatible ${name} without recording nr219`, () => {
    installResponseBundle((sql) => {
      assert.ok(sql.includes(from));
      return sql.replace(from, to);
    });
    const db = createBetterSqliteAdapter(baseDb());
    try {
      assert.throws(() => runMigrations(db), /migration provenance is ambiguous/i);
      assert.equal(
        db.prepare("SELECT 1 FROM _omniroute_migrations WHERE version='nr-219'").get(),
        undefined
      );
      assert.equal(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='decision_response_histories'"
          )
          .get(),
        undefined
      );
    } finally {
      db.close();
    }
  });
