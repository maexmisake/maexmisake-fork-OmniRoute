import type { AttemptIdentity } from "../db/decisionAttempts";
import { canonicalToolJSON } from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import { validateGeminiToolParts } from "./geminiToolResponseProof";

type Json = Record<string, unknown>;
type ReplayIdentity = Pick<
  AttemptIdentity,
  "id" | "keyId" | "comboId" | "provider" | "model" | "connectionId" | "effort"
>;
type Entry = { binding: string; value: string; expires: number; bytes: number };
const entries = new Map<string, Entry>();
const LIMITS = { sources: 128, bytes: 4 * 1024 * 1024, groupBytes: 262144, ttlMs: 30 * 60_000 };
function fail(): never {
  throw new Error("decision_gemini_replay_unavailable");
}
export function assertGeminiReplayIdentity(identity: ReplayIdentity): void {
  if (
    identity.provider !== "agy" ||
    identity.model !== "gemini-3.8-flash-high" ||
    identity.effort !== "high" ||
    [identity.id, identity.keyId, identity.comboId, identity.connectionId].some(
      (value) => typeof value !== "string" || !value || value.length > 256
    )
  )
    fail();
}
/** Shape validation only; the DB owner MAC and original receipt supply authority. */
export function parseGeminiToolReplay(value: string): Json[] {
  try {
    if (typeof value !== "string" || Buffer.byteLength(value) > LIMITS.groupBytes) fail();
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 1) fail();
    const envelope = parsed[0] as Json;
    if (
      !envelope ||
      envelope.type !== "gemini-tool-parts-v1" ||
      Object.keys(envelope).some((key) => !["type", "parts"].includes(key))
    )
      fail();
    const proof = validateGeminiToolParts(envelope.parts);
    if (!proof.calls.length || canonicalToolJSON(parsed) !== value) fail();
    return proof.parts;
  } catch {
    return fail();
  }
}
export function serializeGeminiToolReplay(parts: readonly Json[]): string {
  const value = canonicalToolJSON([{ type: "gemini-tool-parts-v1", parts }]);
  parseGeminiToolReplay(value);
  return value;
}
function binding(identity: ReplayIdentity): string {
  assertGeminiReplayIdentity(identity);
  const { id, keyId, comboId, provider, model, connectionId, effort } = identity;
  return canonicalToolJSON({ id, keyId, comboId, provider, model, connectionId, effort });
}
function expire(): number {
  let bytes = 0;
  for (const [id, entry] of entries) {
    if (entry.expires <= Date.now()) entries.delete(id);
    else bytes += entry.bytes;
  }
  return bytes;
}
/** Private worker memory only. Restart/cache loss rejects rather than reconstructing signatures. */
export function storeGeminiToolReplay(identity: ReplayIdentity, parts: readonly Json[]): string {
  const bound = binding(identity),
    value = serializeGeminiToolReplay(parts);
  const bytes = Buffer.byteLength(value),
    occupied = expire();
  if (entries.has(identity.id) || entries.size >= LIMITS.sources || occupied + bytes > LIMITS.bytes)
    fail();
  entries.set(identity.id, { binding: bound, value, expires: Date.now() + LIMITS.ttlMs, bytes });
  return value;
}
export function restoreGeminiToolReplay(identity: ReplayIdentity): string {
  const bound = binding(identity);
  expire();
  const entry = entries.get(identity.id);
  if (!entry || entry.binding !== bound) fail();
  parseGeminiToolReplay(entry.value);
  return entry.value;
}
/** Remove only this newly stored value after failed metadata publication. */
export function discardGeminiToolReplay(identity: ReplayIdentity, value: string): boolean {
  const entry = entries.get(identity.id);
  if (!entry || entry.binding !== binding(identity) || entry.value !== value) return false;
  entries.delete(identity.id);
  return true;
}
/** In-process isolated fixtures only; no HTTP/config surface exposes this operation. */
export function __clearGeminiToolReplayForTests(): void {
  entries.clear();
}
