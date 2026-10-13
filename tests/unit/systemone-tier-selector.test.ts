import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "systemone-tier-selector-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { dispatchSystemOne } = await import("../../src/app/api/v1/systemone/dispatch.ts");
const { resolveSystemOneCandidates } = await import("../../open-sse/config/systemOneRegistry.ts");
const { handleSystemOneProxy } = await import("../../open-sse/handlers/systemOne.ts");
test.after(() => { resetDbInstance(); fs.rmSync(dataDir, { recursive: true, force: true }); });
test("real connection selector skips three tier-ineligible accounts before spending the attempt budget", async () => {
  const paidIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const row = await createProviderConnection({ provider: "opencode-zen", authType: "apikey", name: `synthetic-paid-${i}`, apiKey: ["synthetic", "paid", i].join("-"), priority: i + 1, isActive: true });
    paidIds.push(String(row?.id));
  }
  const free = await createProviderConnection({ provider: "opencode-zen", authType: "apikey", name: "synthetic-free", apiKey: ["synthetic", "free", "fourth"].join("-"), priority: 4, isActive: true, providerSpecificData: { systemOneTier: "free" } });
  const attempted: string[] = [];
  let outbound = 0;
  const response = await dispatchSystemOne({
    candidates: resolveSystemOneCandidates("jev-free"),
    requestedModel: "jev-free",
    allowedConnections: [...paidIds, String(free?.id)],
    body: { model: "jev-free", state: "Synthetic state", questions: { yes: { type: "noul" } } },
  }, {
    dispatch: async (options) => {
      attempted.push(String(options.credentials?.connectionId));
      return handleSystemOneProxy(options, { fetchSystemOne: async () => {
        outbound++;
        return new Response(JSON.stringify({ answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 8, output_tokens: 1 } }));
      } });
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(attempted, [String(free?.id)]);
  assert.equal(outbound, 1);
});
