import { currentApplicationAttempt } from "../../services/decisionPolicy/applicationContext.ts";
import { ANTIGRAVITY_RUNTIME_BASE_URLS } from "../../config/antigravityUpstream.ts";
import { isCliCompatEnabled } from "../../config/cliFingerprints.ts";
import { parseTokenExpiryMs } from "../../../src/lib/tokenHealthCheckExpiry";
import type { ExecuteInput, ProviderCredentials } from "../base.ts";

export const BOUNDED_AGY_MODEL = "gemini-3.8-flash-high";
export const BOUNDED_AGY_OPUS_MODEL = "claude-opus-4-6-thinking";
export const AGY_OPUS_NATIVE_OUTPUT_CONTRACT = "agy-opus-fixed-native-output-v1";
export const BOUNDED_AGY_USER_AGENT = "OmniRoute-Antigravity/1.0";
export const BOUNDED_AGY_STREAM_URL = `${ANTIGRAVITY_RUNTIME_BASE_URLS[0]}/v1internal:streamGenerateContent?alt=sse`;
function reject(): never {
  throw new Error("decision_agy_contract_unsupported");
}
/** Internal request-local capability; no HTTP field or provider alias can enable it. */
export function boundedAgyContext(model: string, credentials: ProviderCredentials) {
  const attempt = currentApplicationAttempt();
  const opus = attempt?.executionContract === AGY_OPUS_NATIVE_OUTPUT_CONTRACT;
  if (!opus && attempt?.executionContract !== "agy-gemini-high-v1") return null;
  if (
    attempt.provider !== "agy" ||
    attempt.model !== (opus ? BOUNDED_AGY_OPUS_MODEL : BOUNDED_AGY_MODEL) ||
    model !== attempt.model ||
    attempt.effort !== "high" ||
    credentials.connectionId !== attempt.connectionId ||
    attempt.dispatch.singleAttempt !== true
  )
    reject();
  if (opus && (!attempt.nativeOutput || attempt.tools)) reject();
  attempt.signal.throwIfAborted();
  return attempt;
}
function projectId(credentials: ProviderCredentials): string {
  const project = credentials.projectId ?? credentials.providerSpecificData?.projectId;
  if (typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(project)) reject();
  if (project === "__REQUIRES_GCP_PROJECT__") reject();
  return project;
}
export function assertBoundedAgyCredentials(credentials: ProviderCredentials): void {
  const data = credentials.providerSpecificData ?? {};
  if (typeof data !== "object" || Array.isArray(data)) reject();
  if (
    typeof credentials.accessToken !== "string" ||
    !credentials.accessToken.trim() ||
    credentials.apiKey ||
    parseTokenExpiryMs(credentials.expiresAt) < Date.now() + 60_000 ||
    Object.keys(data).some((key) => key !== "projectId") ||
    (data.projectId !== undefined && data.projectId !== projectId(credentials)) ||
    isCliCompatEnabled("antigravity") ||
    isCliCompatEnabled("agy")
  )
    reject();
  projectId(credentials);
}
/** Must run before the ordinary executor's version, alias, bootstrap or credit work. */
export function assertBoundedAgyInput(input: ExecuteInput): void {
  if (
    !boundedAgyContext(input.model, input.credentials) ||
    input.validationDispatch?.singleAttempt !== true
  )
    reject();
  assertBoundedAgyCredentials(input.credentials);
  if (input.stream !== true) reject();
  if (input.upstreamExtraHeaders && Object.keys(input.upstreamExtraHeaders).length) reject();
  input.signal?.throwIfAborted();
}
export function requestsBoundedAgy(input: ExecuteInput): boolean {
  return (
    !!input.validationDispatch ||
    currentApplicationAttempt()?.executionContract === "agy-gemini-high-v1" ||
    currentApplicationAttempt()?.executionContract === AGY_OPUS_NATIVE_OUTPUT_CONTRACT
  );
}
export function boundedAgyHeaders(model: string, credentials: ProviderCredentials) {
  if (!boundedAgyContext(model, credentials)) reject();
  assertBoundedAgyCredentials(credentials);
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${credentials.accessToken}`,
    "User-Agent": BOUNDED_AGY_USER_AGENT,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}
function assertGeneration(request: Record<string, unknown>, opus: boolean): void {
  const generation = record(request.generationConfig);
  if (opus) {
    if (
      generation.topK !== 40 ||
      generation.topP !== 1 ||
      Object.keys(generation).some((key) => !["topK", "topP"].includes(key))
    )
      reject();
    return;
  }
  const thinking = record(generation.thinkingConfig);
  if (
    !Number.isSafeInteger(generation.maxOutputTokens) ||
    Number(generation.maxOutputTokens) < 1 ||
    Number(generation.maxOutputTokens) > 65536 ||
    thinking.thinkingLevel !== "high" ||
    Object.keys(thinking).some((key) => key !== "thinkingLevel")
  )
    reject();
}
/** Reuse the existing OpenAI→Cloud Code formatter output, without legacy client identity. */
export function boundedAgyProjection(
  model: string,
  body: unknown,
  credentials: ProviderCredentials
) {
  const attempt = boundedAgyContext(model, credentials);
  if (!attempt) reject();
  const opus = attempt.executionContract === AGY_OPUS_NATIVE_OUTPUT_CONTRACT;
  assertBoundedAgyCredentials(credentials);
  const envelope = record(body);
  if (envelope.model !== model || envelope.project !== projectId(credentials)) reject();
  if (
    Object.keys(envelope).some(
      (key) =>
        !(
          opus
            ? ["model", "project", "request"]
            : ["model", "project", "request", "userAgent", "requestType", "requestId"]
        ).includes(key)
    )
  )
    reject();
  const request = structuredClone(record(envelope.request));
  if (!opus) delete request.sessionId;
  const nativeTools = !!boundedAgyContext(model, credentials)?.tools?.geminiRequest;
  const allowed = ["contents", "systemInstruction", "generationConfig"];
  if (!opus) allowed.push("safetySettings");
  if (nativeTools) allowed.push("tools", "toolConfig");
  for (const key of Object.keys(request)) {
    if (request[key] === undefined) delete request[key];
    else if (!allowed.includes(key)) reject();
  }
  assertGeneration(request, opus);
  return { model, project: projectId(credentials), request };
}
