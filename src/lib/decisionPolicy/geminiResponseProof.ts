import { z } from "zod";

export const GEMINI_PROOF_LIMITS = {
  frameBytes: 65536,
  totalBytes: 1048576,
  events: 8192,
  parts: 8192,
} as const;

export type GeminiReportedUsage = {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheCreation: null;
  uncachedInput: number | null;
  cost: null;
};

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const usageSchema = z
  .object({
    promptTokenCount: counter,
    candidatesTokenCount: counter,
    thoughtsTokenCount: counter,
    cachedContentTokenCount: counter,
    totalTokenCount: counter,
    toolUsePromptTokenCount: counter,
  })
  .passthrough();
type Usage = z.infer<typeof usageSchema>;
const safetyRatings = z
  .array(z.object({ blocked: z.boolean().optional() }).passthrough())
  .max(64)
  .optional();
const textPartSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().min(1).optional(),
  })
  .strict()
  .refine((part) => part.text !== undefined || part.thoughtSignature !== undefined);
const functionCallPartSchema = z
  .object({
    functionCall: z.record(z.string(), z.unknown()),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().min(1).optional(),
  })
  .strict();
const partSchema = z.union([textPartSchema, functionCallPartSchema]);
export type GeminiFrameOptions = {
  /** Private complete-call validator. Absent keeps the original text-only contract. */
  validateFunctionCallPart?: (part: Record<string, unknown>) => unknown;
};
const candidateSchema = z
  .object({
    index: z.literal(0).optional(),
    content: z
      .object({
        role: z.literal("model").optional(),
        parts: z.array(partSchema).max(64).optional(),
      })
      .strict()
      .optional(),
    finishReason: z.string().nullable().optional(),
    safetyRatings,
  })
  .passthrough();
const responseSchema = z
  .object({
    error: z.never().optional(),
    candidates: z.array(candidateSchema).max(1).optional(),
    usageMetadata: usageSchema.nullable().optional(),
    modelVersion: z.string().min(1).max(200).optional(),
    promptFeedback: z
      .object({ blockReason: z.string().optional(), safetyRatings })
      .passthrough()
      .optional(),
    automaticFunctionCallingHistory: z.array(z.never()).optional(),
  })
  .passthrough();
const payloadSchema = z
  .object({
    response: responseSchema.optional(),
    traceId: z.string().max(1024).optional(),
    consumedCredits: z.array(z.unknown()).max(64).optional(),
    remainingCredits: z.array(z.unknown()).max(64).optional(),
  })
  .strict();
type ResponsePayload = z.infer<typeof responseSchema>;
const encoder = new TextEncoder();
const blockedFinishes = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);
const blockedPrompts = new Set([
  "SAFETY",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "IMAGE_SAFETY",
]);
const usageKeys = [
  "promptTokenCount",
  "candidatesTokenCount",
  "thoughtsTokenCount",
  "cachedContentTokenCount",
  "totalTokenCount",
  "toolUsePromptTokenCount",
] as const;
function invalid(): never {
  throw new Error("decision_gemini_response_invalid");
}
function limited(): never {
  throw new Error("decision_gemini_response_limit");
}
function validateFunctionCalls(
  parts: Array<z.infer<typeof partSchema>>,
  validate: GeminiFrameOptions["validateFunctionCallPart"]
): void {
  for (const part of parts) {
    if (!("functionCall" in part)) continue;
    if (!validate) invalid();
    validate(structuredClone(part));
  }
}
function assertUsage(usage: Usage): void {
  const input = usage.promptTokenCount,
    cached = usage.cachedContentTokenCount;
  if (input !== undefined && cached !== undefined && cached > input) invalid();
  if ((usage.toolUsePromptTokenCount ?? 0) !== 0) invalid();
  const components = [input, usage.candidatesTokenCount, usage.thoughtsTokenCount];
  // Cached tokens belong to prompt tokens. With missing prompt counts this is
  // only a lower bound, never evidence that reconstructs the missing count.
  const sum = [
    input ?? cached,
    usage.candidatesTokenCount,
    usage.thoughtsTokenCount,
  ].reduce<number>((total, value) => total + (value ?? 0), 0);
  if (!Number.isSafeInteger(sum)) invalid();
  if (usage.totalTokenCount === undefined) return;
  if (sum > usage.totalTokenCount) invalid();
  if (components.every((value) => value !== undefined) && sum !== usage.totalTokenCount) invalid();
}
function updatedUsage(previous: Usage, next: Usage): Usage {
  const merged: Usage = { ...previous };
  for (const key of usageKeys) {
    const value = next[key];
    if (value === undefined) continue;
    if (previous[key] !== undefined && value < previous[key]!) invalid();
    merged[key] = value;
  }
  // A total reported in an earlier cumulative snapshot is not the total of
  // newly reported components. Only compare a fresh total with this snapshot.
  assertUsage(
    next.totalTokenCount === undefined ? { ...merged, totalTokenCount: undefined } : merged
  );
  return merged;
}
function processedInput(usage: Usage) {
  const input = usage.promptTokenCount ?? null,
    cacheRead = usage.cachedContentTokenCount ?? null;
  return {
    input,
    cacheRead,
    cacheCreation: null,
    uncachedInput: input !== null && cacheRead !== null ? input - cacheRead : null,
  };
}

