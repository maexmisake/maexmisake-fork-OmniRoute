import { z } from "zod";
import { boundedJson } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import {
  canonicalToolId,
  canonicalToolJSON,
  parseDecisionToolArguments,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";

type Json = Record<string, unknown>;
const id = z.string().min(1).max(256);
const callId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,57}$/);
const text = z
  .object({
    type: z.literal("output_text"),
    text: z.string(),
    annotations: z.array(z.unknown()).max(64).optional(),
    logprobs: z.array(z.unknown()).max(64).optional(),
  })
  .strict();
const summary = z.object({ type: z.literal("summary_text"), text: z.string() }).strict();
const thinkingText = z
  .object({ type: z.enum(["reasoning_text", "text"]), text: z.string() })
  .strict();
const metadata = z.record(z.string(), z.unknown()).nullable().optional();
export const codexFunctionCallSchema = z
  .object({
    type: z.literal("function_call"),
    id: id.optional(),
    call_id: callId,
    name,
    arguments: z.string().max(65536),
    namespace: z.string().min(1).max(128).nullable().optional(),
    encrypted_content: z.string().min(1).max(65536).nullable().optional(),
    encrypted_function_args: z.array(z.string().min(1).max(65536)).max(32).nullable().optional(),
    internal_chat_message_metadata_passthrough: metadata,
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  })
  .strict();
const nativeItem = z.discriminatedUnion("type", [
  codexFunctionCallSchema,
  z
    .object({
      type: z.literal("message"),
      id: id.optional(),
      role: z.literal("assistant"),
      content: z.array(text).max(64),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
      phase: z.enum(["commentary", "partial_answer", "final_answer"]).optional(),
      encrypted_content: z.string().min(1).max(65536).nullable().optional(),
      internal_chat_message_metadata_passthrough: metadata,
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      id: id.optional(),
      summary: z.array(summary).max(64),
      content: z.array(thinkingText).max(64).optional(),
      encrypted_content: z.string().min(1).max(65536).nullable().optional(),
      internal_chat_message_metadata_passthrough: metadata,
    })
    .strict(),
]);
export type CodexToolTurnProof = {
  items: Json[];
  calls: Array<{ id: string; name: string; arguments: string }>;
  assistantText: string;
};
export type CodexToolOptions = {
  model?: string;
  allowedNames?: readonly string[] | ReadonlySet<string>;
  allowToolUse?: boolean;
};
function invalid(): never {
  throw new Error("decision_codex_tool_response_invalid");
}
function parsedItem(value: unknown) {
  if (!boundedJson(value)) invalid();
  const parsed = nativeItem.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}
