import { z } from "zod";
import {
  assertDecisionToolArguments,
  canonicalToolId,
  canonicalToolJSON,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import { boundedJson } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import { BoundedGeminiFrames } from "./geminiResponseProof";
import {
  resolveGeminiClientCallId,
  validateGeminiCorrelationNamespace,
} from "./geminiToolIdentity";

type Json = Record<string, unknown>;
type GeminiToolCall = { id: string; wireName: string; input: Json };
export type GeminiNativeToolCall = { nativeId: string | null; wireName: string; input: Json };
export type GeminiToolTurnProof = {
  calls: Array<GeminiToolCall & { nativeId: string | null; partIndex: number; ordinal: number }>;
  parts: Json[];
};
export type GeminiToolCorrelationOptions = {
  correlationNamespace?: string;
  /** Exact private Claude CloudCode slot; absence is preserved, never synthesized. */
  fixedNativeOpus?: boolean;
};
export const GEMINI_TOOL_PROOF_LIMITS = {
  calls: 32,
  parts: 64,
  totalBytes: 1048576,
  argumentBytes: 65536,
} as const;
const toolName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,57}$/);
const signature = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim().length > 0 && value.trim() !== "skip_thought_signature_validator"
  );
const textPart = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: signature.optional(),
  })
  .strict()
  .refine((part) => part.text !== undefined || part.thoughtSignature !== undefined);
const callPart = z
  .object({
    functionCall: z
      .object({ id: z.string().optional(), name: toolName, args: z.unknown() })
      .strict(),
    thought: z.boolean().optional(),
    thoughtSignature: signature.optional(),
  })
  .strict();
const partSchema = z.union([textPart, callPart]);
const encoder = new TextEncoder();
function fail(): never {
  throw new Error("decision_gemini_tool_response_invalid");
}
function limited(): never {
  throw new Error("decision_gemini_tool_response_limit");
}
function fixedError(error: unknown): never {
  if (error instanceof Error && error.message.endsWith("_limit")) limited();
  return fail();
}
/** Native syntax only; an absent wire ID is not an invented provider identity. */
export function inspectGeminiFunctionCallPart(
  part: unknown,
  allowedNames?: ReadonlySet<string>
): GeminiNativeToolCall {
  try {
    if (!boundedJson(part)) fail();
    const parsed = callPart.safeParse(part);
    if (!parsed.success) fail();
    const call = parsed.data.functionCall;
    const nativeId = call.id === undefined ? null : canonicalToolId(call.id);
    if (allowedNames && !allowedNames.has(call.name)) fail();
    assertDecisionToolArguments(call.args);
    if (
      encoder.encode(canonicalToolJSON(call.args)).byteLength >
      GEMINI_TOOL_PROOF_LIMITS.argumentBytes
    )
      limited();
    return { nativeId, wireName: call.name, input: structuredClone(call.args) };
  } catch (error) {
    return fixedError(error);
  }
}
/** Compatible explicit-ID-only syntax validator; this grants no declaration authority. */
export function validateGeminiFunctionCallPart(
  part: unknown,
  allowedNames?: ReadonlySet<string>
): GeminiToolCall {
  const call = inspectGeminiFunctionCallPart(part, allowedNames);
  if (call.nativeId === null) fail();
  return { id: call.nativeId, wireName: call.wireName, input: call.input };
}
function appendCall(
  original: Json,
  partIndex: number,
  calls: GeminiToolTurnProof["calls"],
  ids: Set<string>,
  allowedNames: ReadonlySet<string> | undefined,
  correlationNamespace: string | undefined,
  fixedNativeOpus: boolean
): void {
  if (!("functionCall" in original)) return;
  if (calls.length >= GEMINI_TOOL_PROOF_LIMITS.calls) limited();
  const call = inspectGeminiFunctionCallPart(original, allowedNames);
  const ordinal = calls.length;
  const id = resolveGeminiClientCallId(call.nativeId, correlationNamespace, ordinal);
  if (!fixedNativeOpus && !calls.length && !signature.safeParse(original.thoughtSignature).success)
    fail();
  if (ids.has(id)) fail();
  ids.add(id);
  calls.push({ ...call, id, partIndex, ordinal });
}
/** Static Part validation: Gemini requires a signature; fixed Opus preserves genuine absence. */
export function validateGeminiToolParts(
  raw: unknown,
  allowedNames?: ReadonlySet<string>,
  options: GeminiToolCorrelationOptions = {}
): GeminiToolTurnProof {
  try {
    if (options.correlationNamespace !== undefined)
      validateGeminiCorrelationNamespace(options.correlationNamespace);
    if (!boundedJson(raw) || !Array.isArray(raw)) fail();
    if (raw.length > GEMINI_TOOL_PROOF_LIMITS.parts) limited();
    if (encoder.encode(JSON.stringify(raw)).byteLength > GEMINI_TOOL_PROOF_LIMITS.totalBytes)
      limited();
    const parts: Json[] = [],
      calls: GeminiToolTurnProof["calls"] = [];
    const ids = new Set<string>();
    for (const [partIndex, part] of raw.entries()) {
      if (!partSchema.safeParse(part).success) fail();
      const original = part as Json;
      appendCall(
        original,
        partIndex,
        calls,
        ids,
        allowedNames,
        options.correlationNamespace,
        options.fixedNativeOpus === true
      );
      parts.push(structuredClone(original));
    }
    return { calls, parts };
  } catch (error) {
    return fixedError(error);
  }
}