/**
 * Narrow parsed-payload proof, not byte framing, raw EOF or model attestation.
 * The caller alone may call result() after verifying genuine upstream EOF.
 * No text, signatures, trace IDs or credit balances are retained/projected.
 */
export class BoundedGeminiFrames {
  private bytes = 0;
  private events = 0;
  private parts = 0;
  private finished = false;
  private failed = false;
  private sealed = false;
  private hasCandidate = false;
  private blocked = false;
  private version: string | null = null;
  private usage: Usage = {};
  private validateFunctionCallPart: GeminiFrameOptions["validateFunctionCallPart"];
  constructor(
    private expectedModel: string,
    options: GeminiFrameOptions = {}
  ) {
    if (typeof expectedModel !== "string" || !expectedModel || expectedModel.length > 200)
      invalid();
    this.validateFunctionCallPart = options.validateFunctionCallPart;
  }
  get refused(): boolean {
    return this.blocked;
  }
  get modelVersion(): string | null {
    return this.version;
  }
  accept(raw: unknown): void {
    try {
      if (this.failed || this.sealed) invalid();
      this.budget(raw);
      const parsed = payloadSchema.safeParse(raw);
      if (!parsed.success || Object.keys(parsed.data).length === 0) invalid();
      if (parsed.data.response) this.response(parsed.data.response);
    } catch (error) {
      this.failed = true;
      if (error instanceof Error && error.message === "decision_gemini_response_limit") limited();
      invalid();
    }
  }
  private budget(raw: unknown): void {
    const serialized = JSON.stringify(raw);
    if (typeof serialized !== "string") invalid();
    const size = encoder.encode(serialized).byteLength;
    this.bytes += size;
    if (
      size > GEMINI_PROOF_LIMITS.frameBytes ||
      this.bytes > GEMINI_PROOF_LIMITS.totalBytes ||
      ++this.events > GEMINI_PROOF_LIMITS.events
    )
      limited();
  }
  private response(response: ResponsePayload): void {
    if (response.modelVersion !== undefined) {
      if (response.modelVersion !== this.expectedModel) invalid();
      this.version = response.modelVersion;
    }
    const candidates = response.candidates ?? [];
    const block = response.promptFeedback?.blockReason;
    const blocked = block !== undefined && block !== "BLOCK_REASON_UNSPECIFIED";
    if (this.finished && (candidates.length || blocked)) invalid();
    if (response.usageMetadata) this.usage = updatedUsage(this.usage, response.usageMetadata);
    this.blocked ||=
      response.promptFeedback?.safetyRatings?.some((rating) => rating.blocked) === true;
    if (blocked) this.finishBlockedPrompt(block!, candidates.length);
    if (candidates[0]) this.candidate(candidates[0]);
  }
  private finishBlockedPrompt(block: string, candidateCount: number): void {
    if (!blockedPrompts.has(block) || this.hasCandidate || candidateCount) invalid();
    this.blocked = true;
    this.finished = true;
  }
  private candidate(candidate: z.infer<typeof candidateSchema>): void {
    validateFunctionCalls(candidate.content?.parts ?? [], this.validateFunctionCallPart);
    this.hasCandidate = true;
    this.parts += candidate.content?.parts?.length ?? 0;
    if (this.parts > GEMINI_PROOF_LIMITS.parts) limited();
    this.blocked ||= candidate.safetyRatings?.some((rating) => rating.blocked) === true;
    const reason = candidate.finishReason;
    if (reason == null) return;
    if (reason !== "STOP" && reason !== "MAX_TOKENS" && !blockedFinishes.has(reason)) invalid();
    this.finished = true;
    this.blocked ||= blockedFinishes.has(reason);
  }
  partial(): GeminiReportedUsage {
    return { ...processedInput(this.usage), output: null, reasoning: null, cost: null };
  }
  result(): GeminiReportedUsage {
    if (this.failed) invalid();
    this.sealed = true;
    if (!this.finished) throw new Error("decision_gemini_response_incomplete");
    const candidates = this.usage.candidatesTokenCount,
      thoughts = this.usage.thoughtsTokenCount;
    return {
      ...processedInput(this.usage),
      output: candidates !== undefined && thoughts !== undefined ? candidates + thoughts : null,
      reasoning: thoughts ?? null,
      cost: null,
    };
  }
}
