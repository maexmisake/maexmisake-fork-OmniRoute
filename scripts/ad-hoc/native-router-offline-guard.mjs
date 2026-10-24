/** Test/build preload only. Never loaded by the application unless explicitly imported. */
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const mode = process.env.OMNIROUTE_OFFLINE_AUDIT || "no-network";
if (!["no-network", "local-fixtures"].includes(mode)) {
  throw new Error("Unknown offline audit mode");
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === "object" ? first.host : args[1];
  // Filesystem IPC is not provider egress. The fixture mode allows only explicit IPv4 loopback.
  if (
    (first && typeof first === "object" && first.path) ||
    (mode === "local-fixtures" && host === "127.0.0.1")
  ) {
    return connect.apply(this, args);
  }
  throw new Error("Offline audit blocked a network socket");
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (mode !== "local-fixtures" || url.hostname !== "127.0.0.1") {
    throw new Error("Offline audit blocked a network fetch");
  }
  return originalFetch(input, init);
};
