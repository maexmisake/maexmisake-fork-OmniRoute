import type { AttemptIdentity } from "../db/decisionAttempts";
import type { ContinuationCall } from "../db/decisionContinuations";
import {
  canonicalToolJSON,
  parseDecisionToolArguments,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import { isNativeDecisionCodexPair } from "../../../open-sse/executors/codex/nativeDecision.ts";
import { validateCodexToolItems } from "./codexResponseProof";

type Json = Record<string, unknown>;
type Identity = Pick<
  AttemptIdentity,
  "id" | "keyId" | "comboId" | "provider" | "model" | "connectionId" | "effort"
>;
type Entry = { binding: string; value: string; expires: number; bytes: number };
const entries = new Map<string, Entry>();
const LIMITS = { sources: 128, bytes: 4 * 1024 * 1024, groupBytes: 262144, ttlMs: 30 * 60_000 };
function fail(): never {
  throw new Error("decision_codex_replay_unavailable");
}
function binding(identity: Identity): string {
  if (
    identity.provider !== "codex" ||
    !isNativeDecisionCodexPair(identity.model, identity.effort) ||
    [identity.id, identity.keyId, identity.comboId, identity.connectionId].some(
      (value) => typeof value !== "string" || !value || value.length > 256
    )
  )
    fail();
  const { id, keyId, comboId, provider, model, connectionId, effort } = identity;
  return canonicalToolJSON({ id, keyId, comboId, provider, model, connectionId, effort });
}
export function parseCodexToolReplay(value: string, identity: Identity) {
  binding(identity);
  if (typeof value !== "string" || Buffer.byteLength(value) > LIMITS.groupBytes) fail();
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    return fail();
  }
  if (!Array.isArray(data) || data.length !== 1) fail();
  const envelope = data[0] as Json;
  if (
    !envelope ||
    envelope.type !== "codex-tool-items-v1" ||
    Object.keys(envelope).sort().join() !== "items,type"
  )
    fail();
  const proof = validateCodexToolItems(envelope.items);
  if (!proof.calls.length || canonicalToolJSON(data) !== value) fail();
  return proof;
}
export function assertCodexReplayCalls(
  value: string,
  identity: Identity,
  calls: readonly ContinuationCall[]
): void {
  const proof = parseCodexToolReplay(value, identity);
  if (proof.calls.length !== calls.length) fail();
  proof.calls.forEach((native, index) => {
    const client = calls[index];
    if (
      native.id !== client.id ||
      native.name !== client.name ||
      canonicalToolJSON(parseDecisionToolArguments(native.arguments)) !==
        canonicalToolJSON(parseDecisionToolArguments(client.arguments))
    )
      fail();
  });
}
function expire(): number {
  let bytes = 0;
  for (const [id, entry] of entries) {
    if (entry.expires <= Date.now()) entries.delete(id);
    else bytes += entry.bytes;
  }
  return bytes;
}
export function storeCodexToolReplay(identity: Identity, items: readonly Json[]): string {
  const bound = binding(identity);
  const value = canonicalToolJSON([{ type: "codex-tool-items-v1", items }]);
  parseCodexToolReplay(value, identity);
  const bytes = Buffer.byteLength(value),
    occupied = expire();
  if (entries.has(identity.id) || entries.size >= LIMITS.sources || occupied + bytes > LIMITS.bytes)
    fail();
  entries.set(identity.id, { binding: bound, value, expires: Date.now() + LIMITS.ttlMs, bytes });
  return value;
}
export function restoreCodexToolReplay(identity: Identity): string {
  const bound = binding(identity);
  expire();
  const entry = entries.get(identity.id);
  if (!entry || entry.binding !== bound) fail();
  parseCodexToolReplay(entry.value, identity);
  return entry.value;
}
export function discardCodexToolReplay(identity: Identity, value: string): boolean {
  const entry = entries.get(identity.id);
  if (!entry || entry.binding !== binding(identity) || entry.value !== value) return false;
  entries.delete(identity.id);
  return true;
}
export function __clearCodexToolReplayForTests(): void {
  entries.clear();
}
