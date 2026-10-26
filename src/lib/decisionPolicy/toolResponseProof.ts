import {
  assertDecisionToolArguments,
  canonicalClientToolCall,
  canonicalToolId,
  canonicalToolJSON,
  type ClientToolCall,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";

type Json = Record<string, unknown>;
export type ToolThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };
export type RawToolResponseProof = {
  calls: { id: string; wireName: string; input: Json }[];
  thinkingBlocks: ToolThinkingBlock[];
};
export type ClientToolResponseProof = {
  assistant: { role: "assistant"; content: string | null; tool_calls: Json[] };
  calls: ClientToolCall[];
};
export const TOOL_PROOF_LIMITS = {
  frameBytes: 65536,
  totalBytes: 1048576,
  events: 8192,
  blocks: 64,
  calls: 32,
  argumentBytes: 65536,
} as const;
const encoder = new TextEncoder();
function fail(): never {
  throw new Error("decision_tool_response_invalid");
}
function limited(): never {
  throw new Error("decision_tool_response_limit");
}
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== "string") fail();
  return value;
}
function index(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= TOOL_PROOF_LIMITS.blocks)
    fail();
  return Number(value);
}
function objectJSON(value: string): Json {
  try {
    const parsed = record(JSON.parse(value));
    assertDecisionToolArguments(parsed);
    canonicalToolJSON(parsed);
    return parsed;
  } catch {
    return fail();
  }
}
function id(value: unknown): string {
  try {
    return canonicalToolId(value);
  } catch {
    return fail();
  }
}
class ProofBudget {
  private bytes = 0;
  private events = 0;
  accept(value: unknown): Json {
    try {
      const row = record(value);
      const size = encoder.encode(JSON.stringify(row)).byteLength;
      this.bytes += size;
      if (
        size > TOOL_PROOF_LIMITS.frameBytes ||
        ++this.events > TOOL_PROOF_LIMITS.events ||
        this.bytes > TOOL_PROOF_LIMITS.totalBytes
      )
        limited();
      return row;
    } catch {
      return fail();
    }
  }
}
type RawBlock = {
  type: string;
  closed: boolean;
  id?: string;
  wireName?: string;
  initialInput?: Json;
  arguments: string;
  thinking: string;
  signature: string;
  data: string;
};
function newRawBlock(raw: Json): RawBlock {
  const type = string(raw.type);
  if (!["text", "tool_use", "thinking", "redacted_thinking"].includes(type)) fail();
  const block: RawBlock = {
    type,
    closed: false,
    arguments: "",
    thinking: "",
    signature: "",
    data: "",
  };
  if (type === "tool_use") {
    block.id = id(raw.id);
    block.wireName = string(raw.name);
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(block.wireName)) fail();
    block.initialInput = objectJSON(JSON.stringify(record(raw.input)));
  }
  if (type === "thinking") {
    block.thinking = string(raw.thinking);
    block.signature = raw.signature === undefined ? "" : string(raw.signature);
  }
  if (type === "redacted_thinking") {
    block.data = string(raw.data);
    if (!block.data) fail();
  }
  if (type === "text") string(raw.text);
  return block;
}
function appendRawDelta(block: RawBlock, raw: Json): void {
  const type = raw.type;
  if (block.type === "tool_use" && type === "input_json_delta") {
    block.arguments += string(raw.partial_json);
    if (encoder.encode(block.arguments).byteLength > TOOL_PROOF_LIMITS.argumentBytes) limited();
    return;
  }
  if (block.type === "thinking" && type === "signature_delta") {
    block.signature += string(raw.signature);
    return;
  }
  if (block.type === "thinking" && type === "thinking_delta" && !block.signature) {
    block.thinking += string(raw.thinking);
    return;
  }
  if (block.type === "text" && type === "text_delta") {
    string(raw.text);
    return;
  }
  fail();
}
function completedRawCall(block: RawBlock) {
  const input = block.arguments ? objectJSON(block.arguments) : block.initialInput!;
  // The usual start input is an empty placeholder, not a prefix for partial JSON.
  if (block.arguments && Object.keys(block.initialInput!).length) fail();
  return { id: block.id!, wireName: block.wireName!, input };
}
function signedBlock(block: RawBlock): ToolThinkingBlock | null {
  if (block.type === "thinking") {
    if (!block.signature) fail();
    return { type: "thinking", thinking: block.thinking, signature: block.signature };
  }
  return block.type === "redacted_thinking"
    ? { type: "redacted_thinking", data: block.data }
    : null;
}

