import assert from "node:assert/strict";
import { test } from "node:test";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { fetch } from "undici";
import { getGuardedDispatcher } from "../../open-sse/utils/connectGuardDispatcher.ts";
test("strict existing dispatcher offers only HTTP1 to actual TLS connector", async () => {
  const original = tls.connect;
  const captured: unknown[] = [];
  tls.connect = ((options: Record<string, unknown>) => {
    captured.push(options.ALPNProtocols);
    throw new Error("synthetic TLS interception before any network");
  }) as typeof tls.connect;
  syncBuiltinESMExports();
  const dispatcher = getGuardedDispatcher("block-metadata", true);
  try {
    await fetch("https://synthetic-audit.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
      dispatcher,
    }).catch(() => {});
  } finally {
    tls.connect = original;
    syncBuiltinESMExports();
    await dispatcher.close();
  }
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], ["http/1.1"], JSON.stringify(captured));
});
