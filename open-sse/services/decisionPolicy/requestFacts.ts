import { z } from "zod";
import type { PolicyRequest } from "./contract.ts";

const effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const message = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.unknown()).max(32), z.null()]),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().min(1),
            type: z.literal("function"),
            function: z.object({ name: z.string().min(1), arguments: z.string() }).strict(),
          })
          .strict()
      )
      .max(32)
      .optional(),
    tool_call_id: z.string().min(1).optional(),
    name: z.string().optional(),
  })
  .strict();
const requestBody = z
  .object({
    model: z.string().min(1).max(200),
    messages: z.array(message).min(1).max(128),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().min(1),
                description: z.string().optional(),
                parameters: z.record(z.string(), z.unknown()),
                strict: z.boolean().optional(),
              })
              .strict(),
          })
          .strict()
      )
      .max(64)
      .optional(),
    stream: z.literal(false).optional(),
    reasoning_effort: effort.optional(),
    max_completion_tokens: z.number().int().positive().max(1000000),
  })
  .strict();
// These are explicit ordinary chat aliases, not permission to accept arbitrary
// reasoning/sampling controls or infer an absent output reservation.
const textAliases = requestBody
  .partial({ max_completion_tokens: true })
  .extend({
    max_tokens: z.number().int().positive().max(1000000).optional(),
    reasoning: z.object({ effort }).strict().optional(),
  })
  .superRefine((body, context) => {
    if (body.max_tokens === undefined && body.max_completion_tokens === undefined)
      context.addIssue({ code: "custom", message: "Explicit output reservation required" });
    if (
      body.max_tokens !== undefined &&
      body.max_completion_tokens !== undefined &&
      body.max_tokens !== body.max_completion_tokens
    )
      context.addIssue({ code: "custom", message: "Conflicting output reservations" });
    if (
      body.reasoning_effort !== undefined &&
      body.reasoning !== undefined &&
      body.reasoning_effort !== body.reasoning.effort
    )
      context.addIssue({ code: "custom", message: "Conflicting effort directives" });
  });
export function normalizeDecisionTextRequest(raw: unknown): ChatPolicyBody | null {
  if (!boundedJson(raw)) return null;
  const parsed = textAliases.safeParse(raw);
  if (!parsed.success) return null;
  const { max_tokens, reasoning, ...body } = parsed.data;
  const selectedEffort = body.reasoning_effort ?? reasoning?.effort;
  const normalized = requestBody.safeParse({
    ...body,
    max_completion_tokens: body.max_completion_tokens ?? max_tokens,
    ...(selectedEffort === undefined ? {} : { reasoning_effort: selectedEffort }),
  });
  // Unknown content parts were bounded as plain JSON; detach them before any
  // downstream working-copy transformation can mutate caller-owned objects.
  return normalized.success ? structuredClone(normalized.data) : null;
}
export type ChatPolicyBody = z.infer<typeof requestBody>;
export type ContextMeasure = (body: Readonly<ChatPolicyBody>) => number | null;
export type FactResult =
  | { ok: true; body: ChatPolicyBody; facts: PolicyRequest }
  | {
      ok: false;
      reason: "unsupported_or_unbounded_request" | "context_unknown" | "continuation_unknown";
    };

type JsonScan = { children: unknown[]; chars: number };
function safeDescriptor(key: string, entry: PropertyDescriptor): boolean {
  return (
    entry.enumerable === true &&
    !entry.get &&
    !entry.set &&
    !["__proto__", "constructor", "prototype"].includes(key)
  );
}
function objectScan(value: object, seen: Set<object>): JsonScan | null {
  if (seen.has(value) || Object.getOwnPropertySymbols(value).length > 0) return null;
  if (Array.isArray(value) && value.length > 256) return null;
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return null;
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  if (entries.length > 256) return null;
  if (Array.isArray(value) && entries.length !== value.length + 1) return null;
  const result: JsonScan = { children: [], chars: 0 };
  for (const [key, entry] of entries) {
    if (Array.isArray(value) && key === "length") continue;
    if (!safeDescriptor(key, entry)) return null;
    result.chars += key.length;
    result.children.push(entry.value);
  }
  return result;
}
function valueScan(value: unknown, seen: Set<object>): JsonScan | null {
  if (typeof value === "string") return { children: [], chars: value.length };
  if (value !== null && typeof value === "object") return objectScan(value, seen);
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value !== null && !["number", "boolean"].includes(typeof value)) return null;
  return { children: [], chars: 0 };
}
/** Bound traversal BEFORE schema parsing/serialization; reject accessors and non-JSON objects. */
export function boundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }],
    seen = new Set<object>();
  let nodes = 0,
    chars = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 8192 || item.depth > 16) return false;
    const scan = valueScan(item.value, seen);
    if (!scan) return false;
    chars += scan.chars;
    if (chars > 262144) return false;
    for (const value of scan.children) pending.push({ value, depth: item.depth + 1 });
  }
  return true;
}
const textPart = z.object({ type: z.literal("text"), text: z.string() }).strict();
const imagePart = z
  .object({
    type: z.literal("image_url"),
    image_url: z
      .object({
        url: z.string().min(1),
        detail: z.enum(["auto", "low", "high"]).optional(),
      })
      .strict(),
  })
  .strict();
