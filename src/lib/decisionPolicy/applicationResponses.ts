import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applicationResponsesStream } from "./applicationResponsesStream";

const textItem = z
  .object({
    type: z.enum(["input_text", "output_text"]),
    text: z.string(),
    annotations: z.array(z.never()).optional(),
  })
  .strict();
const messageItem = z
  .object({
    type: z.literal("message").optional(),
    id: z.string().min(1).max(128).optional(),
    status: z.literal("completed").optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(textItem).min(1).max(32)]),
  })
  .strict()
  .refine(
    (item) =>
      typeof item.content === "string" ||
      item.content.every((part) => part.type !== "output_text" || item.role === "assistant")
  );
const functionItem = z
  .object({
    type: z.literal("function_call"),
    call_id: z.string().min(1).max(128),
    id: z.string().min(1).max(128).optional(),
    status: z.literal("completed").optional(),
    name: z.string().min(1),
    arguments: z.string(),
  })
  .strict();
const functionResult = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string().min(1).max(128),
    output: z.string(),
  })
  .strict();
const responseInputItem = z.union([messageItem, functionItem, functionResult]);
const requestSchema = z
  .object({
    model: z.string().min(1).max(200),
    input: z.union([z.string().min(1), z.array(responseInputItem).min(1).max(128)]),
    instructions: z.string().optional(),
    max_output_tokens: z.number().int().positive().max(1000000).optional(),
    reasoning: z
      .object({ effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]) })
      .strict()
      .optional(),
    stream: z.boolean().optional(),
    store: z.boolean().optional(),
    previous_response_id: z.string().min(1).max(100).optional(),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            name: z.string().min(1),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()),
            strict: z.boolean().optional(),
          })
          .strict()
      )
      .max(64)
      .optional(),
    tool_choice: z.enum(["auto", "none"]).optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .strict();

export type ResponsesResultOptions = {
  id: string;
  store: boolean;
  streaming: boolean;
  signal: AbortSignal;
  prepare: (commitTools: () => void) => void;
  reportedUsage: () => Record<string, unknown> | null;
  complete: (assistant: Record<string, unknown>) => void;
  release: () => void;
  fail: () => void;
};
export function applicationResponsesIntent(raw: unknown) {
  const request = requestSchema.parse(raw);
  return { store: request.store === true, previous: request.previous_response_id };
}
function appendFunctionInput(
  rows: Array<Record<string, unknown>>,
  item: z.infer<typeof functionItem>
): void {
  const call = {
    id: item.call_id,
    type: "function",
    function: { name: item.name, arguments: item.arguments },
  };
  const previous = rows.at(-1);
  if (previous?.role === "assistant")
    previous.tool_calls = [...((previous.tool_calls as unknown[]) ?? []), call];
  else rows.push({ role: "assistant", content: null, tool_calls: [call] });
}
export function applicationResponsesHistoryInput(raw: unknown, prior: unknown[] = []): unknown[] {
  const request = requestSchema.parse(raw);
  const rows = structuredClone(prior) as Array<Record<string, unknown>>;
  if (typeof request.input === "string") rows.push({ role: "user", content: request.input });
  else
    for (const item of request.input) {
      if (item.type === "function_call_output")
        rows.push({ role: "tool", content: item.output, tool_call_id: item.call_id });
      else if (item.type === "function_call") appendFunctionInput(rows, item);
      else
        rows.push({
          role: item.role,
          content:
            typeof item.content === "string"
              ? item.content
              : item.content.map((part) => part.text).join(""),
        });
    }
  return rows;
}

/** Strict application codec: unsupported controls are rejected before selection or inference. */
export function prepareApplicationResponses(
  raw: unknown,
  prior: unknown[] = []
): Record<string, unknown> {
  const request = requestSchema.parse(raw);
  return {
    model: request.model,
    messages: [
      ...(request.instructions === undefined
        ? []
        : [{ role: "system", content: request.instructions }]),
      ...applicationResponsesHistoryInput(raw, prior),
    ],
    ...(request.max_output_tokens === undefined
      ? {}
      : { max_completion_tokens: request.max_output_tokens }),
    ...(request.reasoning === undefined ? {} : { reasoning_effort: request.reasoning.effort }),
    stream: request.stream === true,
    ...(request.tools === undefined
      ? {}
      : { tools: request.tools.map(({ type, ...fn }) => ({ type, function: fn })) }),
    ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
    ...(request.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: request.parallel_tool_calls }),
  };
}

export async function applicationResponsesResult(
  response: Response,
  model: string,
  options: ResponsesResultOptions
): Promise<Response> {
  if (!response.ok) return response;
  if (options.streaming) return applicationResponsesStream(response, model, options);
  const body = await response.json();
  const message = body.choices?.[0]?.message;
  if (
    body.object !== "chat.completion" ||
    body.model !== model ||
    body.choices?.length !== 1 ||
    body.choices[0].finish_reason !== "stop" ||
    typeof message?.content !== "string" ||
    message.tool_calls?.length ||
    message.refusal
  )
    throw new Error("decision_responses_proof_rejected");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  const usage = body.usage;
  options.complete({ role: "assistant", content: message.content });
  return Response.json(
    {
      id: options.id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: body.model,
      store: options.store,
      output: [
        {
          id: "msg_" + randomUUID(),
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: message.content, annotations: [] }],
        },
      ],
      usage: usage
        ? {
            input_tokens: usage.prompt_tokens ?? null,
            output_tokens: usage.completion_tokens ?? null,
            total_tokens: usage.total_tokens ?? null,
            cost: usage.cost ?? null,
            input_tokens_details: usage.prompt_tokens_details ?? {},
            output_tokens_details: usage.completion_tokens_details ?? {},
          }
        : null,
    },
    { status: response.status, headers }
  );
}
