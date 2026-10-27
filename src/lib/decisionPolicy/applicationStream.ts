import type { ApplicationToolHooks } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import {
  ClientToolSSEFramer,
  ClientOpenAIToolCollector,
  type ClientToolSSEFrame,
} from "./toolResponseProof";
import {
  settleDecisionAttempt,
  finishDecisionApplication,
  releaseDecisionAttempt,
  type AttemptIdentity,
} from "../db/decisionAttempts";
import { claudeReportedUsage } from "./applicationProvider";
import { BoundedGeminiFrames } from "./geminiResponseProof";
import { inspectGeminiFunctionCallPart } from "./geminiToolResponseProof";
import { CodexResponseFrames } from "./codexResponseProof";

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
function sessionClientCompletion(
  client: ClientOpenAIToolCollector,
  frame: ClientToolSSEFrame
): boolean {
  if (frame.done) {
    client.done();
    return true;
  }
  return frame.payload ? client.accept(frame.payload).completion : false;
}
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
  private codex?: CodexResponseFrames;
  refused = false;
  constructor(
    private identity: AttemptIdentity,
    private tools?: ApplicationToolHooks
  ) {
    if (identity.provider === "codex")
      this.codex = new CodexResponseFrames(identity.model, tools ? {} : undefined);
    if (identity.provider === "agy")
      this.gemini = new BoundedGeminiFrames(identity.model, {
        ...(tools?.geminiResponse
          ? { validateFunctionCallPart: inspectGeminiFunctionCallPart }
          : {}),
      });
  }
  get terminalStatus(): number | undefined {
    return this.codex?.applicationStatus;
  }
  get protocolTerminal(): boolean {
    if (!this.codex?.protocolTerminal) return false;
    if (this.buffer.trim()) throw new Error("decision_stream_after_terminal");
    return true;
  }
  assertResponseHeaders(headers: Headers): void {
    this.codex?.assertReportedModel(headers.get("openai-model"));
  }
  accept(text: string): string | undefined {
    this.buffer += text;
    let validated = "";
    let delimiter: RegExpExecArray | null;
    while ((delimiter = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, delimiter.index);
      const completeFrame = this.buffer.slice(0, delimiter.index + delimiter[0].length);
      this.buffer = this.buffer.slice(delimiter.index + delimiter[0].length);
      if (frame.length > 65536) throw new Error("decision_stream_frame_too_large");
      this.frame(frame);
      if (this.codex) validated += completeFrame;
    }
    if (this.buffer.length > 65536) throw new Error("decision_stream_frame_too_large");
    // Native error/refusal frames can contain opaque credentials. Never let
    // an incomplete raw frame reach even a passthrough downstream consumer.
    return this.codex ? validated : undefined;
  }
  private frame(frame: string): void {
    if (++this.events > 8192) throw new Error("decision_stream_too_large");
    if (this.codex?.protocolTerminal && frame.trim())
      throw new Error("decision_stream_after_terminal");
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (this.stopped) throw new Error("decision_stream_after_terminal");
    if (this.codex) {
      const parsed = object(JSON.parse(data));
      const events = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("event:"))
        .map((line) => line.slice(6).trim());
      if (events.length > 1 || (events.length === 1 && events[0] !== parsed.type))
        throw new Error("decision_stream_invalid");
      this.codex.accept(parsed);
      this.observeRaw(parsed);
      this.refused = this.codex.refused;
    } else if (this.gemini) {
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
    if (this.codex) return this.codex.partial();
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
    if (this.codex) return this.codex.result();
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
  private commitCompletion?: (commitTools: () => void) => void;
  private releaseCompletion?: () => void;
  onClientCompletion(commit: (commitTools: () => void) => void, release: () => void): void {
    if (this.commitCompletion || this.finalized) throw new Error("decision_stream_rejected");
    this.commitCompletion = commit;
    this.releaseCompletion = release;
  }
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
        this.releaseCompletion?.();
      } catch {
        /* Stale session ownership cannot be reused. */
      }
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
    return this.clientOutcome ?? this.frames.terminalStatus ?? (this.frames.refused ? 422 : 200);
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
    this.frames.assertResponseHeaders(response.headers);
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
            while (true) {
              this.signal.throwIfAborted();
              const chunk = await this.rawReader!.read();
              this.signal.throwIfAborted();
              if (chunk.done) {
                this.frames.accept(decoder.decode());
                this.completeRaw(response.status, controller);
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > 1048576) throw new Error("decision_stream_too_large");
              const validated = this.frames.accept(decoder.decode(chunk.value, { stream: true }));
              if (this.frames.protocolTerminal) {
                // Codex's native protocol can complete while HTTP stays open.
                // Parse the entire received chunk first: trailing data must not
                // hide behind this close. This is protocol proof, not raw EOF.
                // Flush the UTF-8 decoder too: an incomplete trailing codepoint
                // must not disappear behind a valid protocol terminal.
                this.frames.accept(decoder.decode());
                if (!this.frames.protocolTerminal) throw new Error("decision_stream_incomplete");
                this.assertNativeFrameSafe(response.status);
                this.completeRaw(response.status, controller, new TextEncoder().encode(validated));
                void this.rawReader!.cancel().catch(() => {});
                return;
              }
              this.assertNativeFrameSafe(response.status);
              if (validated === "") continue;
              controller.enqueue(
                validated === undefined ? chunk.value : new TextEncoder().encode(validated)
              );
              return;
            }
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
  private completeRaw(
    status: number,
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk?: Uint8Array
  ): void {
    this.settleRaw(status);
    if (chunk?.byteLength) controller.enqueue(chunk);
    this.controllers.delete(controller);
    controller.close();
  }
  private settleRaw(status: number): void {
    const usage = this.frames.result();
    settleDecisionAttempt(this.identity, { status, ...usage });
    this.verifiedClientUsage = clientUsage(usage);
    this.settled = true;
    this.tools?.rawComplete();
    this.rawComplete = true;
  }
  private assertNativeFrameSafe(status: number): void {
    const failure = this.frames.terminalStatus;
    if (failure === undefined || failure < 400) return;
    // Valid native terminal receipts are independent of their unsafe human
    // error/refusal text. Preserve that receipt before the static rejection.
    if (this.frames.protocolTerminal) this.settleRaw(status);
    this.stop(failure);
    throw new Error("decision_stream_rejected");
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
  private commitClientMetadata(
    framer: ClientToolSSEFramer,
    client?: ClientOpenAIToolCollector
  ): void {
    framer.finish();
    if (!this.rawComplete) throw new Error("decision_stream_incomplete");
    if (client?.finish()) throw new Error("decision_stream_rejected");
    this.tools?.validateClientComplete(this.successStatus());
    if (this.successStatus() < 400) {
      const commitTools = () => this.tools?.commitClientComplete();
      if (this.commitCompletion) this.commitCompletion(commitTools);
      else commitTools();
    }
  }
  private wrapTools(response: Response): Response {
    const reader = response.body!.getReader();
    this.clientReader = reader;
    const framer = new ClientToolSSEFramer();
    const sessionClient = this.tools
      ? undefined
      : new ClientOpenAIToolCollector(this.identity.model);
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
        this.commitClientMetadata(framer, sessionClient);
        queued.push(concatFrames(held, heldBytes));
        ended = true;
        return;
      }
      for (const frame of framer.push(chunk.value)) {
        const completion =
          this.tools?.clientFrame(frame.payload, frame.done) ??
          sessionClientCompletion(sessionClient!, frame);
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
    if (this.tools || this.commitCompletion) return this.wrapTools(response);
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
