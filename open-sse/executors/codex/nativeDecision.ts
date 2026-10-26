import { isDeepStrictEqual } from "node:util";
import { currentApplicationAttempt } from "../../services/decisionPolicy/applicationContext.ts";
import { isCliCompatEnabled } from "../../config/cliFingerprints.ts";
import { parseTokenExpiryMs } from "../../../src/lib/tokenHealthCheckExpiry";
import { getForcedReasoningEffort } from "../../utils/reasoningRuleContext.ts";
import { openaiToOpenAIResponsesRequest } from "../../translator/request/openai-responses/toResponses.ts";
import { CODEX_CHAT_DEFAULT_INSTRUCTIONS } from "../../config/codexInstructions.ts";
import { boundedJson, type ChatPolicyBody } from "../../services/decisionPolicy/requestFacts.ts";
import {
  canonicalToolId,
  parseDecisionToolArguments,
} from "../../services/decisionPolicy/toolContract.ts";
import type { ExecuteInput, ProviderCredentials } from "../base.ts";

export const NATIVE_DECISION_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const NATIVE_DECISION_CODEX_USER_AGENT = "OmniRoute-Codex/1.0";
const PAIRS: Readonly<Record<string, readonly string[]>> = {
  "gpt-6-luna": ["max"],
  "gpt-5.6-sol": ["medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["medium", "high", "xhigh", "max"],
};
function reject(): never {
  throw new Error("decision_codex_contract_unsupported");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject();
}
export function isNativeDecisionCodexPair(model: string, effort: string): boolean {
  return Object.hasOwn(PAIRS, model) && PAIRS[model].includes(effort);
}
/** Stored account binding only; never infer an account by decoding a bearer token. */
function accountId(credentials: ProviderCredentials): string {
  const account = credentials.providerSpecificData?.workspaceId;
  if (typeof account !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(account)) reject();
  return account;
}
export function assertNativeDecisionCodexCredentials(credentials: ProviderCredentials): void {
  const data = record(credentials.providerSpecificData);
  keys(data, ["workspaceId", "codexFingerprintSeed", "_omnirouteCodexThinking"]);
  // The database persists this dormant UUID even when convergence is off.
  // Accept its existing bounded shape, without deriving or forwarding identity.
  if (
    data.codexFingerprintSeed !== undefined &&
    (typeof data.codexFingerprintSeed !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        data.codexFingerprintSeed
      ))
  )
    reject();
  if (
    typeof credentials.accessToken !== "string" ||
    !credentials.accessToken.trim() ||
    credentials.apiKey ||
    !credentials.connectionId ||
    parseTokenExpiryMs(credentials.expiresAt) < Date.now() + 60_000 ||
    credentials.requestEndpointPath !== undefined ||
    getForcedReasoningEffort(credentials) !== undefined ||
    isCliCompatEnabled("codex")
  )
    reject();
  accountId(credentials);
}
/** Only the pre-existing request-local catalog carrier may accompany the stored binding. */
function assertThinkingMetadata(
  credentials: ProviderCredentials,
  model: string,
  effort: string
): void {
  const value = credentials.providerSpecificData?._omnirouteCodexThinking;
  if (value === undefined) return;
  const data = record(value);
  keys(data, [
    "model",
    "supportedThinkingEfforts",
    "defaultThinkingEffort",
    "resolvedThinkingEffort",
    "requestedThinkingEffort",
  ]);
  if (
    data.model !== model ||
    !Array.isArray(data.supportedThinkingEfforts) ||
    !data.supportedThinkingEfforts.includes(effort) ||
    data.requestedThinkingEffort !== effort ||
    (data.resolvedThinkingEffort !== undefined && data.resolvedThinkingEffort !== effort)
  )
    reject();
}
export function nativeDecisionCodexContext(model: string, credentials: ProviderCredentials) {
  const attempt = currentApplicationAttempt();
  if (attempt?.executionContract !== "codex-native-output-v1") return null;
  if (
    attempt.provider !== "codex" ||
    attempt.model !== model ||
    !isNativeDecisionCodexPair(model, attempt.effort) ||
    attempt.connectionId !== credentials.connectionId ||
    attempt.dispatch.singleAttempt !== true ||
    !Number.isSafeInteger(attempt.nativeOutput?.contextOutputTokens) ||
    Number(attempt.nativeOutput?.contextOutputTokens) < 1
  )
    reject();
  attempt.signal.throwIfAborted();
  assertNativeDecisionCodexCredentials(credentials);
  assertThinkingMetadata(credentials, model, attempt.effort);
  return attempt;
}
export function requestsNativeDecisionCodex(input: ExecuteInput): boolean {
  return (
    !!input.validationDispatch ||
    currentApplicationAttempt()?.executionContract === "codex-native-output-v1"
  );
}
export function assertNativeDecisionCodexInput(input: ExecuteInput): void {
  if (
    !nativeDecisionCodexContext(input.model, input.credentials) ||
    input.validationDispatch?.singleAttempt !== true ||
    input.stream !== true ||
    (input.upstreamExtraHeaders && Object.keys(input.upstreamExtraHeaders).length)
  )
    reject();
  input.signal?.throwIfAborted();
}
export function nativeDecisionCodexHeaders(
  model: string,
  credentials: ProviderCredentials,
  stream = true
) {
  if (!nativeDecisionCodexContext(model, credentials) || stream !== true) reject();
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": accountId(credentials),
    "User-Agent": NATIVE_DECISION_CODEX_USER_AGENT,
  };
}
function assertTextItem(value: unknown, tools = false): void {
  const item = record(value);
  keys(
    item,
    tools
      ? [
          "type",
          "role",
          "content",
          "status",
          "id",
          "phase",
          "encrypted_content",
          "internal_chat_message_metadata_passthrough",
        ]
      : ["type", "role", "content", "status"]
  );
  if (
    item.type !== "message" ||
    !["user", "assistant", "developer"].includes(String(item.role)) ||
    !Array.isArray(item.content) ||
    (item.status !== undefined && item.status !== "completed")
  )
    reject();
  if (tools) assertReplayMetadata(item);
  const expectedType = item.role === "assistant" ? "output_text" : "input_text";
  for (const value of item.content)
    assertTextPart(value, expectedType, tools && item.role === "assistant");
}
function assertTextPart(value: unknown, expectedType: string, replay: boolean): void {
  const part = record(value);
  keys(part, replay ? ["type", "text", "annotations", "logprobs"] : ["type", "text"]);
  if (part.type !== expectedType || typeof part.text !== "string") reject();
  for (const key of ["annotations", "logprobs"])
    if (
      part[key] !== undefined &&
      (!Array.isArray(part[key]) || part[key].length > 64 || !boundedJson(part[key]))
    )
      reject();
}
function assertReplayMetadata(item: Record<string, unknown>): void {
  if (item.id !== undefined && (typeof item.id !== "string" || !item.id || item.id.length > 256))
    reject();
  if (
    item.phase !== undefined &&
    !["commentary", "partial_answer", "final_answer"].includes(String(item.phase))
  )
    reject();
  if (
    item.encrypted_content !== undefined &&
    item.encrypted_content !== null &&
    (typeof item.encrypted_content !== "string" ||
      !item.encrypted_content ||
      Buffer.byteLength(item.encrypted_content) > 65536)
  )
    reject();
  if (
    item.internal_chat_message_metadata_passthrough !== undefined &&
    item.internal_chat_message_metadata_passthrough !== null
  ) {
    record(item.internal_chat_message_metadata_passthrough);
    if (!boundedJson(item.internal_chat_message_metadata_passthrough)) reject();
  }
}
function assertReasoningItem(value: Record<string, unknown>): void {
  keys(value, [
    "type",
    "id",
    "summary",
    "content",
    "encrypted_content",
    "internal_chat_message_metadata_passthrough",
  ]);
  assertReplayMetadata(value);
  if (
    typeof value.encrypted_content !== "string" ||
    !value.encrypted_content ||
    !Array.isArray(value.summary) ||
    value.summary.length > 64
  )
    reject();
  for (const raw of value.summary) {
    const part = record(raw);
    keys(part, ["type", "text"]);
    if (part.type !== "summary_text" || typeof part.text !== "string") reject();
  }
  if (value.content === undefined) return;
  if (!Array.isArray(value.content) || value.content.length > 64) reject();
  for (const raw of value.content) {
    const part = record(raw);
    keys(part, ["type", "text"]);
    if (!["reasoning_text", "text"].includes(String(part.type)) || typeof part.text !== "string")
      reject();
  }
}
function functionTools(body: Record<string, unknown>, allowed: boolean): Set<string> {
  if (body.tools === undefined) return new Set();
  if (!allowed || !Array.isArray(body.tools) || !body.tools.length || body.tools.length > 64)
    reject();
  const names = new Set<string>();
  for (const raw of body.tools) {
    const tool = record(raw);
    keys(tool, ["type", "name", "description", "parameters", "strict"]);
    if (
      tool.type !== "function" ||
      typeof tool.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,57}$/.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.strict !== "boolean" ||
      (tool.description !== undefined && typeof tool.description !== "string")
    )
      reject();
    record(tool.parameters);
    if (!boundedJson(tool.parameters)) reject();
    names.add(tool.name);
  }
  return names;
}
function assertToolOutput(value: unknown): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value) || value.length > 64) reject();
  for (const raw of value) {
    const part = record(raw);
    keys(part, ["type", "text"]);
    if (part.type !== "input_text" || typeof part.text !== "string") reject();
  }
}
function assertNativeInputs(input: unknown[], names: Set<string>, allowed: boolean): void {
  const pending = new Set<string>(),
    seen = new Set<string>();
  for (const raw of input) {
    const item = record(raw);
    if (item.type === "message") {
      assertTextItem(item, allowed);
      continue;
    }
    if (!allowed) reject();
    if (item.type === "reasoning") {
      assertReasoningItem(item);
      continue;
    }
    if (item.type === "function_call") {
      assertFunctionInput(item, names, pending, seen);
      continue;
    }
    if (item.type !== "function_call_output") reject();
    keys(item, ["type", "call_id", "output", "status"]);
    const id = canonicalToolId(item.call_id);
    if (!pending.delete(id) || (item.status !== undefined && item.status !== "completed")) reject();
    assertToolOutput(item.output);
  }
  if (pending.size) reject();
}
function assertFunctionMetadata(item: Record<string, unknown>): void {
  keys(item, [
    "type",
    "id",
    "call_id",
    "name",
    "arguments",
    "status",
    "namespace",
    "encrypted_content",
    "encrypted_function_args",
    "internal_chat_message_metadata_passthrough",
  ]);
  assertReplayMetadata(item);
  // This lane offers flat function definitions, never namespaced tools.
  if (item.namespace != null) reject();
  if (
    item.encrypted_function_args !== undefined &&
    item.encrypted_function_args !== null &&
    (!Array.isArray(item.encrypted_function_args) ||
      item.encrypted_function_args.length > 32 ||
      item.encrypted_function_args.some(
        (value) => typeof value !== "string" || !value || Buffer.byteLength(value) > 65536
      ))
  )
    reject();
}
function assertFunctionInput(
  item: Record<string, unknown>,
  names: Set<string>,
  pending: Set<string>,
  seen: Set<string>
): void {
  assertFunctionMetadata(item);
  const id = canonicalToolId(item.call_id);
  if (
    seen.has(id) ||
    !names.has(String(item.name)) ||
    (item.status !== undefined && item.status !== "completed")
  )
    reject();
  parseDecisionToolArguments(String(item.arguments));
  if (typeof item.arguments !== "string") reject();
  seen.add(id);
  pending.add(id);
}
function assertNativeWire(
  body: Record<string, unknown>,
  model: string,
  effort: string,
  tools = false
): void {
  keys(body, [
    "model",
    "input",
    "instructions",
    "stream",
    "store",
    "reasoning",
    "include",
    "tool_choice",
    "parallel_tool_calls",
    ...(tools ? ["tools"] : []),
  ]);
  if (
    body.model !== model ||
    body.stream !== true ||
    body.store !== false ||
    typeof body.instructions !== "string" ||
    !body.instructions.trim() ||
    !Array.isArray(body.input) ||
    !body.input.length ||
    body.input.length > (tools ? 512 : 128)
  )
    reject();
  assertNativeInputs(body.input, functionTools(body, tools), tools);
  assertNativeOptions(body, effort);
}
function assertNativeOptions(body: Record<string, unknown>, effort: string): void {
  const reasoning = record(body.reasoning);
  keys(reasoning, ["effort", "summary"]);
  if (reasoning.effort !== effort) reject();
  if (
    reasoning.summary !== undefined &&
    !["auto", "concise", "detailed"].includes(String(reasoning.summary))
  )
    reject();
  if (
    body.include !== undefined &&
    !isDeepStrictEqual(body.include, ["reasoning.encrypted_content"])
  )
    reject();
  if (body.tool_choice !== undefined && !["auto", "none"].includes(String(body.tool_choice)))
    reject();
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean")
    reject();
}
/** Remove only the trusted planning allowance. This field is never a provider token ceiling. */
export function nativeDecisionCodexProjection(
  model: string,
  body: unknown,
  credentials: ProviderCredentials
) {
  const attempt = nativeDecisionCodexContext(model, credentials);
  if (!attempt) reject();
  let value = structuredClone(record(body));
  for (const cap of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    if (value[cap] !== undefined && value[cap] !== attempt.nativeOutput!.contextOutputTokens)
      reject();
    delete value[cap];
  }
  if (value.instructions === "") value.instructions = CODEX_CHAT_DEFAULT_INSTRUCTIONS;
  // The shared protocol sanitizer strips store on non-OpenAI providers;
  // the existing Codex executor normally restores this required false value.
  if (value.store === undefined) value.store = false;
  if (attempt.tools) {
    if (!attempt.tools.codexRequest) reject();
    value = record(
      attempt.tools.codexRequest(model, value, true, credentials as Record<string, unknown>)
    );
  }
  assertNativeWire(value, model, attempt.effort, !!attempt.tools);
  return value;
}
/** Recompute with the existing formatter from original accepted text, never from edited wire facts. */
export function nativeDecisionCodexWireFacts(
  wire: Record<string, unknown>,
  headerInput: HeadersInit,
  credentials: ProviderCredentials,
  originalBody: ChatPolicyBody,
  effort: string
) {
  const attempt = nativeDecisionCodexContext(String(wire.model), credentials);
  if (!attempt || attempt.effort !== effort) reject();
  assertNativeWire(wire, attempt.model, effort, !!attempt.tools);
  const headers = new Headers(headerInput);
  const expectedHeaders = nativeDecisionCodexHeaders(attempt.model, credentials);
  const allowedHeaders = Object.keys(expectedHeaders).map((key) => key.toLowerCase());
  for (const key of headers.keys()) {
    if (!allowedHeaders.includes(key)) reject();
  }
  for (const [key, value] of Object.entries(expectedHeaders)) {
    if (headers.get(key) !== value) reject();
  }
  const expected = nativeDecisionCodexProjection(
    attempt.model,
    openaiToOpenAIResponsesRequest(
      attempt.model,
      { ...originalBody, reasoning_effort: effort },
      true,
      credentials
    ),
    credentials
  );
  if (!isDeepStrictEqual(wire, expected)) reject();
  attempt.tools?.beforeFetch(wire);
  return {
    messages: originalBody.messages,
    output: attempt.nativeOutput!.contextOutputTokens,
    messageCount: originalBody.messages.length,
  };
}
/** Initial supported tool lane; old completed cycles without held authority stay excluded. */
export function supportsNativeCodexToolRequest(body: ChatPolicyBody): boolean {
  try {
    if (!boundedJson(body) || body.stream !== true || !body.tools?.length) return false;
    const latestUser = body.messages.findLastIndex((message) => message.role === "user");
    return !body.messages.some(
      (message, index) =>
        index < latestUser && (message.role === "tool" || !!message.tool_calls?.length)
    );
  } catch {
    return false;
  }
}
