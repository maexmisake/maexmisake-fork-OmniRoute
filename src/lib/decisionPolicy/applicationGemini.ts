import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../../open-sse/config/constants.ts";
import {
  assertBoundedAgyCredentials,
  BOUNDED_AGY_MODEL,
  BOUNDED_AGY_STREAM_URL,
  BOUNDED_AGY_USER_AGENT,
} from "../../../open-sse/executors/antigravity/bounded.ts";
import type { ProviderCredentials } from "../../../open-sse/executors/base/validationDispatch.ts";
import type { Candidate } from "../../../open-sse/services/decisionPolicy/contract.ts";
import type { ChatPolicyBody } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import { canonicalToolJSON } from "../../../open-sse/services/decisionPolicy/toolContract.ts";

type Json = Record<string, unknown>;
function reject(): never {
  throw new Error("decision_agy_final_request_unsupported");
}
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  return value as Json;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalToolJSON(left) === canonicalToolJSON(right);
}
export function isApplicationAgyPair(candidate: Candidate): boolean {
  return (
    candidate.provider === "agy" &&
    candidate.model === BOUNDED_AGY_MODEL &&
    candidate.effort.value === "high" &&
    ["set", "fixed"].includes(candidate.effort.mode)
  );
}
export function applicationAgyProvider(candidate: Candidate, connection: Json) {
  if (
    !isApplicationAgyPair(candidate) ||
    connection.provider !== "agy" ||
    connection.isActive !== true ||
    connection.authType !== "oauth" ||
    connection.apiKey
  )
    return reject();
  const data = record(connection.providerSpecificData ?? {});
  const credentials: ProviderCredentials = {
    connectionId: String(connection.id),
    accessToken: typeof connection.accessToken === "string" ? connection.accessToken : undefined,
    refreshToken: typeof connection.refreshToken === "string" ? connection.refreshToken : undefined,
    expiresAt: String(connection.tokenExpiresAt || connection.expiresAt || ""),
    projectId:
      typeof connection.projectId === "string"
        ? connection.projectId
        : typeof data.projectId === "string"
          ? data.projectId
          : undefined,
    providerSpecificData: structuredClone(data),
  };
  assertBoundedAgyCredentials(credentials);
  return {
    claude: false,
    executionContract: "agy-gemini-high-v1" as const,
    endpoint: BOUNDED_AGY_STREAM_URL,
    credentials,
  };
}
function parts(content: unknown): Json[] {
  if (content === null) return [];
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return reject();
  return content.map((value) => {
    const part = record(value);
    if (
      part.type !== "text" ||
      typeof part.text !== "string" ||
      Object.keys(part).some((key) => !["type", "text"].includes(key))
    )
      return reject();
    return { text: part.text };
  });
}
function append(contents: Json[], role: string, next: Json[]): void {
  if (!next.length) return;
  const previous = contents.at(-1);
  if (previous?.role === role) (previous.parts as Json[]).push(...next);
  else contents.push({ role, parts: next });
}
function supportedRequestShape(body: ChatPolicyBody): boolean {
  const last = body.messages.at(-1);
  return (
    body.stream === true &&
    body.max_completion_tokens <= 65536 &&
    !body.tools?.length &&
    last?.role === "user" &&
    parts(last.content).some((part) => typeof part.text === "string" && part.text.length > 0) &&
    body.messages.every(
      (row) =>
        ["system", "user", "assistant"].includes(row.role) &&
        row.name === undefined &&
        !row.tool_calls?.length &&
        row.tool_call_id === undefined
    )
  );
}
export function supportsApplicationAgyRequest(body: ChatPolicyBody): boolean {
  try {
    expectedContents(body);
    return true;
  } catch {
    return false;
  }
}
function expectedContents(body: ChatPolicyBody): Json[] {
  if (!supportedRequestShape(body)) return reject();
  const systems: Json[] = [],
    contents: Json[] = [];
  for (const row of body.messages) {
    const text = parts(row.content);
    if (row.role === "system" && body.messages.length > 1) {
      const combined = text.map((part) => part.text).join("");
      if (combined) systems.push({ text: combined });
    } else if (row.role === "assistant") {
      const combined = text.map((part) => part.text).join("");
      if (combined) append(contents, "model", [{ text: combined }]);
    } else append(contents, "user", text);
  }
  if (!contents.length || contents[0].role !== "user") return reject();
  (contents[0].parts as Json[]).unshift(...systems);
  return contents;
}
/** Validate the already serialized final wire, including documented system relocation. */
export function applicationAgyWireFacts(
  wire: Json,
  headers: Headers,
  credentials: ProviderCredentials,
  original: ChatPolicyBody,
  outputLimit: number
) {
  const request = record(wire.request);
  if (
    Object.keys(wire).some((key) => !["model", "project", "request"].includes(key)) ||
    wire.model !== BOUNDED_AGY_MODEL ||
    wire.project !== credentials.projectId ||
    Object.keys(request).some(
      (key) => !["contents", "systemInstruction", "generationConfig"].includes(key)
    ) ||
    headers.get("user-agent") !== BOUNDED_AGY_USER_AGENT ||
    headers.get("content-type") !== "application/json" ||
    headers.get("accept") !== "text/event-stream" ||
    [...headers.keys()].some(
      (key) => !["authorization", "user-agent", "content-type", "accept"].includes(key)
    )
  )
    return reject();
  if (
    !same(request.contents, expectedContents(original)) ||
    !same(request.systemInstruction, {
      role: "system",
      parts: [{ text: ANTIGRAVITY_DEFAULT_SYSTEM }],
    }) ||
    !same(request.generationConfig, {
      maxOutputTokens: outputLimit,
      thinkingConfig: { thinkingLevel: "high" },
      topK: 40,
      topP: 1,
    })
  )
    return reject();
  return original.messages;
}
