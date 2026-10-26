import type { AttemptIdentity } from "../db/decisionAttempts";
import {
  canonicalToolJSON,
  parseDecisionToolArguments,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import type { ContinuationCall } from "../db/decisionContinuations";
import { validateGeminiToolParts } from "./geminiToolResponseProof";
import { createGeminiCorrelationNamespace } from "./geminiToolIdentity";

type Json = Record<string, unknown>;
type ReplayIdentity = Pick<
  AttemptIdentity,
  "id" | "keyId" | "comboId" | "provider" | "model" | "connectionId" | "effort"
>;
type Entry = { binding: string; value: string; expires: number; bytes: number };
export type GeminiReplayGroup = {
  parts: Json[];
  correlationNamespace?: string;
  fixedNativeOpus?: boolean;
};
const OPUS_REPLAY_TYPE = "agy-opus-tool-parts-v1";
// Keep pure replay validation independent of executor/configuration initialization.
const OPUS_REPLAY_MODEL = "claude-opus-4-6-thinking";
const entries = new Map<string, Entry>();
const LIMITS = { sources: 128, bytes: 4 * 1024 * 1024, groupBytes: 262144, ttlMs: 30 * 60_000 };
function fail(): never {
  throw new Error("decision_gemini_replay_unavailable");
}
export function assertGeminiReplayIdentity(identity: ReplayIdentity): void {
  if (
    identity.provider !== "agy" ||
    !["gemini-3.8-flash-high", OPUS_REPLAY_MODEL].includes(identity.model) ||
    identity.effort !== "high" ||
    [identity.id, identity.keyId, identity.comboId, identity.connectionId].some(
      (value) => typeof value !== "string" || !value || value.length > 256
    )
  )
    fail();
}
function checkedEnvelope(parsed: unknown): Json {
  if (!Array.isArray(parsed) || parsed.length !== 1) fail();
  const envelope = parsed[0] as Json;
  if (
    !envelope ||
    typeof envelope.type !== "string" ||
    !["gemini-tool-parts-v1", "gemini-tool-parts-v2", OPUS_REPLAY_TYPE].includes(envelope.type)
  )
    fail();
  const keys = ["type", "parts"];
  if (envelope.type !== "gemini-tool-parts-v1") keys.push("correlationNamespace");
  if (Object.keys(envelope).some((key) => !keys.includes(key))) fail();
  return envelope;
}
function checkedNamespace(envelope: Json, identity?: ReplayIdentity): string | undefined {
  if (envelope.type === "gemini-tool-parts-v1") return undefined;
  const namespace = envelope.correlationNamespace;
  if (typeof namespace !== "string" || !/^[a-f0-9]{32}$/.test(namespace)) fail();
  if (identity) {
    assertGeminiReplayIdentity(identity);
    if (namespace !== createGeminiCorrelationNamespace(identity.id)) fail();
  }
  return namespace;
}
/** Shape-only without an identity. DB issue/claim and memory restore ALWAYS supply the original owner. */
export function parseGeminiToolReplayGroup(
  value: string,
  identity?: ReplayIdentity
): GeminiReplayGroup {
  try {
    if (typeof value !== "string" || Buffer.byteLength(value) > LIMITS.groupBytes) fail();
    const parsed: unknown = JSON.parse(value);
    const envelope = checkedEnvelope(parsed);
    const fixedNativeOpus = envelope.type === OPUS_REPLAY_TYPE;
    if (identity) {
      assertGeminiReplayIdentity(identity);
      if (fixedNativeOpus !== (identity.model === OPUS_REPLAY_MODEL)) fail();
    }
    const namespace = checkedNamespace(envelope, identity);
    const proof = validateGeminiToolParts(envelope.parts, undefined, {
      correlationNamespace: namespace,
      fixedNativeOpus,
    });
    if (!proof.calls.length || canonicalToolJSON(parsed) !== value) fail();
    return {
      parts: proof.parts,
      ...(namespace === undefined ? {} : { correlationNamespace: namespace }),
      ...(fixedNativeOpus ? { fixedNativeOpus: true } : {}),
    };
  } catch {
    return fail();
  }
}
/** Compatibility projection; parsing alone never grants continuation authority. */
export function parseGeminiToolReplay(value: string, identity?: ReplayIdentity): Json[] {
  return parseGeminiToolReplayGroup(value, identity).parts;
}
/** Bind the issued client descriptors to the same original native group and namespace. */
export function assertGeminiReplayCalls(
  value: string,
  identity: ReplayIdentity,
  calls: readonly ContinuationCall[]
): void {
  const group = parseGeminiToolReplayGroup(value, identity);
  const proof = validateGeminiToolParts(group.parts, undefined, {
    correlationNamespace: group.correlationNamespace,
    fixedNativeOpus: group.fixedNativeOpus,
  });
  if (!Array.isArray(calls) || proof.calls.length !== calls.length) fail();
  proof.calls.forEach((native, index) => {
    const client = calls[index];
    if (
      native.id !== client.id ||
      native.wireName !== client.name ||
      canonicalToolJSON(native.input) !==
        canonicalToolJSON(parseDecisionToolArguments(client.arguments))
    )
      fail();
  });
}
export function serializeGeminiToolReplay(
  parts: readonly Json[],
  correlationNamespace?: string,
  fixedNativeOpus = false
): string {
  if (fixedNativeOpus && correlationNamespace === undefined) fail();
  const envelope = fixedNativeOpus
    ? { type: OPUS_REPLAY_TYPE, correlationNamespace, parts }
    : correlationNamespace === undefined
      ? { type: "gemini-tool-parts-v1", parts }
      : { type: "gemini-tool-parts-v2", correlationNamespace, parts };
  const value = canonicalToolJSON([envelope]);
  parseGeminiToolReplayGroup(value);
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
/** Private worker memory only. Restart/cache loss rejects instead of inventing native replay Parts. */
export function storeGeminiToolReplay(
  identity: ReplayIdentity,
  parts: readonly Json[],
  correlationNamespace?: string
): string {
  const bound = binding(identity),
    value = serializeGeminiToolReplay(
      parts,
      correlationNamespace,
      identity.model === OPUS_REPLAY_MODEL
    );
  parseGeminiToolReplayGroup(value, identity);
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
  parseGeminiToolReplayGroup(entry.value, identity);
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
