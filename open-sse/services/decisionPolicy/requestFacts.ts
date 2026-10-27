import { z } from "zod";
import type { PolicyRequest } from "./contract.ts";
import { assessTaskDifficulty, taskInstructionText } from "./taskDifficulty.ts";
import { decisionTaskContextSchema } from "./taskContext.ts";

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
    tool_choice: z.enum(["auto", "none"]).optional(),
    parallel_tool_calls: z.boolean().optional(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
    reasoning_effort: effort.optional(),
    max_completion_tokens: z.number().int().positive().max(1000000),
  })
  .strict();
// These are explicit ordinary chat aliases, not permission to accept arbitrary
// reasoning/sampling controls or infer an absent output reservation.
const reasoningAlias = z
  .object({ effort, enabled: z.literal(true).optional() })
  .strict()
  .refine((value) => value.enabled === undefined || value.effort !== "none", {
    message: "Enabled reasoning requires an explicit thinking effort",
  });
const textAliases = requestBody
  .partial({ max_completion_tokens: true })
  .extend({
    max_tokens: z.number().int().positive().max(1000000).optional(),
    reasoning: reasoningAlias.optional(),
  })
  .superRefine((body, context) => {
    if (body.stream_options !== undefined && body.stream !== true)
      context.addIssue({ code: "custom", message: "Stream options require streaming" });
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
export type ProviderNativeOutput = { contextOutputTokens: number };
function orphanToolControls(body: {
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
}): boolean {
  return (
    !body.tools?.length &&
    (body.tool_choice !== undefined || body.parallel_tool_calls !== undefined)
  );
}
function normalizeText(
  raw: unknown,
  allowEnabledAlias: boolean,
  nativeOutput?: ProviderNativeOutput
): ChatPolicyBody | null {
  if (!boundedJson(raw)) return null;
  const parsed = textAliases.safeParse(raw);
  if (!parsed.success) return null;
  if (nativeOutput) {
    if (
      !Number.isSafeInteger(nativeOutput.contextOutputTokens) ||
      nativeOutput.contextOutputTokens < 1 ||
      nativeOutput.contextOutputTokens > 1000000 ||
      parsed.data.max_tokens !== undefined ||
      parsed.data.max_completion_tokens !== undefined ||
      parsed.data.stream !== true ||
      orphanToolControls(parsed.data)
    )
      return null;
  } else if (
    parsed.data.max_tokens === undefined &&
    parsed.data.max_completion_tokens === undefined
  )
    return null;
  if (!allowEnabledAlias && parsed.data.reasoning?.enabled !== undefined) return null;
  const { max_tokens, reasoning, ...body } = parsed.data;
  const selectedEffort = body.reasoning_effort ?? reasoning?.effort;
  const normalized = requestBody.safeParse({
    ...body,
    max_completion_tokens:
      nativeOutput?.contextOutputTokens ?? body.max_completion_tokens ?? max_tokens,
    ...(selectedEffort === undefined ? {} : { reasoning_effort: selectedEffort }),
  });
  // Unknown content parts were bounded as plain JSON; detach them before any
  // downstream working-copy transformation can mutate caller-owned objects.
  return normalized.success ? structuredClone(normalized.data) : null;
}
/** Accept only consistent explicit ingress aliases; never invent an omitted effort. */
export function normalizeDecisionTextRequest(
  raw: unknown,
  nativeOutput?: ProviderNativeOutput
): ChatPolicyBody | null {
  return normalizeText(raw, true, nativeOutput);
}
/** Serialized provider requests retain the earlier effort-only wire contract. */
export function normalizeDecisionTextWire(raw: unknown): ChatPolicyBody | null {
  return normalizeText(raw, false);
}
export type ChatPolicyBody = z.infer<typeof requestBody>;
export type ContextMeasure = (body: Readonly<ChatPolicyBody>) => number | null;
export type FactResult =
  | { ok: true; body: ChatPolicyBody; facts: PolicyRequest }
  | {
      ok: false;
      reason:
        | "unsupported_or_unbounded_request"
        | "context_unknown"
        | "continuation_unknown"
        | "decision_context_bound_exceeded"
        | "decision_context_policy_invalid";
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
function toolResultValid(
  row: ChatPolicyBody["messages"][number],
  offered: Set<string>,
  answered: Set<string>
): boolean {
  if (!row.tool_call_id || !offered.has(row.tool_call_id) || answered.has(row.tool_call_id))
    return false;
  answered.add(row.tool_call_id);
  return true;
}
function beginToolGroup(
  row: ChatPolicyBody["messages"][number],
  offered: Set<string>,
  answered: Set<string>
): boolean {
  if (offered.size !== answered.size) return false;
  offered.clear();
  answered.clear();
  if (row.tool_calls?.length && row.role !== "assistant") return false;
  for (const call of row.tool_calls ?? []) {
    if (offered.has(call.id)) return false;
    offered.add(call.id);
  }
  return true;
}
function continuationValid(body: ChatPolicyBody): boolean {
  const offered = new Set<string>(),
    answered = new Set<string>();
  for (const row of body.messages) {
    const valid =
      row.role === "tool"
        ? toolResultValid(row, offered, answered)
        : beginToolGroup(row, offered, answered);
    if (!valid) return false;
  }
  return offered.size === answered.size;
}
function explicitCodingIntent(text: string): boolean {
  // Intent chooses an existing operator task key, not a difficulty or model rank.
  return /\b(?:write|create|build|generate|implement|refactor|fix|optimi[sz]e|modify|update|complete|test|review)\b[\s\S]{0,160}\b(?:code|function|program|script|algorithm|class|module|service|api|parser|test|migration)\b/i.test(
    text
  );
}
function classifyTask(
  text: string,
  inputTokens: number,
  tools: boolean,
  images: boolean,
  continuation: boolean,
  reasoning: boolean
): string {
  let task =
    /\b(explain|describe|summarize|what|why|translate|rewrite|reformat|research|compare|extract)\b/i.test(
      text
    )
      ? "explanation"
      : "unresolved";
  if (reasoning)
    task = /\b(debug|algorithm|function|code|program|invariant)\b/i.test(text)
      ? "complex_code"
      : "reasoning";
  if (explicitCodingIntent(text)) task = "complex_code";
  if (inputTokens > 32000) task = "long_context";
  if (tools) task = "tools";
  if (images) task = "image";
  if (continuation) task = "continuation";
  return task;
}

/** Local-only by default. Raw latest-user task text requires both explicit consent gates. */
export function extractRequestFacts(
  raw: unknown,
  options: {
    measureContext: ContextMeasure;
    continuationCandidateId?: string | null;
    nativeOutput?: ProviderNativeOutput;
    decisionContext?: unknown;
    clientTaskContextConsent?: boolean;
  }
): FactResult {
  const body = normalizeDecisionTextRequest(raw, options.nativeOutput);
  if (!body || !continuationValid(body))
    return { ok: false, reason: "unsupported_or_unbounded_request" };
  const contents = contentFacts(body);
  if (!contents) return { ok: false, reason: "unsupported_or_unbounded_request" };
  const continuation = body.messages.at(-1)?.role === "tool";
  if (continuation && !options.continuationCandidateId)
    return { ok: false, reason: "continuation_unknown" };
  const disclosure = decisionTaskContextSchema.safeParse(
    options.decisionContext ?? { mode: "local-summary" }
  );
  if (!disclosure.success) return { ok: false, reason: "decision_context_policy_invalid" };
  const disclose =
    disclosure.data.mode === "task-text" &&
    options.clientTaskContextConsent === true &&
    !continuation;
  if (
    disclose &&
    disclosure.data.mode === "task-text" &&
    contents.text.length > disclosure.data.maxChars
  )
    return { ok: false, reason: "decision_context_bound_exceeded" };
  const inputTokens = options.measureContext(structuredClone(body));
  if (!Number.isSafeInteger(inputTokens) || inputTokens === null || inputTokens < 0)
    return { ok: false, reason: "context_unknown" };
  const tools = !!body.tools?.length || continuation;
  const assessment = assessTaskDifficulty(contents.text);
  const instructions = taskInstructionText(contents.text) ?? "";
  const reasoning =
    /\b(prove|derive|reason|debug|complex|algorithm|invariant)\b/i.test(instructions) ||
    /(?:^|[.!?\n]\s*|\b(?:please|and|then)\s+)(?:solve|calculate|compute|deduce|plan)\b/i.test(
      instructions.trim()
    );
  const task = classifyTask(
    instructions,
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
      difficulty: assessment.difficulty,
      contextTokens: inputTokens + body.max_completion_tokens,
      images: contents.images,
      tools,
      reasoning,
      clientEffort: body.reasoning_effort ?? null,
      continuationCandidateId: continuation ? options.continuationCandidateId! : null,
      routingDepth: 0,
      state: JSON.stringify({
        extractor: options.nativeOutput ? "provider-native-output-v1" : "bounded-chat-v1",
        task,
        assessment,
        reasoning,
        images: contents.images,
        tools,
        continuation,
        inputTokens,
        reservedOutputTokens: options.nativeOutput ? null : body.max_completion_tokens,
        ...(disclose ? { taskContext: { version: "latest-user-v1", text: contents.text } } : {}),
        ...(options.nativeOutput
          ? {
              contextOutputTokens: options.nativeOutput.contextOutputTokens,
              providerEnforcedOutputLimit: false,
            }
          : {}),
      }),
    },
  };
}
