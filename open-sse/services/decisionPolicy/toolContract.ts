import {
  boundedJson,
  normalizeDecisionTextRequest,
  type ChatPolicyBody,
  type ProviderNativeOutput,
} from "./requestFacts.ts";

export type ClientToolCall = { id: string; name: string; arguments: string };
export type ClientToolGroup = {
  assistantIndex: number;
  clientPrefixJSON: string;
  toolContractJSON: string;
  calls: ClientToolCall[];
};
export type InspectedToolRequest = {
  body: ChatPolicyBody;
  toolContractJSON: string;
  history: ClientToolGroup[];
  current: ClientToolGroup | null;
  completedCallIds: string[];
};
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])])
    );
  return value;
}
/** Only bounded plain JSON is traversed; this is canonicalization, not a public digest. */
export function canonicalToolJSON(value: unknown): string {
  if (!boundedJson(value)) throw new Error("decision_tool_contract_invalid");
  return JSON.stringify(sorted(value));
}
export function canonicalToolId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("decision_tool_id_unsupported");
  return value;
}
function safeArgumentNumbers(value: unknown): boolean {
  if (typeof value === "number") return !Number.isInteger(value) || Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(safeArgumentNumbers);
  if (value !== null && typeof value === "object")
    return Object.values(value).every(safeArgumentNumbers);
  return true;
}
/** Bounded JSON argument objects only; integers cannot change meaning in JS/Python. */
export function assertDecisionToolArguments(
  value: unknown
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !boundedJson(value) ||
    !safeArgumentNumbers(value)
  )
    throw new Error("decision_tool_arguments_invalid");
}
export function parseDecisionToolArguments(value: string): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 65536)
    throw new Error("decision_tool_arguments_invalid");
  let args: unknown;
  try {
    args = JSON.parse(value);
  } catch {
    throw new Error("decision_tool_arguments_invalid");
  }
  assertDecisionToolArguments(args);
  return args;
}
function argumentsString(value: unknown): string {
  if (typeof value !== "string") throw new Error("decision_tool_arguments_invalid");
  parseDecisionToolArguments(value);
  return value;
}
export function canonicalClientToolCall(raw: unknown): ClientToolCall {
  if (!boundedJson(raw) || !raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("decision_tool_call_invalid");
  const call = raw as Record<string, unknown>;
  const fn = call.function as Record<string, unknown> | undefined;
  if (call.type !== "function" || !fn || typeof fn !== "object")
    throw new Error("decision_tool_call_invalid");
  if (typeof fn.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,57}$/.test(fn.name))
    throw new Error("decision_tool_name_unsupported");
  return { id: canonicalToolId(call.id), name: fn.name, arguments: argumentsString(fn.arguments) };
}
function canonicalMessage(row: ChatPolicyBody["messages"][number]) {
  // Hermes's original call constructor uses empty content for a tool-only assistant;
  // SDKs may represent that same empty content as null.
  return row.role === "assistant" && row.tool_calls?.length && row.content === null
    ? { ...row, content: "" }
    : row;
}
export function canonicalClientPrefix(messages: ChatPolicyBody["messages"]): string {
  return canonicalToolJSON(messages.map(canonicalMessage));
}
function roleCarriersValid(row: ChatPolicyBody["messages"][number]): boolean {
  if (row.role !== "tool" && row.tool_call_id !== undefined) return false;
  if (row.role !== "assistant" && row.tool_calls !== undefined) return false;
  return true;
}
function checkedCalls(row: ChatPolicyBody["messages"][number]): ClientToolCall[] {
  if (row.role !== "assistant" || !row.tool_calls?.length || row.tool_calls.length > 32)
    throw new Error("decision_tool_group_invalid");
  const calls = row.tool_calls.map(canonicalClientToolCall);
  if (new Set(calls.map((call) => call.id)).size !== calls.length)
    throw new Error("decision_tool_group_invalid");
  return calls;
}
function checkTools(body: ChatPolicyBody): void {
  if (!body.tools?.length) {
    if (body.tool_choice !== undefined || body.parallel_tool_calls !== undefined)
      throw new Error("decision_tool_contract_invalid");
    return;
  }
  const names = new Set<string>();
  for (const tool of body.tools) {
    const name = tool.function.name;
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,57}$/.test(name) || names.has(name))
      throw new Error("decision_tool_name_unsupported");
    names.add(name);
  }
}
class ToolHistory {
  private groups: ClientToolGroup[] = [];
  private pending: ClientToolGroup | null = null;
  private answered = new Set<string>();
  private activeStart = 0;
  constructor(
    private body: ChatPolicyBody,
    private toolContractJSON: string
  ) {}
  private assertComplete(): void {
    if (this.pending && this.answered.size !== this.pending.calls.length)
      throw new Error("decision_tool_group_incomplete");
  }
  accept(row: ChatPolicyBody["messages"][number], index: number): void {
    if (row.role === "tool") {
      const id = canonicalToolId(row.tool_call_id);
      if (
        !this.pending ||
        this.answered.has(id) ||
        !this.pending.calls.some((call) => call.id === id)
      )
        throw new Error("decision_tool_group_invalid");
      this.answered.add(id);
      return;
    }
    this.assertComplete();
    this.pending = null;
    this.answered.clear();
    if (row.role === "user") this.activeStart = this.groups.length;
    if (!row.tool_calls?.length) return;
    this.pending = {
      assistantIndex: index,
      calls: checkedCalls(row),
      clientPrefixJSON: canonicalClientPrefix(this.body.messages.slice(0, index + 1)),
      toolContractJSON: this.toolContractJSON,
    };
    this.groups.push(this.pending);
    if (this.groups.length > 32) throw new Error("decision_tool_chain_limit");
  }
  result() {
    this.assertComplete();
    const current = this.body.messages.at(-1)?.role === "tool" ? this.pending : null;
    return {
      history: current ? this.groups.slice(this.activeStart) : [],
      current,
      completedCallIds: current ? [...this.answered].sort() : [],
    };
  }
}
function historyOf(body: ChatPolicyBody, toolContractJSON: string) {
  const history = new ToolHistory(body, toolContractJSON);
  for (const [index, row] of body.messages.entries()) history.accept(row, index);
  return history.result();
}
/** Parse a bounded accepted client request. No IDs or text here can grant authority. */
export function inspectToolRequest(
  raw: unknown,
  nativeOutput?: ProviderNativeOutput
): InspectedToolRequest | null {
  try {
    const body = normalizeDecisionTextRequest(raw, nativeOutput);
    if (!body || !body.messages.every(roleCarriersValid)) return null;
    checkTools(body);
    const toolContractJSON = canonicalToolJSON({
      ...(nativeOutput
        ? {
            outputPolicy: {
              mode: "provider-native-output-v1",
              contextOutputTokens: nativeOutput.contextOutputTokens,
            },
          }
        : {}),
      tools: body.tools ?? [],
      ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
      ...(body.parallel_tool_calls === undefined
        ? {}
        : { parallel_tool_calls: body.parallel_tool_calls }),
    });
    const history = historyOf(body, toolContractJSON);
    const names = new Set(body.tools?.map((tool) => tool.function.name) ?? []);
    if (history.history.some((group) => group.calls.some((call) => !names.has(call.name))))
      return null;
    return { body, toolContractJSON, ...history };
  } catch {
    return null;
  }
}
