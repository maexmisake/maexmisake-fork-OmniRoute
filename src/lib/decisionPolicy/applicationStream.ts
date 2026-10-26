import type { ApplicationToolHooks } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import { ClientToolSSEFramer } from "./toolResponseProof";
import {
  settleDecisionAttempt,
  finishDecisionApplication,
  releaseDecisionAttempt,
  type AttemptIdentity,
} from "../db/decisionAttempts";
import { claudeReportedUsage } from "./applicationProvider";
import { BoundedGeminiFrames } from "./geminiResponseProof";
import { inspectGeminiFunctionCallPart } from "./geminiToolResponseProof";

function concatFrames(chunks: Uint8Array[], bytes: number): Uint8Array {
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("decision_stream_invalid");
  return value as Json;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function cost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function clientUsage(usage: ReturnType<ProviderFrames["result"]>): Json | null {
  if (
    usage.input === null ||
    usage.output === null ||
    !Number.isSafeInteger(usage.input + usage.output)
  )
    return null;
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    cost: usage.cost,
    prompt_tokens_details: {
      ...(usage.cacheRead === null ? {} : { cached_tokens: usage.cacheRead }),
      ...(usage.cacheCreation === null ? {} : { cache_creation_tokens: usage.cacheCreation }),
    },
    ...(usage.reasoning === null
      ? {}
      : { completion_tokens_details: { reasoning_tokens: usage.reasoning } }),
  };
}
/** Provider evidence only. Downstream translators' synthetic terminal frames are not evidence. */
class ProviderFrames {
  private buffer = "";
  private events = 0;
  private started = false;
  private stopped = false;
  private finished = false;
  private usage: Json = {};
  private blocks = new Set<number>();
  private gemini?: BoundedGeminiFrames;
  refused = false;
  constructor(
    private identity: AttemptIdentity,
    private tools?: ApplicationToolHooks
  ) {
    if (identity.provider === "agy")
      this.gemini = new BoundedGeminiFrames(identity.model, {
        ...(tools?.geminiResponse
          ? { validateFunctionCallPart: inspectGeminiFunctionCallPart }
          : {}),
      });
  }
  accept(text: string): void {
    this.buffer += text;
    let delimiter: RegExpExecArray | null;
    while ((delimiter = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, delimiter.index);
      this.buffer = this.buffer.slice(delimiter.index + delimiter[0].length);
      if (frame.length > 65536) throw new Error("decision_stream_frame_too_large");
      this.frame(frame);
    }
    if (this.buffer.length > 65536) throw new Error("decision_stream_frame_too_large");
  }
  private frame(frame: string): void {
    if (++this.events > 8192) throw new Error("decision_stream_too_large");
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (this.stopped) throw new Error("decision_stream_after_terminal");
    if (this.gemini) {
      const parsed = object(JSON.parse(data));
      this.gemini.accept(parsed);
      this.observeRaw(parsed);
      this.refused = this.gemini.refused;
    } else if (this.identity.provider === "claude") {
      const parsed = object(JSON.parse(data));
      const events = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("event:"))
        .map((line) => line.slice(6).trim());
      if (events.length !== 1 || events[0] !== parsed.type)
        throw new Error("decision_stream_invalid");
      this.observeRaw(parsed);
      this.claude(parsed);
    } else this.openai(data);
  }
  private observeRaw(event: Json): void {
    this.tools?.rawEvent(event);
  }
  private allowedStop(reason: unknown): boolean {
    return (
      [
        "end_turn",
        "max_tokens",
        "stop_sequence",
        "refusal",
        "model_context_window_exceeded",
      ].includes(String(reason)) ||
      (this.tools !== undefined && reason === "tool_use")
    );
  }
  private allowedBlock(type: unknown): boolean {
    return (
      ["text", "thinking", "redacted_thinking"].includes(String(type)) ||
      (this.tools !== undefined && type === "tool_use")
    );
  }
  private allowedDelta(type: unknown): boolean {
    return (
      ["text_delta", "thinking_delta", "signature_delta"].includes(String(type)) ||
      (this.tools !== undefined && type === "input_json_delta")
    );
  }
  private claude(data: Json): void {
    const type = data.type;
    if (type === "ping") return;
    if (type === "message_start") return this.claudeStart(data);
    if (!this.started) throw new Error("decision_stream_invalid");
    if (type === "message_stop") {
      if (!this.finished || this.blocks.size) throw new Error("decision_stream_incomplete");
      this.stopped = true;
      return;
    }
    if (type === "message_delta") return this.claudeDelta(data);
    if (this.finished) throw new Error("decision_stream_after_finish");
    this.claudeBlock(data);
  }
  private claudeStart(data: Json): void {
    const message = object(data.message);
    if (this.started || message.model !== this.identity.model || message.type !== "message")
      throw new Error("decision_stream_identity");
    if (!Array.isArray(message.content) || message.content.length !== 0)
      throw new Error("decision_stream_unsupported");
    this.started = true;
    this.usage = { ...object(message.usage) };
    // message_start output is an initial counter, not a terminal receipt.
    delete this.usage.output_tokens;
  }
  private claudeDelta(data: Json): void {
    const delta = object(data.delta);
    if (this.finished) {
      if (
        data.usage === undefined ||
        Object.entries(delta).some(
          ([key, value]) => !["stop_reason", "stop_sequence"].includes(key) || value !== null
        )
      )
        throw new Error("decision_stream_after_finish");
      this.usage = { ...this.usage, ...object(data.usage) };
      return;
    }
    if (this.blocks.size) throw new Error("decision_stream_incomplete");
    if (delta.stop_reason != null) {
      if (!this.allowedStop(delta.stop_reason)) throw new Error("decision_stream_unsupported");
      this.finished = true;
      this.refused = delta.stop_reason === "refusal";
    }
    if (data.usage !== undefined) this.usage = { ...this.usage, ...object(data.usage) };
  }
  private claudeBlock(data: Json): void {
    const index = count(data.index);
    if (index === null || index > (this.tools ? 63 : 31))
      throw new Error("decision_stream_invalid");
    if (data.type === "content_block_start") {
      if (this.blocks.has(index) || !this.allowedBlock(object(data.content_block).type))
        throw new Error("decision_stream_unsupported");
      this.blocks.add(index);
      return;
    }
    if (!this.blocks.has(index)) throw new Error("decision_stream_invalid");
    if (data.type === "content_block_stop") {
      this.blocks.delete(index);
      return;
    }
    if (data.type !== "content_block_delta" || !this.allowedDelta(object(data.delta).type))
      throw new Error("decision_stream_unsupported");
  }
  private openai(text: string): void {
    if (text === "[DONE]") {
      if (!this.started || !this.finished) throw new Error("decision_stream_incomplete");
      this.stopped = true;
      return;
    }
    const data = object(JSON.parse(text));
    if (data.model !== this.identity.model || data.object !== "chat.completion.chunk")
      throw new Error("decision_stream_identity");
    if (!Array.isArray(data.choices) || data.choices.length > 1)
      throw new Error("decision_stream_unsupported");
    this.started = true;
    for (const raw of data.choices) this.openaiChoice(object(raw));
    if (data.usage != null) this.usage = { ...object(data.usage) };
  }
  private openaiChoice(choice: Json): void {
    const delta = object(choice.delta ?? {});
    if (choice.index !== 0 || delta.tool_calls || delta.function_call || this.finished)
      throw new Error("decision_stream_unsupported");
    if (delta.refusal) this.refused = true;
    if (choice.finish_reason == null) return;
    if (!["stop", "length", "content_filter"].includes(String(choice.finish_reason)))
      throw new Error("decision_stream_unsupported");
    this.finished = true;
    this.refused ||= choice.finish_reason === "content_filter";
  }
  partial() {
    if (this.gemini) return this.gemini.partial();
    // Input/cache counts describe already-processed input. Cumulative output and
    // cost are not a final bill until the provider terminal and EOF are verified.
    const usage =
      this.identity.provider === "claude"
        ? claudeReportedUsage(this.usage)
        : {
            input: count(this.usage.prompt_tokens),
            cacheRead: count((this.usage.prompt_tokens_details as Json | undefined)?.cached_tokens),
            cacheCreation: null,
          };
    return { ...usage, output: null, cost: null, reasoning: null };
  }
  result() {
    if (this.buffer.trim()) throw new Error("decision_stream_incomplete");
    if (this.gemini) return this.gemini.result();
    if (!this.stopped) throw new Error("decision_stream_incomplete");
    if (this.identity.provider === "claude")
      return { ...claudeReportedUsage(this.usage), cost: cost(this.usage.cost) };
    const completion = this.usage.completion_tokens_details as Json | undefined;
    const prompt = this.usage.prompt_tokens_details as Json | undefined;
    return {
      input: count(this.usage.prompt_tokens),
      output: count(this.usage.completion_tokens),
      cost: cost(this.usage.cost),
      reasoning: count(completion?.reasoning_tokens),
      cacheRead: count(prompt?.cached_tokens),
      cacheCreation: count(prompt?.cache_creation_tokens),
    };
  }
}
/** Two pull-through taps: raw evidence, then actual client completion/cancellation. */
class ApplicationStream {
  active = false;
  private settled = false;
  private rawComplete = false;
  private finalized = false;
  private rawReader?: ReadableStreamDefaultReader<Uint8Array>;
  private clientReader?: ReadableStreamDefaultReader<Uint8Array>;
  private controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private frames: ProviderFrames;
  private clientTerminal = false;
  private clientOutcome: number | undefined;
  private verifiedClientUsage: Json | null = null;
  private clientTail = "";
  private clientDecoder = new TextDecoder();
  constructor(
    private identity: AttemptIdentity,
    private signal: AbortSignal,
    readonly includeUsage: boolean,
    private tools?: ApplicationToolHooks
  ) {
    this.frames = new ProviderFrames(identity, tools);
  }
  private settleUnknown(): void {
    if (this.settled) return;
    settleDecisionAttempt(this.identity, { status: null, ...this.frames.partial() });
    this.settled = true;
  }
  private finalize(status: number): void {
    if (this.finalized) return;
    this.finalized = true;
    this.signal.removeEventListener("abort", this.abort);
    try {
      this.settleUnknown();
      finishDecisionApplication(this.identity.id, status);
    } catch {
      /* Durable unknown liability remains authoritative; never replay. */
    } finally {
      try {
        releaseDecisionAttempt(this.identity);
      } catch {
        /* Occupancy expires. */
      }
    }
  }
  private abortStatus(): number {
    return this.signal.reason?.name === "TimeoutError" ? 504 : 499;
  }
  reportedClientUsage(): Json | null {
    return this.verifiedClientUsage ? structuredClone(this.verifiedClientUsage) : null;
  }
  noteClientOutcome(status: number): void {
    if (status >= 400) this.clientOutcome = status;
  }
  private successStatus(): number {
    return this.clientOutcome ?? (this.frames.refused ? 422 : 200);
  }
  private abort = (): void => {
    this.stop(this.abortStatus());
  };
  private stop(status: number): void {
    this.finalize(status);
    for (const controller of this.controllers) {
      try {
        controller.error(new Error("decision_stream_rejected"));
      } catch {
        /* Already closed. */
      }
    }
    void this.rawReader?.cancel().catch(() => {});
    void this.clientReader?.cancel().catch(() => {});
  }
  observe(response: Response): Response {
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
      throw new Error("decision_stream_content_type");
    this.signal.throwIfAborted();
    this.active = true;
    this.rawReader = response.body.getReader();
    this.signal.addEventListener("abort", this.abort, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controllers.add(controller);
        },
        pull: async (controller) => {
          try {
            this.signal.throwIfAborted();
            const chunk = await this.rawReader!.read();
            this.signal.throwIfAborted();
            if (chunk.done) {
              this.frames.accept(decoder.decode());
              const usage = this.frames.result();
              settleDecisionAttempt(this.identity, { status: response.status, ...usage });
              this.verifiedClientUsage = clientUsage(usage);
              this.settled = true;
              this.tools?.rawComplete();
              this.rawComplete = true;
              this.controllers.delete(controller);
              controller.close();
              return;
            }
            bytes += chunk.value.byteLength;
            if (bytes > 1048576) throw new Error("decision_stream_too_large");
            this.frames.accept(decoder.decode(chunk.value, { stream: true }));
            controller.enqueue(chunk.value);
          } catch {
            this.fail(controller);
          }
        },
        cancel: () => {
          this.stop(499);
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(body, { status: response.status, headers: response.headers });
  }
  private fail(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const failure = this.successStatus();
    this.stop(this.signal.aborted ? this.abortStatus() : failure >= 400 ? failure : 409);
    this.controllers.delete(controller);
  }
  private noteClientTerminal(chunk: Uint8Array): void {
    this.clientTail += this.clientDecoder.decode(chunk, { stream: true });
    this.clientTerminal ||= /(?:^|\n)data: \[DONE\]\r?\n/.test(this.clientTail);
    this.clientTail = this.clientTail.slice(-4096);
  }
  private assertClientOpen(): void {
    this.signal.throwIfAborted();
    if (this.finalized) throw new Error("decision_stream_rejected");
  }
  private wrapTools(response: Response): Response {
    const reader = response.body!.getReader();
    this.clientReader = reader;
    const framer = new ClientToolSSEFramer();
    const queued: Uint8Array[] = [],
      held: Uint8Array[] = [];
    let holding = false,
      ended = false,
      heldBytes = 0;
    const readMore = async () => {
      this.assertClientOpen();
      const chunk = await reader.read();
      this.assertClientOpen();
      if (chunk.done) {
        framer.finish();
        if (!this.rawComplete) throw new Error("decision_stream_incomplete");
        this.tools!.validateClientComplete(this.successStatus());
        if (this.successStatus() < 400) this.tools!.commitClientComplete();
        queued.push(concatFrames(held, heldBytes));
        ended = true;
        return;
      }
      for (const frame of framer.push(chunk.value)) {
        const completion = this.tools!.clientFrame(frame.payload, frame.done);
        holding ||= completion;
        if (holding) {
          heldBytes += frame.bytes.byteLength;
          if (heldBytes > 65536) throw new Error("decision_stream_too_large");
          held.push(frame.bytes);
        } else queued.push(frame.bytes);
      }
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controllers.add(controller);
        },
        pull: async (controller) => {
          try {
            while (!queued.length && !ended) await readMore();
            this.assertClientOpen();
            const chunk = queued.shift();
            if (chunk?.byteLength) {
              controller.enqueue(chunk);
              this.noteClientTerminal(chunk);
            }
            if (ended && !queued.length) {
              this.finalize(this.successStatus());
              this.controllers.delete(controller);
              controller.close();
            }
          } catch {
            this.fail(controller);
          }
        },
        cancel: () => {
          this.stop(this.clientTerminal && this.rawComplete ? this.successStatus() : 499);
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(body, { status: response.status, headers: this.pendingHeaders(response) });
  }
  private pendingHeaders(response: Response): Headers {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("x-omniroute-routing-cost");
    headers.set("x-omniroute-routing-cost-status", "pending");
    return headers;
  }
  wrap(response: Response): Response {
    if (this.tools) return this.wrapTools(response);
    this.clientReader = response.body!.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controllers.add(controller);
        },
        pull: async (controller) => {
          try {
            this.signal.throwIfAborted();
            const chunk = await this.clientReader!.read();
            this.signal.throwIfAborted();
            if (chunk.done) {
              this.finalize(this.successStatus());
              this.controllers.delete(controller);
              controller.close();
            } else {
              controller.enqueue(chunk.value);
              this.noteClientTerminal(chunk.value);
            }
          } catch {
            this.fail(controller);
          }
        },
        cancel: () => {
          this.stop(this.clientTerminal && this.settled ? this.successStatus() : 499);
        },
      },
      { highWaterMark: 0 }
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("x-omniroute-routing-cost");
    headers.set("x-omniroute-routing-cost-status", "pending");
    return new Response(body, { status: response.status, headers });
  }
}
export function createApplicationStream(
  identity: AttemptIdentity,
  signal: AbortSignal,
  options?: { include_usage?: boolean },
  tools?: ApplicationToolHooks
) {
  return new ApplicationStream(identity, signal, options?.include_usage === true, tools);
}