function partFact(raw: unknown): { image: boolean; text: string | null } | null {
  const text = textPart.safeParse(raw);
  if (text.success) return { image: false, text: text.data.text };
  return imagePart.safeParse(raw).success ? { image: true, text: null } : null;
}
function rowFacts(content: ChatPolicyBody["messages"][number]["content"]) {
  if (!Array.isArray(content)) return { images: false, text: content ?? "" };
  let images = false;
  const texts: string[] = [];
  for (const raw of content) {
    const part = partFact(raw);
    if (!part) return null;
    images ||= part.image;
    if (part.text !== null) texts.push(part.text);
  }
  return { images, text: texts.join("\n") };
}
function contentFacts(body: ChatPolicyBody) {
  let images = false,
    text = "";
  for (const row of body.messages) {
    const facts = rowFacts(row.content);
    if (!facts) return null;
    images ||= facts.images;
    if (row.role === "user") text = facts.text;
  }
  // boundedJson already bounds the entire request; never silently truncate task evidence.
  return { images, text };
}
function continuationValid(body: ChatPolicyBody): boolean {
  const offered = new Set<string>(),
    answered = new Set<string>();
  for (const row of body.messages) {
    for (const call of row.tool_calls ?? []) {
      if (row.role !== "assistant" || offered.has(call.id)) return false;
      offered.add(call.id);
    }
    if (row.role === "tool") {
      if (!row.tool_call_id || !offered.has(row.tool_call_id) || answered.has(row.tool_call_id))
        return false;
      answered.add(row.tool_call_id);
    }
  }
  return [...offered].every((id) => answered.has(id));
}
function classifyTask(
  text: string,
  inputTokens: number,
  tools: boolean,
  images: boolean,
  continuation: boolean,
  reasoning: boolean
): string {
  let task = /\b(explain|describe|summarize|what|why|translate)\b/i.test(text)
    ? "explanation"
    : "unresolved";
  if (reasoning)
    task = /\b(debug|algorithm|function|code|program|invariant)\b/i.test(text)
      ? "complex_code"
      : "reasoning";
  if (inputTokens > 32000) task = "long_context";
  if (tools) task = "tools";
  if (images) task = "image";
  if (continuation) task = "continuation";
  return task;
}

/** Only task labels/counts enter state/traces. No raw message, image URL, tool schema or secret. */
export function extractRequestFacts(
  raw: unknown,
  options: {
    measureContext: ContextMeasure;
    continuationCandidateId?: string | null;
  }
): FactResult {
  const body = normalizeDecisionTextRequest(raw);
  if (!body || !continuationValid(body))
    return { ok: false, reason: "unsupported_or_unbounded_request" };
  const contents = contentFacts(body);
  if (!contents) return { ok: false, reason: "unsupported_or_unbounded_request" };
  const continuation = body.messages.some((row) => row.role === "tool");
  if (continuation && !options.continuationCandidateId)
    return { ok: false, reason: "continuation_unknown" };
  const inputTokens = options.measureContext(structuredClone(body));
  if (!Number.isSafeInteger(inputTokens) || inputTokens === null || inputTokens < 0)
    return { ok: false, reason: "context_unknown" };
  const tools = !!body.tools?.length || continuation;
  const reasoning = /\b(prove|derive|reason|debug|complex|algorithm|invariant)\b/i.test(
    contents.text
  );
  const task = classifyTask(
    contents.text,
    inputTokens,
    tools,
    contents.images,
    continuation,
    reasoning
  );
  return {
    ok: true,
    body,
    facts: {
      task,
      contextTokens: inputTokens + body.max_completion_tokens,
      images: contents.images,
      tools,
      reasoning,
      clientEffort: body.reasoning_effort ?? null,
      continuationCandidateId: continuation ? options.continuationCandidateId! : null,
      routingDepth: 0,
      state: JSON.stringify({
        extractor: "bounded-chat-v1",
        task,
        reasoning,
        images: contents.images,
        tools,
        continuation,
        inputTokens,
        reservedOutputTokens: body.max_completion_tokens,
      }),
    },
  };
}
