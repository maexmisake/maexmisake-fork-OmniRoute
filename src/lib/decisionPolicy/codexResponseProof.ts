import { z } from "zod";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableCounter = counter.nullable().optional();
const identifier = z.string().min(1).max(256);
const index = counter.max(8191);
const textPart = z.object({ type: z.literal("output_text"), text: z.string() }).passthrough();
const refusalPart = z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough();
const summaryPart = z.object({ type: z.literal("summary_text"), text: z.string() }).passthrough();
const messageItem = z
  .object({
    type: z.literal("message"),
    id: identifier.optional(),
    role: z.literal("assistant"),
    content: z.array(z.union([textPart, refusalPart])).max(64),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  })
  .passthrough();
const reasoningItem = z
  .object({
    type: z.literal("reasoning"),
    id: identifier.optional(),
    summary: z.array(summaryPart).max(64),
  })
  .passthrough();
const item = z.discriminatedUnion("type", [messageItem, reasoningItem]);
const usageSchema = z
  .object({
    input_tokens: nullableCounter,
    output_tokens: nullableCounter,
    total_tokens: nullableCounter,
    input_tokens_details: z
      .object({ cached_tokens: nullableCounter, cache_write_tokens: nullableCounter })
      .passthrough()
      .nullable()
      .optional(),
    output_tokens_details: z
      .object({ reasoning_tokens: nullableCounter })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
type Usage = z.infer<typeof usageSchema>;
const responseSchema = z
  .object({
    id: identifier,
    object: z.literal("response").optional(),
    model: z.string().min(1).max(200).optional(),
    status: z.enum(["in_progress", "completed", "failed", "incomplete", "cancelled"]).optional(),
    output: z.array(item).max(64).nullable().optional(),
    usage: usageSchema.nullable().optional(),
    end_turn: z.boolean().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    error: z.unknown().optional(),
    incomplete_details: z.unknown().optional(),
  })
  .passthrough();
const eventEnvelope = z
  .object({ type: z.string().min(1).max(100), sequence_number: counter.optional() })
  .passthrough();
const itemEvent = z.object({ output_index: index.optional(), item }).passthrough();
const textEvent = z
  .object({
    item_id: identifier.optional(),
    output_index: index.optional(),
    content_index: index.optional(),
  })
  .passthrough();
const summaryEvent = z
  .object({ item_id: identifier.optional(), output_index: index.optional(), summary_index: index })
  .passthrough();
const metadataEvent = z
  .object({
    response_id: identifier.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
type TrackedItem = { id?: string; index?: number; type: string; done: boolean };
function invalid(): never {
  throw new Error("decision_codex_response_invalid");
}
function validateUsage(usage: Usage): Usage {
  const input = usage.input_tokens,
    output = usage.output_tokens,
    cached = usage.input_tokens_details?.cached_tokens,
    reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (input != null && cached != null && cached > input) invalid();
  if (output != null && reasoning != null && reasoning > output) invalid();
  if (input != null && output != null) {
    const total = input + output;
    if (!Number.isSafeInteger(total)) invalid();
    if (usage.total_tokens != null && usage.total_tokens !== total) invalid();
  }
  return usage;
}
function parsed<T>(schema: z.ZodType<T>, raw: unknown): T {
  const value = schema.safeParse(raw);
  return value.success ? value.data : invalid();
}
function inputUsage(usage: Usage) {
  const input = usage.input_tokens ?? null,
    cacheRead = usage.input_tokens_details?.cached_tokens ?? null;
  return {
    input,
    cacheRead,
    cacheCreation: usage.input_tokens_details?.cache_write_tokens ?? null,
    uncachedInput: input !== null && cacheRead !== null ? input - cacheRead : null,
  };
}

function containsRefusal(output: Array<z.infer<typeof item>>): boolean {
  return output.some(
    (value) => value.type === "message" && value.content.some((part) => part.type === "refusal")
  );
}

/** Parsed native Responses evidence only. The owner must prove protocol terminal.
 * Synthetic fixtures exercise this contract; they are not captured provider responses.
 * No text, account identifiers or response IDs are projected. IDs are retained
 * only for this bounded proof's consistency checks.
 */
export class CodexResponseFrames {
  private responseId: string | null = null;
  private created = false;
  private terminal: string | null = null;
  private failed = false;
  private sealed = false;
  private sequence = -1;
  private events = 0;
  private bytes = 0;
  private items = new Map<string, TrackedItem>();
  private usage: Usage = {};
  private terminalUsage: Usage = {};
  private nonFinalTurn = false;
  refused = false;
  constructor(private expectedModel: string) {
    if (!z.string().min(1).max(200).safeParse(expectedModel).success) invalid();
  }
  get applicationStatus(): number | undefined {
    if (this.terminal === "cancelled") return 499;
    if (this.nonFinalTurn || this.terminal === "failed" || this.terminal === "incomplete")
      return 409;
    return this.refused ? 422 : undefined;
  }
  accept(raw: unknown): void {
    try {
      if (this.failed || this.sealed || this.terminal) invalid();
      this.budget(raw);
      const event = parsed(eventEnvelope, raw);
      // A top-level error contradicts an otherwise accepted event. Never pass
      // its opaque human text to a raw consumer. Legitimate failed-response
      // receipts keep their error nested inside response and remain valid.
      if (event.error != null) invalid();
      this.assertHeaders(event.headers);
      // Existing Codex transport recognizes this exact vendor metadata event.
      // Its values never become quota, retry, routing or accounting authority.
      if (event.type === "codex.rate_limits") return;
      if (event.sequence_number !== undefined) {
        if (event.sequence_number <= this.sequence) invalid();
        this.sequence = event.sequence_number;
      }
      this.event(event);
    } catch {
      this.failed = true;
      invalid();
    }
  }
  private budget(raw: unknown): void {
    const text = JSON.stringify(raw);
    if (typeof text !== "string") invalid();
    const bytes = Buffer.byteLength(text, "utf8");
    this.bytes += bytes;
    if (bytes > 65536 || this.bytes > 1048576 || ++this.events > 8192) invalid();
  }
  private event(event: z.infer<typeof eventEnvelope>): void {
    if (event.type === "response.metadata") return this.metadata(event);
    if (["response.created", "response.in_progress"].includes(event.type))
      return this.lifecycle(event);
    if (
      [
        "response.completed",
        "response.failed",
        "response.incomplete",
        "response.cancelled",
      ].includes(event.type)
    )
      return this.finish(event);
    if (["response.output_item.added", "response.output_item.done"].includes(event.type))
      return this.outputItem(event);
    if (event.type.startsWith("response.reasoning_summary_")) return this.summary(event);
    this.text(event);
  }
  private response(event: z.infer<typeof eventEnvelope>) {
    const response = parsed(responseSchema, event.response);
    if (response.model !== undefined && response.model !== this.expectedModel) invalid();
    this.assertHeaders(response.headers);
    if (this.responseId !== null && response.id !== this.responseId) invalid();
    return response;
  }
  private lifecycle(event: z.infer<typeof eventEnvelope>): void {
    const response = this.response(event);
    if (
      (response.status !== undefined && response.status !== "in_progress") ||
      response.error != null
    )
      invalid();
    if (event.type === "response.created") {
      if (this.created) invalid();
      this.created = true;
      this.responseId = response.id;
    } else this.responseId ??= response.id;
    if (response.usage) this.usage = validateUsage(response.usage);
    this.refused ||= containsRefusal(response.output ?? []);
  }
  private finish(event: z.infer<typeof eventEnvelope>): void {
    const response = this.response(event);
    const status = event.type.slice("response.".length);
    if (response.status !== undefined && status !== response.status) invalid();
    if (status === "completed") this.assertCompleted(response);
    // Provisional lifecycle output counters are not a final receipt. A missing
    // terminal counter must stay unknown instead of inheriting an initial zero.
    this.terminalUsage = response.usage ? validateUsage(response.usage) : {};
    if (response.usage) this.usage = this.terminalUsage;
    this.refused ||= containsRefusal(response.output ?? []);
    this.responseId ??= response.id;
    this.nonFinalTurn = response.end_turn === false;
    this.terminal = status;
  }
  private assertCompleted(response: z.infer<typeof responseSchema>): void {
    if (response.error != null || response.incomplete_details != null) invalid();
    if ([...this.items.values()].some((value) => !value.done)) invalid();
    const output = response.output ?? [];
    const ids = output.flatMap((value) => (value.id === undefined ? [] : [value.id]));
    if (new Set(ids).size !== ids.length) invalid();
    for (const value of output) {
      if (value.type === "message" && value.status != null && value.status !== "completed")
        invalid();
    }
    if (!output.length) return;
    for (const value of this.items.values()) {
      const final =
        value.index === undefined ? output.find((row) => row.id === value.id) : output[value.index];
      if (!final || (value.id !== undefined && final.id !== value.id) || final.type !== value.type)
        invalid();
    }
  }
  private outputItem(event: z.infer<typeof eventEnvelope>): void {
    const value = parsed(itemEvent, event);
    this.refused ||= containsRefusal([value.item]);
    const key =
      value.output_index === undefined
        ? value.item.id === undefined
          ? null
          : `id:${value.item.id}`
        : `index:${value.output_index}`;
    if (key === null) return;
    const previous = this.items.get(key);
    if (event.type === "response.output_item.added") {
      if (
        previous ||
        (value.item.id !== undefined &&
          [...this.items.values()].some((row) => row.id === value.item.id))
      )
        invalid();
      this.items.set(key, {
        id: value.item.id,
        index: value.output_index,
        type: value.item.type,
        done: false,
      });
    } else {
      if (
        previous &&
        (previous.done || previous.id !== value.item.id || previous.type !== value.item.type)
      )
        invalid();
      this.items.set(key, {
        id: value.item.id,
        index: value.output_index,
        type: value.item.type,
        done: true,
      });
    }
  }
  private active(event: z.infer<typeof textEvent>, type: string): void {
    const value =
      event.output_index === undefined
        ? [...this.items.values()].find((row) => row.id !== undefined && row.id === event.item_id)
        : this.items.get(`index:${event.output_index}`);
    if (
      value &&
      (value.done ||
        (event.item_id !== undefined && value.id !== undefined && value.id !== event.item_id) ||
        value.type !== type)
    )
      invalid();
  }
  private text(event: z.infer<typeof eventEnvelope>): void {
    const value = parsed(textEvent, event);
    this.active(value, "message");
    const actions: Record<string, () => unknown> = {
      "response.output_text.delta": () => parsed(z.string(), event.delta),
      "response.output_text.done": () => parsed(z.string(), event.text),
      "response.refusal.delta": () => this.refusal(event.delta),
      "response.refusal.done": () => this.refusal(event.refusal),
      "response.content_part.added": () => this.part(event.part),
      "response.content_part.done": () => this.part(event.part),
    };
    const action = actions[event.type];
    if (!Object.hasOwn(actions, event.type)) invalid();
    action();
  }
  private refusal(value: unknown): void {
    parsed(z.string(), value);
    this.refused = true;
  }
  private part(value: unknown): void {
    const part = parsed(z.union([textPart, refusalPart]), value);
    this.refused ||= part.type === "refusal";
  }
  private summary(event: z.infer<typeof eventEnvelope>): void {
    const value = parsed(summaryEvent, event);
    this.active({ ...value, content_index: 0 }, "reasoning");
    const actions: Record<string, () => unknown> = {
      "response.reasoning_summary_text.delta": () => parsed(z.string(), event.delta),
      "response.reasoning_summary_text.done": () => parsed(z.string(), event.text),
      "response.reasoning_summary_part.added": () => parsed(summaryPart, event.part),
      "response.reasoning_summary_part.done": () => parsed(summaryPart, event.part),
    };
    const action = actions[event.type];
    if (!Object.hasOwn(actions, event.type)) invalid();
    action();
  }
  partial() {
    return { ...inputUsage(this.usage), output: null, reasoning: null, cost: null };
  }
  private assertHeaders(raw: unknown): void {
    if (raw === undefined) return;
    const headers = parsed(z.record(z.string(), z.unknown()), raw);
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === "openai-model" && value !== this.expectedModel) invalid();
    }
  }
  private metadata(event: z.infer<typeof eventEnvelope>): void {
    const value = parsed(metadataEvent, event);
    if (value.response_id === undefined) return;
    if (this.responseId !== null && value.response_id !== this.responseId) invalid();
    this.responseId = value.response_id;
  }
  get protocolTerminal(): boolean {
    return this.terminal !== null && !this.failed;
  }
  assertReportedModel(model: string | null): void {
    if (model !== null && model !== this.expectedModel) {
      this.failed = true;
      invalid();
    }
  }
  result() {
    if (this.failed) invalid();
    this.sealed = true;
    if (!this.terminal) throw new Error("decision_codex_response_incomplete");
    return {
      ...inputUsage(this.terminalUsage),
      output: this.terminalUsage.output_tokens ?? null,
      reasoning: this.terminalUsage.output_tokens_details?.reasoning_tokens ?? null,
      // The inspected subscription contract documents no USD receipt. Never
      // interpret undocumented cost fields, credits or balances as a charge.
      cost: null,
    };
  }
}