function sameArgs(left: string, right: string): boolean {
  return (
    canonicalToolJSON(parseDecisionToolArguments(left)) ===
    canonicalToolJSON(parseDecisionToolArguments(right))
  );
}
function validateCall(value: z.infer<typeof codexFunctionCallSchema>, options: CodexToolOptions) {
  if (
    value.namespace != null ||
    options.allowToolUse === false ||
    (options.allowedNames !== undefined && !new Set(options.allowedNames).has(value.name))
  )
    invalid();
  if (value.status !== undefined && value.status !== "completed") invalid();
  if (Buffer.byteLength(value.arguments) > 65536) invalid();
  parseDecisionToolArguments(value.arguments);
  return { id: canonicalToolId(value.call_id), name: value.name, arguments: value.arguments };
}
function validateReplayItem(value: z.infer<typeof nativeItem>, ids: Set<string>): void {
  if (
    typeof value.encrypted_content === "string" &&
    Buffer.byteLength(value.encrypted_content) > 65536
  )
    invalid();
  if (value.id !== undefined && ids.has(value.id)) invalid();
  if (value.id !== undefined) ids.add(value.id);
  if (value.type === "message" && value.status !== undefined && value.status !== "completed")
    invalid();
  if (
    value.type === "reasoning" &&
    (typeof value.encrypted_content !== "string" || !value.encrypted_content)
  )
    invalid();
}
/** Shape/call check only. Origin/account/mode authority belongs to the signed journal and private store. */
export function validateCodexToolItems(
  raw: unknown,
  options: CodexToolOptions = {}
): CodexToolTurnProof {
  if (!boundedJson(raw) || !Array.isArray(raw) || !raw.length || raw.length > 64) invalid();
  const values = raw.map(parsedItem);
  const calls: CodexToolTurnProof["calls"] = [];
  let assistantText = "";
  const ids = new Set<string>();
  for (const value of values) {
    validateReplayItem(value, ids);
    if (value.type === "function_call") calls.push(validateCall(value, options));
    if (value.type === "message") assistantText += value.content.map((part) => part.text).join("");
  }
  if (
    !calls.length ||
    calls.length > 32 ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  )
    invalid();
  canonicalToolJSON(values);
  return { items: structuredClone(values) as Json[], calls, assistantText };
}
type PendingCall = {
  item: z.infer<typeof codexFunctionCallSchema>;
  index?: number;
  fragments: string;
  argumentsDone?: string;
};
/** Original native output items and bounded argument fragments; no synthetic IDs or reasoning. */
export class CodexToolAssembly {
  private items: Json[] = [];
  private indexes: Array<number | undefined> = [];
  private pending = new Map<string, PendingCall>();
  private started = new Map<string, number>();
  private completed = new Map<string, number>();
  private proof: CodexToolTurnProof | null = null;
  constructor(private options: CodexToolOptions) {}
  acceptItem(event: Json): void {
    const value = parsedItem(event.item);
    const added = event.type === "response.output_item.added";
    const counts = added ? this.started : this.completed;
    counts.set(value.type, (counts.get(value.type) ?? 0) + 1);
    if (value.type === "function_call") this.callItem(value, event, added);
    if (!added) {
      const index = typeof event.output_index === "number" ? event.output_index : undefined;
      if (index !== undefined && this.indexes.includes(index)) invalid();
      this.items.push(structuredClone(value) as Json);
      this.indexes.push(index);
      if (this.items.length > 64) invalid();
    }
  }
  private callItem(
    value: z.infer<typeof codexFunctionCallSchema>,
    event: Json,
    added: boolean
  ): void {
    if (
      this.options.allowToolUse === false ||
      (this.options.allowedNames !== undefined &&
        !new Set(this.options.allowedNames).has(value.name))
    )
      invalid();
    const previous = this.pending.get(value.call_id);
    if (added) {
      this.addCall(value, event);
      return;
    }
    validateCall(value, this.options);
    if (previous) {
      if (
        previous.item.id !== value.id ||
        previous.item.name !== value.name ||
        previous.index !== event.output_index
      )
        invalid();
      const expected = previous.argumentsDone ?? (previous.fragments || previous.item.arguments);
      if (expected && !sameArgs(expected, value.arguments)) invalid();
      this.pending.delete(value.call_id);
    }
  }
  private addCall(value: z.infer<typeof codexFunctionCallSchema>, event: Json): void {
    if (
      this.pending.has(value.call_id) ||
      this.items.some((item) => item.type === "function_call" && item.call_id === value.call_id) ||
      this.pending.size >= 32
    )
      invalid();
    this.pending.set(value.call_id, {
      item: value,
      index: typeof event.output_index === "number" ? event.output_index : undefined,
      fragments: "",
    });
  }
  private argumentTarget(event: Json): PendingCall {
    const coordinates = z
      .object({
        item_id: id.optional(),
        call_id: callId.optional(),
        output_index: z.number().int().nonnegative().max(8191).optional(),
      })
      .passthrough()
      .safeParse(event);
    if (!coordinates.success) invalid();
    const candidates = [...this.pending.values()].filter(
      (value) =>
        (typeof event.item_id !== "string" || value.item.id === event.item_id) &&
        (typeof event.call_id !== "string" || value.item.call_id === event.call_id) &&
        (typeof event.output_index !== "number" || value.index === event.output_index)
    );
    if (
      candidates.length !== 1 ||
      (event.item_id === undefined &&
        event.call_id === undefined &&
        event.output_index === undefined)
    )
      invalid();
    return candidates[0];
  }
  acceptArguments(event: Json): void {
    const value = this.argumentTarget(event);
    if (event.type === "response.function_call_arguments.delta") {
      if (
        typeof event.delta !== "string" ||
        value.argumentsDone !== undefined ||
        value.item.arguments
      )
        invalid();
      value.fragments += event.delta;
      if (Buffer.byteLength(value.fragments) > 65536) invalid();
      return;
    }
    if (
      event.type !== "response.function_call_arguments.done" ||
      typeof event.arguments !== "string" ||
      value.argumentsDone !== undefined
    )
      invalid();
    parseDecisionToolArguments(event.arguments);
    if (value.fragments && !sameArgs(value.fragments, event.arguments)) invalid();
    value.argumentsDone = event.arguments;
  }
  complete(output: unknown): void {
    const originals = this.orderedItems();
    const final = Array.isArray(output) && output.length ? output.map(parsedItem) : originals;
    if (!final.some((item) => item.type === "function_call")) {
      if (this.pending.size) invalid();
      this.proof = null;
      return;
    }
    if (this.pending.size) invalid();
    for (const [type, count] of this.started) {
      if ((this.completed.get(type) ?? 0) < count) invalid();
    }
    if (
      Array.isArray(output) &&
      output.length &&
      originals.length &&
      canonicalToolJSON(final) !== canonicalToolJSON(originals)
    )
      invalid();
    this.proof = validateCodexToolItems(final, this.options);
  }
  private orderedItems(): Json[] {
    const indexed = this.indexes.filter((index) => index !== undefined).length;
    if (!indexed) return this.items;
    if (indexed !== this.items.length) invalid();
    return this.items
      .map((item, index) => ({ item, index: this.indexes[index]! }))
      .sort((left, right) => left.index - right.index)
      .map(({ item }) => item);
  }
  result(): CodexToolTurnProof | null {
    return this.proof ? structuredClone(this.proof) : null;
  }
  get hasCalls(): boolean {
    return !!this.proof?.calls.length;
  }
}
