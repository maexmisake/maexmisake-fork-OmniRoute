import { boundedJson } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import { BoundedGeminiFrames } from "./geminiResponseProof.ts";
import { inspectGeminiFunctionCallPart } from "./geminiToolResponseProof.ts";
import {
  resolveGeminiClientCallId,
  validateGeminiCorrelationNamespace,
} from "./geminiToolIdentity.ts";

type Json = Record<string, unknown>;
type ToolDelta = {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type Delta = {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: ToolDelta[];
};
export type GeminiToolClientChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [{ index: 0; delta: Delta; finish_reason: string | null }];
};
const blockedReasons = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);
function invalid(): never {
  throw new Error("decision_gemini_tool_client_invalid");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) invalid();
}
function capturedCallResolver(namespace: string | undefined) {
  try {
    if (namespace !== undefined) validateGeminiCorrelationNamespace(namespace);
  } catch {
    return invalid();
  }
  return (nativeId: string | null, ordinal: number) =>
    resolveGeminiClientCallId(nativeId, namespace, ordinal);
}
function responseOf(raw: unknown): Json {
  if (!boundedJson(raw) || !raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  return ((raw as Json).response ?? {}) as Json;
}
function blockedPrompt(response: Json): boolean {
  const reason = (response.promptFeedback as Json | undefined)?.blockReason;
  return typeof reason === "string" && reason !== "BLOCK_REASON_UNSPECIFIED";
}
function partsOf(candidate: Json): Json[] {
  const content = candidate.content as Json | undefined;
  return (content?.parts ?? []) as Json[];
}

/**
 * Private structural projection of parsed CloudCode frames, not tool authority.
 * The caller separately proves declared names, signed Parts, raw EOF, current
 * policy/account and client completion before publishing continuation authority.
 * This class neither emits SSE framing/DONE nor observes transport cancellation.
 */
export class GeminiToolClient {
  private readonly proof: BoundedGeminiFrames;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly callIds = new Set<string>();
  private readonly resolveCallId: (nativeId: string | null, ordinal: number) => string;
  private roleEmitted = false;
  private terminalEmitted = false;
  private readonly allowedNames: ReadonlySet<string>;
  private failed = false;
  private sealed = false;
  constructor(
    private readonly model: string,
    private readonly responseId: string,
    allowedNames: ReadonlySet<string>,
    correlationNamespace?: string
  ) {
    identifier(model);
    identifier(responseId);
    this.resolveCallId = capturedCallResolver(correlationNamespace);
    if (!(allowedNames instanceof Set) || allowedNames.size > 64) invalid();
    const names = [...allowedNames];
    if (
      names.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,57}$/.test(name))
    )
      invalid();
    this.allowedNames = new Set(names);
    this.proof = new BoundedGeminiFrames(model, {
      validateFunctionCallPart: (part) => inspectGeminiFunctionCallPart(part, this.allowedNames),
    });
  }
  accept(raw: unknown): GeminiToolClientChunk[] {
    try {
      if (this.failed || this.sealed) invalid();
      const response = responseOf(raw);
      this.proof.accept(raw);
      const candidate = (response.candidates as Json[] | undefined)?.[0];
      const rows: GeminiToolClientChunk[] = [];
      if (candidate) this.candidate(candidate, rows);
      else if (blockedPrompt(response) && this.proof.refused && !this.terminalEmitted)
        rows.push(this.chunk({}, "content_filter"));
      return rows;
    } catch {
      this.failed = true;
      return invalid();
    }
  }
  private candidate(candidate: Json, rows: GeminiToolClientChunk[]): void {
    for (const part of partsOf(candidate)) {
      if (part.functionCall !== undefined) rows.push(this.chunk(this.call(part)));
      else if (typeof part.text === "string" && part.text.length)
        rows.push(
          this.chunk({ [part.thought === true ? "reasoning_content" : "content"]: part.text })
        );
    }
    const reason = candidate.finishReason;
    if (reason == null) return;
    const finish = this.finishReason(reason);
    rows.push(this.chunk({}, finish));
  }
  private finishReason(reason: unknown): string {
    if (this.proof.refused || blockedReasons.has(String(reason))) {
      if (this.callIds.size) invalid();
      return "content_filter";
    }
    if (reason === "STOP") return this.callIds.size ? "tool_calls" : "stop";
    if (reason !== "MAX_TOKENS" || this.callIds.size) invalid();
    return "length";
  }
  private call(part: Json): Delta {
    const call = inspectGeminiFunctionCallPart(part, this.allowedNames);
    const index = this.callIds.size;
    const id = this.resolveCallId(call.nativeId, index);
    if (this.callIds.has(id) || this.callIds.size >= 32) invalid();
    this.callIds.add(id);
    return {
      tool_calls: [
        {
          index,
          id,
          type: "function",
          function: { name: call.wireName, arguments: JSON.stringify(call.input) },
        },
      ],
    };
  }
  private chunk(delta: Delta, finishReason: string | null = null): GeminiToolClientChunk {
    const role = this.roleEmitted ? {} : { role: "assistant" as const };
    this.roleEmitted = true;
    if (finishReason !== null) this.terminalEmitted = true;
    return {
      id: this.responseId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: { ...role, ...delta }, finish_reason: finishReason }],
    };
  }
  finish(): GeminiToolClientChunk[] {
    try {
      if (this.failed || this.sealed) invalid();
      this.sealed = true;
      this.proof.result();
      return [];
    } catch {
      this.failed = true;
      throw new Error("decision_gemini_tool_client_incomplete");
    }
  }
}
