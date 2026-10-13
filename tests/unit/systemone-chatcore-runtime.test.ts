import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemone-chatcore-runtime-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
test.after(() => { resetDbInstance(); fs.rmSync(dataDir, { recursive: true, force: true }); });
test("real chatCore rejects an untagged decision with the normal result envelope, no fetch", async () => {
  const originalFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error("unexpected outbound dispatch"); };
  try {
    const result = await handleChatCore({
      body: { model: "opencode-zen/jev-1.13", messages: [{ role: "user", content: "Synthetic test" }] },
      modelInfo: { provider: "opencode-zen", model: "jev-1.13" },
      credentials: { apiKey: ["synthetic", "chatcore", "fixture"].join("-") },
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.equal(result.response?.status, 400);
    assert.equal(outbound, 0);
  } finally { globalThis.fetch = originalFetch; }
});