/** Consumes existing parsed provider events; the owner still proves raw SSE identity/EOF. */
export class RawClaudeToolCollector {
  private budget = new ProofBudget();
  private blocks = new Map<number, RawBlock>();
  private ids = new Set<string>();
  private started = false;
  private stopped = false;
  private reason: string | null = null;
  private phase = -1;
  private invalid = false;
  private readonly allowToolUse: boolean;
  constructor(options: { allowToolUse?: boolean } = {}) {
    this.allowToolUse = options.allowToolUse !== false;
  }
  accept(event: unknown): void {
    try {
      if (this.invalid || this.stopped) fail();
      this.event(this.budget.accept(event));
    } catch {
      this.invalid = true;
      fail();
    }
  }
  private event(row: Json): void {
    if (row.type === "message_start") {
      const message = record(row.message);
      if (this.started || message.role !== "assistant" || !Array.isArray(message.content)) fail();
      if (message.content.length) fail();
      this.started = true;
      return;
    }
    if (!this.started) fail();
    if (row.type === "ping") return;
    if (row.type === "message_delta") return this.messageDelta(row);
    if (row.type === "message_stop") {
      if (!this.reason || [...this.blocks.values()].some((block) => !block.closed)) fail();
      this.stopped = true;
      return;
    }
    if (this.reason) fail();
    this.block(row);
  }
  private messageDelta(row: Json): void {
    const delta = record(row.delta);
    if ([...this.blocks.values()].some((block) => !block.closed)) fail();
    if (this.reason) {
      if (
        row.usage === undefined ||
        Object.entries(delta).some(
          ([key, value]) => !["stop_reason", "stop_sequence"].includes(key) || value !== null
        )
      )
        fail();
      return;
    }
    if (delta.stop_reason == null) return;
    this.reason = string(delta.stop_reason);
    if (
      ![
        "tool_use",
        "end_turn",
        "stop_sequence",
        "max_tokens",
        "refusal",
        "model_context_window_exceeded",
      ].includes(this.reason)
    )
      fail();
  }
  private block(row: Json): void {
    const n = index(row.index);
    if (row.type === "content_block_start") return this.startBlock(n, row);
    const block = this.blocks.get(n);
    if (!block || block.closed) fail();
    if (row.type === "content_block_stop") {
      if (block.type === "tool_use") completedRawCall(block);
      signedBlock(block);
      block.closed = true;
      return;
    }
    if (row.type !== "content_block_delta") fail();
    appendRawDelta(block, record(row.delta));
  }
  private startBlock(n: number, row: Json): void {
    if (n !== this.blocks.size || [...this.blocks.values()].some((block) => !block.closed)) fail();
    const block = newRawBlock(record(row.content_block));
    // The current client/replay projection places signed blocks, then text, then tools.
    // Reject native interleaving that this projection cannot preserve faithfully.
    const phase = block.type === "tool_use" ? 2 : block.type === "text" ? 1 : 0;
    if (phase < this.phase) fail();
    this.phase = phase;
    if (block.id) {
      if (!this.allowToolUse || this.ids.has(block.id) || this.ids.size >= TOOL_PROOF_LIMITS.calls)
        fail();
      this.ids.add(block.id);
    }
    this.blocks.set(n, block);
  }
  finish(): RawToolResponseProof | null {
    if (this.invalid || !this.stopped) {
      this.invalid = true;
      fail();
    }
    const blocks = [...this.blocks.values()];
    const calls = blocks.filter((block) => block.type === "tool_use").map(completedRawCall);
    if (!calls.length) return this.reason === "tool_use" ? fail() : null;
    if (this.reason !== "tool_use") fail();
    const thinkingBlocks = blocks.map(signedBlock).filter((b) => b !== null);
    return structuredClone({ calls, thinkingBlocks });
  }
}

