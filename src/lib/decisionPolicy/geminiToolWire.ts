import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../../open-sse/config/constants.ts";
import {
  BOUNDED_AGY_MODEL,
  BOUNDED_AGY_OPUS_MODEL,
} from "../../../open-sse/executors/antigravity/bounded.ts";
import type { ChatPolicyBody } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import { boundedJson } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import {
  canonicalClientToolCall,
  canonicalToolJSON,
  inspectToolRequest,
  parseDecisionToolArguments,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import { validateGeminiToolParts } from "./geminiToolResponseProof";
import { validateGeminiCorrelationNamespace } from "./geminiToolIdentity";

export type GeminiToolJson = Record<string, unknown>;
type Row = ChatPolicyBody["messages"][number];
type Content = { role: "user" | "model"; parts: GeminiToolJson[] };
function reject(): never {
  throw new Error("decision_gemini_tool_wire_unsupported");
}
function textParts(content: unknown): GeminiToolJson[] {
  if (content === null) return [];
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return reject();
  return content.map((raw) => {
    const part = raw as GeminiToolJson;
    if (
      !part ||
      typeof part !== "object" ||
      part.type !== "text" ||
      typeof part.text !== "string" ||
      Object.keys(part).some((key) => !["type", "text"].includes(key))
    )
      return reject();
    return { text: part.text };
  });
}
function rowText(row: Row): string {
  return textParts(row.content)
    .map((part) => part.text)
    .join("");
}
function declarations(body: ChatPolicyBody): GeminiToolJson[] {
  return (body.tools ?? []).map(({ function: fn }) => {
    // Native JSON Schema has no proven equivalent to OpenAI's strict flag here.
    if (fn.strict !== undefined) return reject();
    canonicalToolJSON(fn.parameters);
    return {
      name: fn.name,
      ...(fn.description === undefined ? {} : { description: fn.description }),
      parametersJsonSchema: structuredClone(fn.parameters),
    };
  });
}
function assertClientGroups(body: ChatPolicyBody): void {
  const names = new Set(body.tools?.map((tool) => tool.function.name) ?? []);
  let pending = new Map<string, string>();
  for (const row of body.messages) {
    if (row.tool_calls?.length) {
      const calls = row.tool_calls.map(canonicalClientToolCall);
      if (calls.some((call) => !names.has(call.name))) reject();
      pending = new Map(calls.map((call) => [call.id, call.name]));
    }
    if (
      row.role === "tool" &&
      (typeof row.content !== "string" ||
        !pending.has(row.tool_call_id!) ||
        (row.name !== undefined && row.name !== pending.get(row.tool_call_id!)))
    )
      reject();
  }
}
function assertTextRow(row: Row): void {
  if (row.role === "developer" || (row.role !== "tool" && row.name !== undefined)) reject();
  if (row.role !== "tool") textParts(row.content);
}
function assertInitialUser(body: ChatPolicyBody): void {
  for (const row of body.messages) {
    if (row.role === "system") continue;
    if (row.role === "assistant" && !row.tool_calls?.length && !rowText(row)) continue;
    if (row.role === "user" && !textParts(row.content).length) continue;
    if (row.role !== "user") return reject();
    return;
  }
  reject();
}
function checkedBody(raw: ChatPolicyBody): ChatPolicyBody {
  const inspected = inspectToolRequest(raw);
  if (!inspected) return reject();
  const body = inspected.body,
    last = body.messages.at(-1)!;
  // Only authenticated groups in the active last-user chain are in this subset.
  const activeGroups = new Set(inspected.history.map((group) => group.assistantIndex));
  if (body.messages.some((row, index) => row.tool_calls?.length && !activeGroups.has(index)))
    reject();
  if (
    body.stream !== true ||
    body.max_completion_tokens > 65536 ||
    (body.reasoning_effort !== undefined && body.reasoning_effort !== "high") ||
    body.parallel_tool_calls === false ||
    !["user", "tool"].includes(last.role)
  )
    return reject();
  declarations(body);
  assertClientGroups(body);
  body.messages.forEach(assertTextRow);
  assertInitialUser(body);
  if (last.role === "user" && !rowText(last)) reject();
  return body;
}
/** Request-contract screen only: it establishes neither replay authority nor account access. */
export function supportsGeminiToolRequest(body: ChatPolicyBody): boolean {
  try {
    checkedBody(body);
    return true;
  } catch {
    return false;
  }
}
function append(contents: Content[], role: Content["role"], parts: GeminiToolJson[]): void {
  if (!parts.length) return;
  const previous = contents.at(-1);
  if (previous?.role === role) previous.parts.push(...parts);
  else contents.push({ role, parts });
}
function provenParts(
  row: Row,
  parts: readonly GeminiToolJson[],
  names: ReadonlySet<string>,
  correlationNamespace?: string,
  fixedNativeOpus = false
) {
  const proof = validateGeminiToolParts(parts, names, { correlationNamespace, fixedNativeOpus });
  const calls = row.tool_calls!.map(canonicalClientToolCall);
  const expected = calls.map((call, ordinal) => ({
    ordinal,
    id: call.id,
    name: call.name,
    args: parseDecisionToolArguments(call.arguments),
  }));
  const actual = proof.calls.map((call) => ({
    ordinal: call.ordinal,
    id: call.id,
    name: call.wireName,
    args: call.input,
  }));
  const visible = proof.parts
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("");
  if (canonicalToolJSON(actual) !== canonicalToolJSON(expected) || visible !== rowText(row))
    reject();
  return {
    parts: structuredClone(proof.parts),
    calls: calls.map((call, ordinal) => ({
      ...call,
      nativeId: proof.calls[ordinal].nativeId,
    })),
  };
}
function checkedNamespaces(
  replay: ReadonlyMap<number, readonly GeminiToolJson[]>,
  supplied?: ReadonlyMap<number, string>
): ReadonlyMap<number, string> {
  if (supplied === undefined) return new Map();
  if (!(supplied instanceof Map) || supplied.size > 32) return reject();
  const namespaces = new Map(supplied),
    unique = new Set<string>();
  for (const [index, namespace] of namespaces) {
    if (!Number.isSafeInteger(index) || !replay.has(index)) return reject();
    validateGeminiCorrelationNamespace(namespace);
    if (unique.has(namespace)) return reject();
    unique.add(namespace);
  }
  return namespaces;
}
class ToolWireContents {
  readonly contents: Content[] = [];
  private systems: GeminiToolJson[] = [];
  private used = new Set<number>();
  private names: Set<string>;
  private namespaces: ReadonlyMap<number, string>;
  constructor(
    private body: ChatPolicyBody,
    private replay: ReadonlyMap<number, readonly GeminiToolJson[]>,
    replayNamespaces?: ReadonlyMap<number, string>,
    private fixedNativeOpus = false
  ) {
    if (!(replay instanceof Map) || replay.size > 32) reject();
    // Bound all retained provider metadata before proof traversal or cloning.
    if (!boundedJson([...replay.values()])) reject();
    this.namespaces = checkedNamespaces(replay, replayNamespaces);
    this.names = new Set(body.tools?.map((tool) => tool.function.name) ?? []);
  }
  private group(index: number): number {
    const row = this.body.messages[index],
      original = this.replay.get(index);
    if (!original) return reject();
    const proof = provenParts(
      row,
      original,
      this.names,
      this.namespaces.get(index),
      this.fixedNativeOpus
    );
    this.used.add(index);
    this.contents.push({ role: "model", parts: proof.parts });
    const responses = new Map<string, Row>();
    let next = index + 1;
    while (this.body.messages[next]?.role === "tool") {
      const result = this.body.messages[next++];
      if (responses.has(result.tool_call_id!)) reject();
      responses.set(result.tool_call_id!, result);
    }
    if (responses.size !== proof.calls.length) return reject();
    const resultParts = proof.calls.map((call) => {
      const result = responses.get(call.id);
      if (!result || (result.name !== undefined && result.name !== call.name)) return reject();
      return {
        functionResponse: {
          ...(call.nativeId === null ? {} : { id: call.nativeId }),
          name: call.name,
          response: { output: result.content },
        },
      };
    });
    append(this.contents, "user", resultParts);
    return next;
  }
  private textRow(row: Row): void {
    if (row.role === "tool") return reject();
    if (row.role === "system" && this.body.messages.length > 1) {
      const text = rowText(row);
      if (text) this.systems.push({ text });
    } else if (row.role === "assistant") {
      const text = rowText(row);
      if (text) append(this.contents, "model", [{ text }]);
    } else append(this.contents, "user", textParts(row.content));
  }
  build(): Content[] {
    let index = 0;
    while (index < this.body.messages.length) {
      const row = this.body.messages[index];
      if (row.tool_calls?.length) {
        index = this.group(index);
        continue;
      }
      this.textRow(row);
      index++;
    }
    if (this.used.size !== this.replay.size || this.contents[0]?.role !== "user") return reject();
    this.contents[0].parts.unshift(...this.systems);
    return this.contents;
  }
}
/** Source-backed Code Assist envelope. Replay must come from separately authenticated origin state. */
export function buildGeminiToolWire(
  raw: ChatPolicyBody,
  model: string,
  projectId: string,
  replay: ReadonlyMap<number, readonly GeminiToolJson[]>,
  replayNamespaces?: ReadonlyMap<number, string>,
  options: { fixedNativeOpus?: boolean } = {}
): GeminiToolJson {
  const body = checkedBody(raw);
  if (
    model !== (options.fixedNativeOpus ? BOUNDED_AGY_OPUS_MODEL : BOUNDED_AGY_MODEL) ||
    typeof projectId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId) ||
    projectId === "__REQUIRES_GCP_PROJECT__"
  )
    return reject();
  const functions = declarations(body);
  const request = {
    contents: new ToolWireContents(body, replay, replayNamespaces, options.fixedNativeOpus).build(),
    systemInstruction: { role: "system", parts: [{ text: ANTIGRAVITY_DEFAULT_SYSTEM }] },
    generationConfig: options.fixedNativeOpus
      ? { topK: 40, topP: 1 }
      : {
          maxOutputTokens: body.max_completion_tokens,
          thinkingConfig: { thinkingLevel: "high" },
          topK: 40,
          topP: 1,
        },
    ...(functions.length
      ? {
          tools: [{ functionDeclarations: functions }],
          toolConfig: {
            functionCallingConfig: { mode: body.tool_choice === "none" ? "NONE" : "AUTO" },
          },
        }
      : {}),
  };
  const envelope = { model, project: projectId, request };
  if (!boundedJson(envelope)) return reject();
  return envelope;
}
/** Exact expected-wire equality, including original ordered Parts and result order. */
export function assertGeminiToolWire(actual: unknown, expected: unknown): void {
  if (canonicalToolJSON(actual) !== canonicalToolJSON(expected)) reject();
}
