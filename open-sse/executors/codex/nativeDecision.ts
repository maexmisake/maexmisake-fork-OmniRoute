import { isDeepStrictEqual } from "node:util";
import { currentApplicationAttempt } from "../../services/decisionPolicy/applicationContext.ts";
import { isCliCompatEnabled } from "../../config/cliFingerprints.ts";
import { parseTokenExpiryMs } from "../../../src/lib/tokenHealthCheckExpiry";
import { getForcedReasoningEffort } from "../../utils/reasoningRuleContext.ts";
import { openaiToOpenAIResponsesRequest } from "../../translator/request/openai-responses/toResponses.ts";
import { CODEX_CHAT_DEFAULT_INSTRUCTIONS } from "../../config/codexInstructions.ts";
import type { ChatPolicyBody } from "../../services/decisionPolicy/requestFacts.ts";
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
function assertTextItem(value: unknown): void {
  const item = record(value);
  keys(item, ["type", "role", "content", "status"]);
  if (
    item.type !== "message" ||
    !["user", "assistant", "developer"].includes(String(item.role)) ||
    !Array.isArray(item.content) ||
    (item.status !== undefined && item.status !== "completed")
  )
    reject();
  const expectedType = item.role === "assistant" ? "output_text" : "input_text";
  for (const value of item.content) {
    const part = record(value);
    keys(part, ["type", "text"]);
    if (part.type !== expectedType || typeof part.text !== "string") reject();
  }
}
function assertNativeWire(body: Record<string, unknown>, model: string, effort: string): void {
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
  ]);
  if (
    body.model !== model ||
    body.stream !== true ||
    body.store !== false ||
    typeof body.instructions !== "string" ||
    !body.instructions.trim() ||
    !Array.isArray(body.input) ||
    !body.input.length ||
    body.input.length > 128
  )
    reject();
  body.input.forEach(assertTextItem);
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
  const value = structuredClone(record(body));
  for (const cap of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    if (value[cap] !== undefined && value[cap] !== attempt.nativeOutput!.contextOutputTokens)
      reject();
    delete value[cap];
  }
  if (value.instructions === "") value.instructions = CODEX_CHAT_DEFAULT_INSTRUCTIONS;
  // The shared protocol sanitizer strips store on non-OpenAI providers;
  // the existing Codex executor normally restores this required false value.
  if (value.store === undefined) value.store = false;
  assertNativeWire(value, model, attempt.effort);
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
  assertNativeWire(wire, attempt.model, effort);
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
  return {
    messages: originalBody.messages,
    output: attempt.nativeOutput!.contextOutputTokens,
    messageCount: originalBody.messages.length,
  };
}
