import { randomUUID } from "node:crypto";
import {
  ClientToolSSEFramer,
  ClientOpenAIToolCollector,
  type ClientToolResponseProof,
} from "./toolResponseProof";
import type { ResponsesResultOptions } from "./applicationResponses";

type Json = Record<string, unknown>;
/** Runs only outside the application raw/client proof stream; never invents a terminal. */
export function applicationResponsesStream(
  response: Response,
  model: string,
  options: ResponsesResultOptions
): Response {
  const reader = response.body!.getReader(),
    framer = new ClientToolSSEFramer();
  const proof = new ClientOpenAIToolCollector(model),
    encoder = new TextEncoder();
  const id = options.id,
    itemId = "msg_" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  let sequence = 0,
    text = "",
    terminal = "",
    started = false,
    ended = false,
    cancelled = false,
    textStarted = false;
  const calls = new Map<
    number,
    { id: string; itemId: string; name: string; arguments: string; outputIndex: number }
  >();
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const release = () => {
    options.signal.removeEventListener("abort", abort);
    options.release();
  };
  const rejectCompletion = () => {
    try {
      options.fail();
    } catch {
      /* Durable unknown outcome must not prevent transport cancellation. */
    }
    try {
      release();
    } catch {
      /* Ownership remains non-reusable until its bounded lease expires. */
    }
  };
  const cancelSource = (reason?: unknown) => {
    try {
      void reader.cancel(reason).catch(() => {});
    } catch {
      /* Source already closed. */
    }
  };
  const abort = () => {
    cancelled = true;
    rejectCompletion();
    cancelSource();
    try {
      outputController?.error(new Error("decision_responses_stream_rejected"));
    } catch {
      /* Already closed. */
    }
  };
  const pending: Uint8Array[] = [];
  const event = (type: string, fields: Json) =>
    pending.push(
      encoder.encode(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`
      )
    );
  const envelope = (status: string, output: unknown[] = [], usage: Json | null = null) => ({
    id,
    object: "response",
    created_at: created,
    model,
    status,
    store: options.store,
    output,
    usage,
  });
  const item = (status: string) => ({
    id: itemId,
    type: "message",
    role: "assistant",
    status,
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const start = () => {
    if (started) return;
    started = true;
    event("response.created", { response: envelope("in_progress") });
    event("response.in_progress", { response: envelope("in_progress") });
  };
  const startText = () => {
    if (textStarted) return;
    if (calls.size) throw new Error("decision_responses_order_rejected");
    textStarted = true;
    event("response.output_item.added", {
      output_index: 0,
      item: { ...item("in_progress"), content: [] },
    });
    event("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };
  const callItem = (
    call: { id: string; itemId: string; name: string; arguments: string },
    status: string
  ) => ({
    id: call.itemId,
    type: "function_call",
    status,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  });
  const acceptCalls = (
    rows: Array<{ index: number; id?: string; function: { name?: string; arguments?: string } }>
  ) => {
    for (const row of rows) {
      let call = calls.get(row.index);
      if (!call) {
        call = {
          id: row.id!,
          itemId: "fc_" + randomUUID(),
          name: "",
          arguments: "",
          outputIndex: row.index + (textStarted ? 1 : 0),
        };
        calls.set(row.index, call);
        call.name = row.function.name ?? "";
        event("response.output_item.added", {
          output_index: call.outputIndex,
          item: callItem(call, "in_progress"),
        });
      } else call.name += row.function.name ?? "";
      const delta = row.function.arguments;
      if (delta) {
        call.arguments += delta;
        event("response.function_call_arguments.delta", {
          item_id: call.itemId,
          output_index: call.outputIndex,
          delta,
        });
      }
    }
  };
  const accept = (row: Json) => {
    proof.accept(row);
    start();
    const choices = row.choices as Array<{
      delta?: {
        content?: string;
        refusal?: string;
        tool_calls?: Array<{
          index: number;
          id?: string;
          function: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string;
    }>;
    const choice = choices[0];
    if (choice?.delta?.refusal) throw new Error("decision_responses_refused");
    const delta = choice?.delta?.content;
    if (delta) {
      startText();
      text += delta;
      event("response.output_text.delta", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta,
      });
    }
    if (choice?.delta?.tool_calls) acceptCalls(choice.delta.tool_calls);
    if (choice?.finish_reason) terminal = choice.finish_reason;
  };
  const completeToolItems = (
    toolProof: ClientToolResponseProof | null,
    status: string
  ): unknown[] => {
    const output: unknown[] = [];
    for (const [index, call] of calls) {
      const expected = toolProof?.calls[index];
      if (
        !expected ||
        expected.id !== call.id ||
        expected.name !== call.name ||
        expected.arguments !== call.arguments
      )
        throw new Error("decision_responses_tools_rejected");
      event("response.function_call_arguments.done", {
        item_id: call.itemId,
        output_index: call.outputIndex,
        arguments: call.arguments,
      });
      const completed = callItem(call, status);
      event("response.output_item.done", { output_index: call.outputIndex, item: completed });
      output.push(completed);
    }
    return output;
  };
  const finish = () => {
    options.signal.throwIfAborted();
    if (cancelled) throw new Error("decision_responses_stream_cancelled");
    framer.finish();
    const toolProof = proof.finish();
    if (!terminal) throw new Error("decision_responses_proof_rejected");
    const usage = options.reportedUsage();
    const status = ["stop", "tool_calls"].includes(terminal) ? "completed" : "incomplete";
    if (!toolProof && !textStarted) startText();
    const output: unknown[] = [];
    if (textStarted) {
      event("response.output_text.done", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        text,
      });
      event("response.content_part.done", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: item(status).content[0],
      });
      event("response.output_item.done", { output_index: 0, item: item(status) });
      output.push(item(status));
    }
    output.push(...completeToolItems(toolProof, status));
    if (status === "completed")
      options.complete(toolProof?.assistant ?? { role: "assistant", content: text });
    else options.fail();
    try {
      release();
    } catch {
      /* Committed success remains authoritative if occupancy cleanup fails. */
    }
    event(status === "completed" ? "response.completed" : "response.incomplete", {
      response: {
        ...envelope(
          status,
          output,
          usage
            ? {
                input_tokens: usage.prompt_tokens ?? null,
                output_tokens: usage.completion_tokens ?? null,
                total_tokens: usage.total_tokens ?? null,
                cost: usage.cost ?? null,
                input_tokens_details: usage.prompt_tokens_details ?? {},
                output_tokens_details: usage.completion_tokens_details ?? {},
              }
            : null
        ),
        ...(status === "incomplete"
          ? {
              incomplete_details: {
                reason: terminal === "length" ? "max_output_tokens" : "content_filter",
              },
            }
          : {}),
      },
    });
    ended = true;
  };
  const readMore = async (): Promise<boolean> => {
    const chunk = await reader.read();
    options.signal.throwIfAborted();
    if (cancelled) return false;
    if (chunk.done) {
      finish();
      return true;
    }
    for (const frame of framer.push(chunk.value)) {
      if (frame.done) proof.done();
      else if (frame.payload) accept(frame.payload);
    }
    return true;
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        outputController = controller;
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      },
      async pull(controller) {
        try {
          options.signal.throwIfAborted();
          while (!pending.length && !ended) {
            if (!(await readMore())) return;
          }
          const next = pending.shift();
          if (next) controller.enqueue(next);
          if (ended && !pending.length) controller.close();
        } catch {
          rejectCompletion();
          cancelSource();
          try {
            controller.error(new Error("decision_responses_stream_rejected"));
          } catch {
            /* Already closed. */
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        rejectCompletion();
        try {
          await reader.cancel(reason);
        } catch {
          /* Source already closed. */
        }
      },
    },
    { highWaterMark: 0 }
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "text/event-stream");
  return new Response(body, { status: response.status, headers });
}
