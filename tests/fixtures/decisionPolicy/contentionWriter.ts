/** Isolated test writer. Receives only the synthetic database filename and key ID. */
import assert from "node:assert/strict";
import path from "node:path";
import Database from "better-sqlite3";
const filename = process.argv[2],
  keyId = process.argv[3];
assert.ok(process.env.DATA_DIR);
assert.equal(path.dirname(filename), path.resolve(process.env.DATA_DIR));
const db = new Database(filename);
db.pragma("busy_timeout = 2000");
const journalMode = db.pragma("journal_mode", { simple: true });
assert.equal(journalMode, "wal");
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE api_keys SET name=name WHERE id=?").run(keyId);
const lockedAt = Date.now();
process.send?.({
  event: "locked",
  lockedAt,
  journalMode,
  busyTimeoutMs: db.pragma("busy_timeout", { simple: true }),
});
function release() {
  db.exec("ROLLBACK");
  const durationMs = Date.now() - lockedAt;
  db.close();
  if (process.connected)
    process.send?.({ event: "released", durationMs }, () => {
      process.disconnect();
    });
}
// Real elapsed hold in a separate process, longer than the application's busy timeout.
setTimeout(release, 4000);
