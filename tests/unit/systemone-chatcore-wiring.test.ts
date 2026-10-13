/** Ensure the decision-only guard is wired into the real chat dispatch entry. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("chatCore invokes the decision-only guard before executor header setup", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "open-sse/handlers/chatCore.ts"),
    "utf8"
  );
  const guard = source.indexOf("await decisionOnlyChatRejection(");
  const executorHeaders = source.indexOf("const getExecutorClientHeaders");
  assert.ok(guard >= 0, "chatCore must invoke the guard");
  assert.ok(executorHeaders >= 0, "chatCore executor setup marker missing");
  assert.ok(guard < executorHeaders, "decision-only rejection must precede executor setup");
});
