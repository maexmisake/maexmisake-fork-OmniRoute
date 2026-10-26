/** Local SQLite/IPC fixture only; no network or provider executor. */
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import {
  reserveDecisionAttempt,
  startDecisionAttempt,
  type AttemptIdentity,
} from "../../../src/lib/db/decisionAttempts.ts";
let identity: AttemptIdentity | undefined;
getDbInstance();
process.on("message", (message: { action: string; identity?: AttemptIdentity }) => {
  try {
    if (message.action === "reserve") {
      identity = message.identity!;
      reserveDecisionAttempt(identity);
      process.send?.({ action: "reserved", identity });
    } else if (message.action === "start") {
      startDecisionAttempt(identity!);
      process.send?.({ action: "started" });
    } else if (message.action === "close") {
      resetDbInstance();
      process.exit(0);
    }
  } catch (error) {
    process.send?.({
      action: "rejected",
      reason: error instanceof Error ? error.message : "fixture_failure",
    });
  }
});
process.send?.({ action: "ready" });