type CollectorOptions = {
  model: string;
  allowedNames: ReadonlySet<string> | readonly string[];
  allowToolUse: boolean;
  correlationNamespace?: string;
  fixedNativeOpus?: boolean;
};
/** Caller owns byte framing, cancellation and the genuine EOF needed before finish(). */
export class RawGeminiToolCollector {
  private proof: BoundedGeminiFrames;
  private names: ReadonlySet<string>;
  private correlationNamespace: string | undefined;
  private fixedNativeOpus: boolean;
  private parts: Json[] = [];
  private failed = false;
  private sealed = false;
  private finishReason: string | null = null;
  constructor(options: CollectorOptions) {
    if (options.fixedNativeOpus && options.model !== "claude-opus-4-6-thinking") fail();
    this.fixedNativeOpus = options.fixedNativeOpus === true;
    const names =
      options.allowedNames instanceof Set ? [...options.allowedNames] : options.allowedNames;
    const parsed = z.array(toolName).max(64).safeParse(names);
    if (
      !parsed.success ||
      new Set(parsed.data).size !== parsed.data.length ||
      typeof options.allowToolUse !== "boolean"
    )
      fail();
    this.names = new Set(parsed.data);
    if (options.correlationNamespace !== undefined)
      validateGeminiCorrelationNamespace(options.correlationNamespace);
    this.correlationNamespace = options.correlationNamespace;
    const allowToolUse = options.allowToolUse;
    this.proof = new BoundedGeminiFrames(options.model, {
      validateFunctionCallPart: (part) => {
        if (!allowToolUse) fail();
        if (this.correlationNamespace === undefined)
          validateGeminiFunctionCallPart(part, this.names);
        else inspectGeminiFunctionCallPart(part, this.names);
      },
    });
  }
  accept(raw: unknown): void {
    try {
      if (this.failed || this.sealed || !boundedJson(raw)) fail();
      this.proof.accept(raw);
      const candidate = (
        raw as {
          response?: {
            candidates?: Array<{ content?: { parts?: Json[] }; finishReason?: string }>;
          };
        }
      ).response?.candidates?.[0];
      const next = [...this.parts, ...(candidate?.content?.parts ?? [])];
      const turn = validateGeminiToolParts(next, this.names, {
        correlationNamespace: this.correlationNamespace,
        fixedNativeOpus: this.fixedNativeOpus,
      });
      if (this.proof.refused && turn.calls.length) fail();
      this.parts = structuredClone(next);
      if (candidate?.finishReason) this.finishReason = candidate.finishReason;
    } catch (error) {
      this.failed = true;
      fixedError(error);
    }
  }
  finish(): GeminiToolTurnProof | null {
    try {
      if (this.failed) fail();
      this.sealed = true;
      this.proof.result();
      const result = validateGeminiToolParts(this.parts, this.names, {
        correlationNamespace: this.correlationNamespace,
        fixedNativeOpus: this.fixedNativeOpus,
      });
      if (!result.calls.length) return null;
      if (this.finishReason !== "STOP") fail();
      return result;
    } catch (error) {
      this.failed = true;
      return fixedError(error);
    }
  }
}