type PartialCall = { id: string; name: string; arguments: string };
/** Assembles the already restored client-facing call descriptors, never provider aliases. */
export class ClientOpenAIToolCollector {
  private budget = new ProofBudget();
  private calls = new Map<number, PartialCall>();
  private content: string | null = null;
  private finished = false;
  private stopped = false;
  private invalid = false;
  private refused = false;
  constructor(private expectedModel: string) {}
  accept(event: unknown): { completion: boolean } {
    try {
      if (this.invalid || this.stopped) fail();
      return this.chunk(this.budget.accept(event));
    } catch {
      this.invalid = true;
      return fail();
    }
  }
  private chunk(row: Json): { completion: boolean } {
    if (row.model !== this.expectedModel || row.object !== "chat.completion.chunk") fail();
    if (!Array.isArray(row.choices) || row.choices.length > 1) fail();
    if (!row.choices.length) {
      if (!this.finished || !row.usage || typeof row.usage !== "object") fail();
      return { completion: true };
    }
    if (this.finished) fail();
    const choice = record(row.choices[0]);
    if (row.usage != null && choice.finish_reason == null) fail();
    return this.choice(choice);
  }
  private choice(choice: Json): { completion: boolean } {
    if (choice.index !== 0) fail();
    this.delta(record(choice.delta ?? {}));
    if (choice.finish_reason == null) return { completion: false };
    const reason = string(choice.finish_reason);
    if (this.calls.size && reason !== "tool_calls") fail();
    if (!this.calls.size && !["stop", "length", "content_filter"].includes(reason)) fail();
    this.finished = true;
    return { completion: true };
  }
  private delta(delta: Json): void {
    if (delta.role !== undefined && delta.role !== "assistant") fail();
    this.noteRefusal(delta);
    if (delta.function_call != null) fail();
    if (delta.content != null) this.content = (this.content ?? "") + string(delta.content);
    if (delta.tool_calls === undefined) return;
    if (!Array.isArray(delta.tool_calls)) fail();
    const indices = new Set<number>();
    for (const value of delta.tool_calls) {
      const call = record(value);
      const n = index(call.index);
      if (indices.has(n)) fail();
      indices.add(n);
      this.call(n, call);
    }
  }
  private noteRefusal(delta: Json): void {
    if (delta.refusal == null) return;
    string(delta.refusal);
    if (this.calls.size) fail();
    this.refused = true;
  }
  private call(n: number, row: Json): void {
    if (this.refused) fail();
    let call = this.calls.get(n);
    if (!call) {
      if (n !== this.calls.size || n >= TOOL_PROOF_LIMITS.calls || row.type !== "function") fail();
      const callId = id(row.id);
      if ([...this.calls.values()].some((c) => c.id === callId)) fail();
      call = { id: callId, name: "", arguments: "" };
      this.calls.set(n, call);
    } else if (row.id !== undefined || (row.type !== undefined && row.type !== "function")) fail();
    const fn = record(row.function);
    if (fn.name !== undefined) call.name += string(fn.name);
    if (fn.arguments !== undefined) call.arguments += string(fn.arguments);
    if (encoder.encode(call.arguments).byteLength > TOOL_PROOF_LIMITS.argumentBytes) limited();
  }
  done(): void {
    if (this.invalid || this.stopped || !this.finished) {
      this.invalid = true;
      fail();
    }
    this.stopped = true;
  }
  finish(): ClientToolResponseProof | null {
    if (this.invalid || !this.stopped) {
      this.invalid = true;
      fail();
    }
    if (!this.calls.size) return null;
    try {
      const tool_calls = [...this.calls.values()].map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
      const calls = tool_calls.map(canonicalClientToolCall);
      return structuredClone({
        assistant: { role: "assistant" as const, content: this.content, tool_calls },
        calls,
      });
    } catch {
      this.invalid = true;
      return fail();
    }
  }
}

export type ClientToolSSEFrame = { bytes: Uint8Array; payload?: Json; done: boolean };
function frameEnd(bytes: Uint8Array): number {
  for (let n = 0; n < bytes.length - 1; n++) {
    if (bytes[n] !== 10) continue;
    if (bytes[n + 1] === 10) return n + 2;
    if (bytes[n + 1] === 13 && bytes[n + 2] === 10) return n + 3;
  }
  return -1;
}
function clientFrame(bytes: Uint8Array): ClientToolSSEFrame {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return { bytes, done: false };
    if (data === "[DONE]") return { bytes, done: true };
    return { bytes, payload: record(JSON.parse(data)), done: false };
  } catch {
    return fail();
  }
}
/** Byte-preserving frame boundaries; the caller holds only classified completion frames. */
export class ClientToolSSEFramer {
  private buffer = new Uint8Array();
  private total = 0;
  private events = 0;
  private invalid = false;
  private ended = false;
  push(bytes: Uint8Array): ClientToolSSEFrame[] {
    try {
      if (this.invalid || this.ended) fail();
      this.total += bytes.byteLength;
      if (this.total > TOOL_PROOF_LIMITS.totalBytes) limited();
      const merged = new Uint8Array(this.buffer.length + bytes.length);
      merged.set(this.buffer);
      merged.set(bytes, this.buffer.length);
      this.buffer = merged;
      return this.drain();
    } catch {
      this.invalid = true;
      return fail();
    }
  }
  private drain(): ClientToolSSEFrame[] {
    const frames: ClientToolSSEFrame[] = [];
    let end: number;
    while ((end = frameEnd(this.buffer)) >= 0) {
      if (end > TOOL_PROOF_LIMITS.frameBytes || ++this.events > TOOL_PROOF_LIMITS.events) limited();
      frames.push(clientFrame(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end);
    }
    if (this.buffer.length > TOOL_PROOF_LIMITS.frameBytes) limited();
    return frames;
  }
  finish(): void {
    if (this.invalid || this.buffer.length) {
      this.invalid = true;
      fail();
    }
    this.ended = true;
  }
}

/** Only descriptor agreement; callers separately authenticate and persist any authority. */
export function crossCheckToolCalls(
  raw: RawToolResponseProof,
  client: ClientToolResponseProof,
  restoreName: (wireName: string) => string
): void {
  try {
    if (raw.calls.length !== client.calls.length) fail();
    raw.calls.forEach((call, n) => {
      const other = client.calls[n];
      if (call.id !== other.id || restoreName(call.wireName) !== other.name) fail();
      if (canonicalToolJSON(call.input) !== canonicalToolJSON(objectJSON(other.arguments))) fail();
    });
  } catch {
    fail();
  }
}
