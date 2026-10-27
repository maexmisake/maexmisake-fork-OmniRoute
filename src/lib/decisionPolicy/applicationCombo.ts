import { ApplicationTools, applicationToolRequest } from "./applicationTools";
import { applicationResponsesResult } from "./applicationResponses";
import {
  prepareResponsesRouting,
  reserveApplicationResponse,
  createResponsesResultOptions,
  type ApplicationResponsesState,
} from "./applicationResponsesRouting";
import {
  assertResponseHistoryAllowed,
  releaseResponseHistory,
  type ResponseHistorySlot,
} from "../db/decisionResponses";
import {
  canonicalToolJSON,
  type InspectedToolRequest,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import { createApplicationStream } from "./applicationStream";
import { assertNativeConnectionUnleased } from "./exclusiveLease";
import { prepareNativeStage, type NativeStage } from "./applicationSelection";
import { createApplicationHealthReader } from "./applicationAvailability";
import { runApplicationAttempts, type RetryReservation } from "./applicationRetry";
import {
  parseApplicationSession,
  prepareApplicationSession,
  retainSessionPin,
  type SessionInput,
} from "./applicationSession";
import {
  attachRoutingSession,
  assertRoutingSession,
  completeRoutingSession,
  releaseRoutingSession,
  type SessionClaim,
} from "../db/decisionSessions";
import {
  completedExecutionRejection,
  type CompletedExecutionRejection,
} from "../../../open-sse/services/decisionPolicy/retryPolicy.ts";
import { getExecutor } from "../../../open-sse/executors/index.ts";
import { createValidationDispatchFence } from "../modelValidation/dispatchFence";
import { createValidationPluginFence } from "../modelValidation/pluginFence";
import { getSettings } from "../db/settings";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { boundedDecisionConfigurationSchema as configuration } from "../../shared/decisionPolicy/configuration.ts";
export { nativeSelectionSchema } from "../../shared/decisionPolicy/configuration.ts";
import {
  type Candidate,
  type CandidateState,
  type Trace,
} from "../../../open-sse/services/decisionPolicy/contract.ts";
import {
  eligibleCandidates,
  exclusionReasons,
} from "../../../open-sse/services/decisionPolicy/eligibility.ts";
import {
  extractRequestFacts,
  normalizeDecisionTextWire,
  type ChatPolicyBody,
} from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import {
  currentApplicationAttempt,
  isAgyApplicationContract,
  withApplicationAttempt,
  type ApplicationAttempt,
  type ApplicationToolHooks,
} from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import { errorResponse } from "../../../open-sse/utils/error.ts";
import { getComboByName } from "../db/combos";
import { getProviderConnectionById } from "../db/providers";
import { getApiKeyById, isModelAllowedForKey } from "../db/apiKeys";
import {
  decisionAuthorityStamp as authorityStamp,
  assertUncappedDecision,
  reserveDecisionAttempt,
  startDecisionAttempt,
  settleDecisionAttempt,
  finishDecisionApplication,
  releaseDecisionAttempt,
  assertDecisionLease,
  type AttemptIdentity,
  readDecisionAttemptReceipt,
  readLogicalDecisionCost,
  handoverExecutionRetry,
} from "../db/decisionAttempts";
import { boundedDecisionEnabled } from "../../../open-sse/services/decisionPolicy/applicationGate.ts";
import {
  assertApplicationEgress as assertEgress,
  resolveApplicationProvider,
  assertReadyClaudeOAuth,
  isBoundedClaudePair,
  isApplicationEffortSupported,
  claudeWireFacts,
  claudeReportedUsage,
  type ApplicationProvider,
} from "./applicationProvider";
import {
  applicationAgyWireFacts,
  supportsApplicationAgyRequest,
  isApplicationAgyPair,
} from "./applicationGemini";
import { supportsGeminiToolRequest } from "./geminiToolWire";
import { assertBoundedAgyCredentials } from "../../../open-sse/executors/antigravity/bounded.ts";
import {
  assertNativeDecisionCodexCredentials,
  nativeDecisionCodexWireFacts,
  supportsNativeCodexToolRequest,
} from "../../../open-sse/executors/codex/nativeDecision.ts";
import type { ProviderNativeOutput } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import {
  projectSystemOneFailure,
  systemOneSensitiveValues,
  systemOneRetryAfter,
} from "../../../open-sse/handlers/systemOneDiagnostics.ts";

function rejectedAttempt(
  attempt: ApplicationAttempt | undefined,
  error: unknown,
  status = 409
): Response {
  if (attempt) {
    try {
      finishDecisionApplication(attempt.id, status);
    } catch {
      /* The durable pending attempt remains authoritative. */
    }
  }
  const response =
    status !== 409
      ? errorResponse(
          status,
          status === 504 ? "Automatic routing deadline exceeded" : "Automatic routing cancelled",
          { code: "decision_application_rejected" }
        )
      : automaticRejection(
          error instanceof Error && /^decision_[a-z_]+$/.test(error.message)
            ? error.message
            : "pipeline_rejected"
        );
  if (attempt) response.headers.set("x-omniroute-decision-attempt", attempt.id);
  return response;
}
export type AutomaticPlan = {
  sourcePolicy: string;
  toolRequest?: InspectedToolRequest;
  comboId: string;
  name: string;
  config: z.infer<typeof configuration>;
  clientTaskContextConsent?: boolean;
  sessionInput?: SessionInput;
  responsesBody?: Record<string, unknown>;
  responses?: ApplicationResponsesState;
};
function nativeOutputPlan(plan: AutomaticPlan): ProviderNativeOutput | undefined {
  return plan.config.applicationMode === "provider-native-output-v1"
    ? plan.config.nativeOutput
    : undefined;
}
export function automaticRejection(reason = "unsupported"): Response {
  const response = errorResponse(409, "Bounded automatic combo cannot authorize this request", {
    code: "decision_application_rejected",
  });
  response.headers.set(
    "x-omniroute-decision-reason",
    /^[a-z_]{1,80}$/.test(reason) ? reason : "unsupported"
  );
  return response;
}
export async function prepareAutomaticCombo(
  model: string,
  body: unknown,
  keyId?: string,
  clientInput: unknown = body,
  clientTaskContextConsent = false,
  headers = new Headers(),
  sourceFormat?: string
): Promise<AutomaticPlan | Response | null> {
  const combo = await getComboByName(model);
  if (!combo || !boundedDecisionEnabled(combo)) return null;
  const parsed = configuration.safeParse(
    (combo.config as Record<string, unknown> | undefined)?.decisionPolicy
  );
  const settings = await getSettings();
  if (
    settings.memoryEnabled ||
    settings.semanticCacheEnabled ||
    settings.compressionEnabled ||
    settings.autoWebSearchEnabled ||
    settings.webSearchEnabled
  )
    return automaticRejection("settings_unsupported");
  createValidationPluginFence().assertIdle();
  if (!parsed.success) return automaticRejection("invalid_configuration");
  if (!keyId) return automaticRejection("authentication_required");
  let sessionInput: SessionInput | undefined;
  try {
    sessionInput = parseApplicationSession(headers, !!parsed.data.sessions);
  } catch {
    return automaticRejection("session_rejected");
  }
  if (sessionInput && settings.echoRequestedModelName === true)
    return automaticRejection("session_model_echo_unsupported");
  let responsesBody: Record<string, unknown> | undefined;
  let responses: AutomaticPlan["responses"];
  if (sourceFormat === "openai-responses") {
    try {
      const prepared = prepareResponsesRouting({
        client: clientInput,
        working: body,
        keyId,
        comboId: String(combo.id),
        policy: JSON.stringify((combo.config as Record<string, unknown>).decisionPolicy),
        config: parsed.data,
        sessionInput,
        echo: settings.echoRequestedModelName === true,
      });
      responsesBody = prepared.body;
      responses = prepared.state;
      sessionInput = prepared.sessionInput;
      body = responsesBody;
      clientInput = responsesBody;
    } catch {
      return automaticRejection("responses_request_unsupported");
    }
  }
  const admission = preparedApplicationInput(
    clientInput,
    body,
    settings.echoRequestedModelName === true,
    parsed.data.nativeOutput
  );
  if (admission.reason) return automaticRejection(admission.reason);
  const toolRequest = admission.toolRequest;
  // Only explicit exact names in this initial lane; aliases/nesting never fall into legacy execution.
  return {
    comboId: String(combo.id),
    toolRequest,
    name: model,
    config: parsed.data,
    sourcePolicy: JSON.stringify((combo.config as Record<string, unknown>).decisionPolicy),
    clientTaskContextConsent,
    sessionInput,
    responsesBody,
    responses,
  };
}
function prepareToolInput(
  clientInput: unknown,
  body: unknown,
  nativeOutput?: ProviderNativeOutput
): InspectedToolRequest | undefined | null {
  const client = applicationToolRequest(clientInput, nativeOutput),
    working = applicationToolRequest(body, nativeOutput);
  if (!client || !working) return null;
  const usesTools =
    !!client.body.tools?.length ||
    client.body.messages.some((row) => row.role === "tool" || row.tool_calls?.length);
  if (!usesTools) return undefined;
  if (
    canonicalToolJSON({ ...client.body, stream: client.body.stream === true }) !==
    canonicalToolJSON({ ...working.body, stream: working.body.stream === true })
  )
    return null;
  return client;
}
function preparedApplicationInput(
  client: unknown,
  body: unknown,
  echo: boolean,
  nativeOutput?: ProviderNativeOutput
): { toolRequest?: InspectedToolRequest; reason?: string } {
  const toolRequest = prepareToolInput(client, body, nativeOutput);
  if (toolRequest === null) return { reason: "request_facts_unsupported" };
  if (toolRequest) return echo ? { reason: "tool_model_echo_unsupported" } : { toolRequest };
  return validRequestFacts(client, undefined, nativeOutput) &&
    validRequestFacts(body, undefined, nativeOutput)
    ? {}
    : { reason: "request_facts_unsupported" };
}
function validRequestFacts(
  raw: unknown,
  tools?: ApplicationTools,
  nativeOutput?: ProviderNativeOutput,
  disclosure?: { decisionContext?: unknown; clientTaskContextConsent?: boolean }
) {
  const facts = extractRequestFacts(raw, {
    measureContext: (body) =>
      Buffer.byteLength(JSON.stringify(body), "utf8") + body.messages.length * 256,
    continuationCandidateId: tools?.continuation?.binding.candidateId,
    nativeOutput,
    ...disclosure,
  });
  if (!facts.ok || facts.facts.images) return null;
  if (
    !tools &&
    (facts.facts.tools ||
      facts.body.messages.some((row) => row.role === "tool" || row.tool_calls?.length))
  )
    return null;
  return facts;
}

function matchesOpenAiWireContract(
  wire: Record<string, unknown> | null,
  candidate: Candidate,
  outputLimit: number,
  streaming: boolean,
  streamOptions: unknown
): boolean {
  if (!wire) return false;
  // Preserve every actual effort/output carrier for the same strict alias check.
  // Only this already-allowlisted provider-generated cache field is outside it.
  const { prompt_cache_key: _cache, ...body } = wire;
  const normalized = normalizeDecisionTextWire(body);
  return (
    normalized !== null &&
    normalized.reasoning_effort === candidate.effort.value &&
    normalized.max_completion_tokens === outputLimit &&
    normalized.stream === streaming &&
    JSON.stringify(normalized.stream_options) === JSON.stringify(streamOptions)
  );
}

function numberOrNull(value: unknown, integer = false): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!integer || Number.isSafeInteger(value))
    ? value
    : null;
}
function projectExecutionFailure(
  response: Response,
  data: Record<string, unknown> | null,
  text: string,
  sensitiveValues: readonly string[]
): Response {
  const diagnostic = projectSystemOneFailure({
    status: response.status,
    body: data,
    bodyText: text,
    authenticated: true,
    sensitiveValues,
  });
  const safe = errorResponse(response.status, diagnostic.message, {
    code: "decision_execution_upstream_error",
  });
  const retryAfter = systemOneRetryAfter(response.headers.get("retry-after"));
  if (retryAfter) safe.headers.set("retry-after", retryAfter);
  void response.body?.cancel().catch(() => {});
  return safe;
}
async function observeResponse(
  identity: AttemptIdentity,
  signal: AbortSignal,
  send: Promise<Response>,
  sensitiveValues: readonly string[],
  reject: (failure: CompletedExecutionRejection | null) => void
): Promise<Response> {
  let response: Response;
  try {
    response = await send;
  } catch (error) {
    try {
      settleDecisionAttempt(identity, { status: null, input: null, output: null, cost: null });
    } catch {
      throw new Error("decision_settlement_pending");
    }
    throw error;
  }
  // Read a bounded clone before the existing core consumes/translates the original response.
  const reader = response.clone().body?.getReader();
  const abort = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0,
    text = "",
    data: Record<string, unknown> | null = null,
    complete = !reader;
  try {
    const decoder = new TextDecoder();
    while (reader) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 262144) throw new Error("decision_response_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = null;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader?.cancel().catch(() => {});
  }
  complete = complete && nativeResponseIsJson(identity.provider, response);
  try {
    settleDecisionAttempt(identity, {
      status: complete && !signal.aborted ? response.status : null,
      ...reportedApplicationUsage(identity.provider, data),
    });
  } catch {
    throw new Error("decision_settlement_pending");
  }
  if (!complete || signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw new Error("decision_response_incomplete");
  }
  signal.throwIfAborted();
  assertNativeResponse(identity, response, data);
  if (!response.ok) {
    reject(
      completedExecutionRejection(
        response.status,
        data,
        response.headers.get("retry-after"),
        Date.now(),
        identity.provider
      )
    );
    return projectExecutionFailure(response, data, text, sensitiveValues);
  }
  return response;
}
function nativeResponseIsJson(provider: string, response: Response): boolean {
  return (
    provider !== "claude" || !response.headers.get("content-type")?.includes("text/event-stream")
  );
}
function assertNativeResponse(
  identity: AttemptIdentity,
  response: Response,
  data: Record<string, unknown> | null
): void {
  if (identity.provider !== "claude" || !response.ok) return;
  if (data?.type !== "message" || data.model !== identity.model || !Array.isArray(data.content))
    throw new Error("decision_response_invalid");
  if (
    ![
      "end_turn",
      "max_tokens",
      "stop_sequence",
      "refusal",
      "model_context_window_exceeded",
    ].includes(String(data.stop_reason))
  )
    throw new Error("decision_response_unsupported");
  if (
    !data.content.every(
      (block) => block && ["text", "thinking", "redacted_thinking"].includes(block.type)
    )
  )
    throw new Error("decision_response_unsupported");
}
function reportedApplicationUsage(provider: string, data: Record<string, unknown> | null) {
  // Native subscription error JSON has no documented chat-style usage/cost receipt.
  // A successful native SSE receipt is parsed separately from raw provider frames.
  if (["codex", "agy"].includes(provider))
    return {
      input: null,
      output: null,
      cost: null,
      reasoning: null,
      cacheRead: null,
      cacheCreation: null,
    };
  const usage =
    data?.usage && typeof data.usage === "object" ? (data.usage as Record<string, unknown>) : {};
  const cost = numberOrNull(usage.cost);
  if (provider === "claude") return { ...claudeReportedUsage(usage), cost };
  const completion = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const prompt = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    input: numberOrNull(usage.prompt_tokens, true),
    output: numberOrNull(usage.completion_tokens, true),
    cost,
    reasoning: numberOrNull(completion?.reasoning_tokens, true),
    cacheRead: numberOrNull(prompt?.cached_tokens, true),
    cacheCreation: numberOrNull(prompt?.cache_creation_tokens, true),
  };
}
function reserveApplicationAttempt(
  identity: AttemptIdentity,
  native?: NativeStage,
  tools?: ApplicationTools,
  retry?: RetryReservation
): void {
  if (retry) handoverExecutionRetry(retry.previous, identity, retry.maxAttempts, retry.failure);
  else if (tools?.continuation) tools.claim(identity);
  else if (native) native.handover(identity);
  else reserveDecisionAttempt(identity);
}
function attachTools(
  tools: ApplicationTools | undefined,
  identity: AttemptIdentity,
  stamp: string
) {
  return tools?.attach(identity, stamp);
}
function assertToolsFresh(tools: ApplicationTools | undefined, identity: AttemptIdentity): void {
  tools?.assertFresh(identity);
}
function finalToolFacts(wire: Record<string, unknown>, tools?: ApplicationTools) {
  if (!tools) return wire.tools ? { tools: wire.tools } : {};
  const body = tools.request.body;
  return {
    tools: body.tools,
    ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
    ...(body.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: body.parallel_tool_calls }),
  };
}
type FinalWireOptions = {
  contract: ApplicationProvider;
  candidate: Candidate;
  outputLimit: number;
  streaming: boolean;
  streamOptions: unknown;
  originalBody: ChatPolicyBody;
  toolHooks?: ApplicationToolHooks;
};
function finalApplicationWire(
  wire: Record<string, unknown>,
  headers: Headers,
  options: FinalWireOptions
) {
  const { contract, candidate, outputLimit, streaming, streamOptions, originalBody, toolHooks } =
    options;
  if (contract.executionContract === "codex-native-output-v1") {
    nativeDecisionCodexWireFacts(
      wire,
      headers,
      contract.credentials,
      originalBody,
      candidate.effort.value!
    );
    return {
      messages: originalBody.messages,
      output: outputLimit,
      messageCount: originalBody.messages.length,
    };
  }
  if (isAgyApplicationContract(contract.executionContract)) {
    const messages = applicationAgyWireFacts(
      wire,
      headers,
      contract.credentials,
      originalBody,
      outputLimit,
      toolHooks?.beforeFetch,
      contract.executionContract
    );
    return { messages, output: outputLimit, messageCount: messages.length };
  }
  if (wire.stream !== streaming) throw new Error("decision_identity_changed");
  if (!contract.claude && !validOpenAiWire(wire, candidate, outputLimit, streaming, streamOptions))
    throw new Error("decision_identity_changed");
  const messages = contract.claude
    ? claudeWireFacts(wire, candidate.effort.value!, outputLimit, streaming, toolHooks?.beforeFetch)
    : wire.messages;
  if (!Array.isArray(messages) || !Array.isArray(wire.messages))
    throw new Error("decision_final_request_unsupported");
  return {
    messages,
    output: wire.max_completion_tokens ?? wire.max_tokens,
    messageCount: wire.messages.length,
  };
}
function validOpenAiWire(
  wire: Record<string, unknown>,
  candidate: Candidate,
  outputLimit: number,
  streaming: boolean,
  streamOptions: unknown
): boolean {
  return (
    matchesOpenAiWireContract(wire, candidate, outputLimit, streaming, streamOptions) &&
    Object.keys(wire).every((key) =>
      [
        "model",
        "messages",
        "stream",
        "stream_options",
        "reasoning_effort",
        "reasoning",
        "max_tokens",
        "max_completion_tokens",
        "prompt_cache_key",
      ].includes(key)
    )
  );
}
function physicalApplicationProvider(provider: string, contract: ApplicationProvider): string {
  return isAgyApplicationContract(contract.executionContract) ? "antigravity" : provider;
}
function assertApplicationEgress(provider: string, contract: ApplicationProvider, url: string) {
  assertEgress(provider, url);
  if (contract.executionContract)
    assertEgress(physicalApplicationProvider(provider, contract), url);
}
async function buildAttempt(
  plan: AutomaticPlan,
  candidate: Candidate,
  keyId: string,
  signal: AbortSignal,
  outputLimit: number,
  trace: Array<{ phase: string; id?: string; reason: string }>,
  originalBody: ChatPolicyBody,
  native?: NativeStage,
  streaming = false,
  streamOptions?: unknown,
  toolsSession?: ApplicationTools,
  retry?: RetryReservation
): Promise<ApplicationAttempt & AttemptIdentity> {
  const connectionId = plan.config.connections[candidate.id];
  assertNativeConnectionUnleased(connectionId);
  // Capture authority before any asynchronous credential/executor preparation.
  // Another worker may rotate the shared row without invalidating this worker's auth cache.
  const preparationStamp = authorityStamp(
    {
      id: "",
      keyId,
      comboId: plan.comboId,
      candidateId: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      connectionId,
      effort: candidate.effort.value ?? "",
    },
    plan.sourcePolicy
  );
  const connection = await getProviderConnectionById(connectionId);
  if (
    !connection ||
    connection.provider !== candidate.provider ||
    connection.isActive !== true ||
    !candidate.effort.value ||
    !isApplicationEffortSupported(candidate, !!nativeOutputPlan(plan))
  )
    throw new Error("decision_binding_unsupported");
  const key = await getApiKeyById(keyId);
  if (
    !key ||
    (Array.isArray(key.allowedConnections) &&
      key.allowedConnections.length &&
      !key.allowedConnections.includes(connectionId))
  )
    throw new Error("decision_connection_unauthorized");
  const contract = resolveApplicationProvider(candidate, connection, !!nativeOutputPlan(plan));
  const physicalProvider = physicalApplicationProvider(candidate.provider, contract);
  const executor = await getExecutor(candidate.provider);
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId,
    comboId: plan.comboId,
    requestedModel: plan.name,
    candidateId: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    connectionId,
    effort: candidate.effort.value,
    ...(nativeOutputPlan(plan) ? { outputPolicy: "provider-native" as const } : {}),
    trace,
    ...(retry
      ? {
          lane: "execution" as const,
          requestId: retry.previous.requestId ?? retry.previous.id,
          parentAttemptId: retry.previous.id,
        }
      : native
        ? {
            lane: "execution" as const,
            requestId: native.identity.id,
            parentAttemptId: native.identity.id,
          }
        : {}),
  };
  assertUncappedDecision(
    keyId,
    candidate.provider,
    candidate.model,
    retry?.previous.id ?? native?.identity.id,
    plan.name
  );
  const stamp = authorityStamp(identity, plan.sourcePolicy);
  if (stamp !== preparationStamp) throw new Error("decision_authority_changed");
  const endpoint = new URL(contract.endpoint);
  assertApplicationEgress(candidate.provider, contract, endpoint.href);
  const plugins = createValidationPluginFence();
  const sensitiveValues = systemOneSensitiveValues([contract.credentials, originalBody.messages]);
  let reserved = false;
  const assertFresh = () => {
    try {
      signal.throwIfAborted();
      assertNativeConnectionUnleased(connectionId);
      if (reserved) assertDecisionLease(identity);
      native?.assertFresh();
      assertToolsFresh(toolsSession, identity);
      plugins.assertIdle();
      assertUncappedDecision(
        keyId,
        candidate.provider,
        candidate.model,
        retry?.previous.id ?? native?.identity.id,
        plan.name
      );
      if (authorityStamp(identity, plan.sourcePolicy) !== stamp)
        throw new Error("decision_authority_changed");
      if (contract.claude || contract.executionContract) {
        if (contract.claude) assertReadyClaudeOAuth(contract.credentials);
        else if (contract.executionContract === "codex-native-output-v1")
          assertNativeDecisionCodexCredentials(contract.credentials);
        else assertBoundedAgyCredentials(contract.credentials);
        if (executor.needsRefresh(contract.credentials))
          throw new Error("decision_oauth_unsupported");
      }
    } catch {
      throw new Error("decision_authority_changed");
    }
  };
  const fence = createValidationDispatchFence({
    provider: candidate.provider,
    modelId: candidate.model,
    connectionId,
    signal,
    assertFresh,
    expectedExecutor: executor,
    expectedCredentials: contract.credentials,
    allowNativeClaude: contract.claude,
    allowNativeAgyGemini: contract.executionContract === "agy-gemini-high-v1",
    allowNativeAgyOpus: contract.executionContract === "agy-opus-fixed-native-output-v1",
    allowNativeCodex: contract.executionContract === "codex-native-output-v1",
  });
  reserveApplicationAttempt(identity, native, toolsSession, retry);
  reserved = true;
  const toolHooks = attachTools(toolsSession, identity, stamp);
  const stream = streaming
    ? createApplicationStream(
        identity,
        signal,
        streamOptions as { include_usage?: boolean } | undefined,
        toolHooks
      )
    : undefined;
  let rejection: CompletedExecutionRejection | null = null;
  const recordRejection = (value: CompletedExecutionRejection | null) => {
    rejection = value;
  };
  return {
    rejection: () => rejection,
    canonicalChat: !!plan.responsesBody,
    stream,
    tools: toolHooks,
    ...(contract.executionContract ? { executionContract: contract.executionContract } : {}),
    ...(nativeOutputPlan(plan) ? { nativeOutput: nativeOutputPlan(plan) } : {}),
    ...identity,
    signal,
    release: () => releaseDecisionAttempt(identity),
    assertIdle: plugins.assertIdle,
    assertFresh,
    fence: (executor) => fence.wrap(executor as Awaited<ReturnType<typeof getExecutor>>),
    dispatch: {
      singleAttempt: true,
      reject() {
        throw new Error("decision_dispatch_rejected");
      },
      beforeFetch(details) {
        assertFresh();
        assertApplicationEgress(candidate.provider, contract, details.url);
        const wire = typeof details.body === "string" ? JSON.parse(details.body) : null;
        const headers = new Headers(details.headers);
        if (
          authorityStamp(identity, plan.sourcePolicy) !== stamp ||
          details.provider !== physicalProvider ||
          details.model !== candidate.model ||
          details.credentials.connectionId !== connectionId ||
          (["apiKey", "accessToken", "refreshToken"] as const).some(
            (field) =>
              (details.credentials[field] ?? null) !== (contract.credentials[field] ?? null)
          ) ||
          headers.get("authorization") !==
            `Bearer ${contract.credentials.apiKey || contract.credentials.accessToken}` ||
          headers.has("x-api-key") ||
          headers.has("api-key") ||
          details.url !== endpoint.href ||
          wire?.model !== candidate.model
        )
          throw new Error("decision_identity_changed");
        const validated = finalApplicationWire(wire, headers, {
          contract,
          candidate,
          outputLimit,
          streaming,
          streamOptions,
          originalBody,
          toolHooks,
        });
        const finalFacts = validRequestFacts(
          {
            model: plan.name,
            messages: validated.messages,
            stream: false,
            max_completion_tokens: validated.output,
            ...finalToolFacts(wire, toolsSession),
            reasoning_effort: candidate.effort.value,
          },
          toolsSession
        );
        if (
          !finalFacts ||
          validated.output !== outputLimit ||
          candidate.capabilities.contextTokens === null ||
          Buffer.byteLength(JSON.stringify(wire), "utf8") +
            validated.messageCount * 256 +
            outputLimit >
            candidate.capabilities.contextTokens
        )
          throw new Error("decision_final_request_unsupported");
        try {
          startDecisionAttempt(identity);
        } catch {
          throw new Error("decision_start_failed");
        }
      },
    },
    observe: async (send) => {
      if (!stream) return observeResponse(identity, signal, send, sensitiveValues, recordRejection);
      const response = await send;
      return response.ok
        ? stream.observe(response)
        : observeResponse(
            identity,
            signal,
            Promise.resolve(response),
            sensitiveValues,
            recordRejection
          );
    },
  };
}
async function reportedClaudeClientUsage(
  response: Response,
  attempt: ApplicationAttempt
): Promise<Response> {
  const receipt = readDecisionAttemptReceipt(attempt.id);
  if (response.status >= 400 && receipt.state === "reserved") {
    void response.body?.cancel().catch(() => {});
    return automaticRejection("pipeline_rejected");
  }
  if (attempt.stream?.active || attempt.provider !== "claude" || !response.ok) return response;
  const body = await response.json();
  const input = receipt.input_tokens as number | null,
    output = receipt.output_tokens as number | null;
  body.usage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input === null || output === null ? null : input + output,
    prompt_tokens_details: {
      cached_tokens: receipt.cache_read_tokens,
      cache_creation_tokens: receipt.cache_creation_tokens,
    },
    completion_tokens_details: { reasoning_tokens: receipt.reasoning_tokens },
    cost: receipt.cost_usd,
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}
async function candidateSnapshot(plan: AutomaticPlan, keyId: string) {
  const snapshot: Record<string, CandidateState | undefined> = {};
  const key = await getApiKeyById(keyId);
  const health = await createApplicationHealthReader(plan.config.policy.candidates);
  for (const candidate of plan.config.policy.candidates) {
    const connectionId = plan.config.connections[candidate.id];
    const allowed =
      !!key &&
      (!key.allowedConnections?.length || key.allowedConnections.includes(connectionId)) &&
      (await isModelAllowedForKey(String(key.key), `${candidate.provider}/${candidate.model}`));
    const conn = await getProviderConnectionById(plan.config.connections[candidate.id]);
    snapshot[candidate.id] = {
      authorized: allowed,
      ...health(candidate, conn),
    };
  }
  return snapshot;
}
function failureStatus(signal: AbortSignal, caller: AbortSignal, native?: NativeStage): number {
  if (caller.aborted) return 499;
  if (signal.aborted || native?.timedOut()) return 504;
  return 409;
}
function releaseAttempt(attempt: ApplicationAttempt | undefined): void {
  try {
    attempt?.release?.();
  } catch {
    // Cleanup failure cannot reopen routing. Durable pending usage expires to unknown.
  }
}
type ApplicationSelectionMode =
  "no-route" | "native" | "sole-eligible" | "deterministic" | "continuation-pin" | "session-pin";
function applicationSelectionMode(
  plan: AutomaticPlan,
  eligibleCount: number
): ApplicationSelectionMode {
  if (plan.config.selection?.mode !== "native") return "deterministic";
  return eligibleCount === 1 ? "sole-eligible" : "native";
}
function traceNoDecisionSelection(
  trace: Array<{ phase: string; id?: string; reason: string }>,
  candidate: Candidate,
  mode: ApplicationSelectionMode
): void {
  trace.push({
    phase: "selection",
    id: candidate.id,
    reason: mode === "sole-eligible" ? "sole_eligible_no_decision" : "deterministic_no_decision",
  });
}
function annotateNoDecision(
  response: Response,
  mode: ApplicationSelectionMode,
  attempt?: ApplicationAttempt
): Response {
  response.headers.set("x-omniroute-selection-mode", mode);
  response.headers.set("x-omniroute-decision-status", "no-decision");
  if (attempt) {
    try {
      const cost = readLogicalDecisionCost(attempt.requestId ?? attempt.id);
      response.headers.set("x-omniroute-routing-cost", JSON.stringify(cost));
      response.headers.set(
        "x-omniroute-routing-cost-status",
        cost.totalUsd === null ? "unknown" : "known"
      );
    } catch {
      // A failed annotation read cannot replay completed work or manufacture zero.
      response.headers.delete("x-omniroute-routing-cost");
      response.headers.set("x-omniroute-routing-cost-status", "unknown");
    }
  }
  return response;
}
function selectedRequest(body: Record<string, unknown>, candidate: Candidate) {
  // The mutable provider pipeline must not share the final fence's expected transcript.
  return {
    ...structuredClone(body),
    stream: body.stream === true,
    reasoning_effort: candidate.effort.value,
  };
}
function completedResponse(
  response: Response,
  attempt: ApplicationAttempt,
  candidate: Candidate,
  mode: ApplicationSelectionMode,
  native?: NativeStage
): Response {
  if (!attempt.stream?.active) finishDecisionApplication(attempt.id, response.status);
  const result = new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
  result.headers.set("x-omniroute-decision-attempt", attempt.id);
  result.headers.set("x-omniroute-decision-candidate", candidate.id);
  return native ? native.annotate(result) : annotateNoDecision(result, mode, attempt);
}
type SelectionState = { mode: ApplicationSelectionMode; native?: NativeStage };
function supportedToolCandidate(
  candidate: Candidate,
  body: ChatPolicyBody,
  nativeOutput = false
): boolean {
  if (candidate.provider === "codex") return nativeOutput && supportsNativeCodexToolRequest(body);
  if (candidate.provider === "claude")
    return isBoundedClaudePair(candidate.model, candidate.effort.value ?? "");
  return isApplicationAgyPair(candidate, nativeOutput) && supportsGeminiToolRequest(body);
}
async function assertExecutionContract(
  plan: AutomaticPlan,
  candidate: Candidate,
  requiresTools: boolean,
  body: ChatPolicyBody
) {
  if (!isApplicationEffortSupported(candidate, !!nativeOutputPlan(plan)))
    throw new Error("unsupported");
  if (requiresTools && !supportedToolCandidate(candidate, body, !!nativeOutputPlan(plan)))
    throw new Error("unsupported");
  const row = await getProviderConnectionById(plan.config.connections[candidate.id]);
  if (!row || row.provider !== candidate.provider || row.isActive !== true)
    throw new Error("unsupported");
  const contract = resolveApplicationProvider(candidate, row, !!nativeOutputPlan(plan));
  const supportedAgy = requiresTools
    ? supportsGeminiToolRequest(body)
    : supportsApplicationAgyRequest(body);
  if (isAgyApplicationContract(contract.executionContract) && !supportedAgy)
    throw new Error("unsupported");
}
async function supportedExecutionCandidates(
  plan: AutomaticPlan,
  candidates: Candidate[],
  trace: Array<{ phase: string; id?: string; reason: string }>,
  requiresTools: boolean,
  body: ChatPolicyBody
) {
  const allowed: Candidate[] = [];
  for (const candidate of candidates) {
    // Reject recursion before an unsupported contract can hide it and turn a
    // native selection into a sole-eligible execution. Hard exclusions ran first.
    if (
      (await getComboByName(candidate.model)) ||
      (await getComboByName(`${candidate.provider}/${candidate.model}`))
    )
      throw new Error("decision_recursion_rejected");
    try {
      await assertExecutionContract(plan, candidate, requiresTools, body);
      allowed.push(candidate);
    } catch {
      trace.push({
        phase: "eligibility",
        id: candidate.id,
        reason: requiresTools ? "tool_execution_unproven" : "execution_contract_unproven",
      });
    }
  }
  return allowed;
}
function nativeSelectionFacts(
  plan: AutomaticPlan,
  rawBody: Record<string, unknown>,
  tools: ApplicationTools | undefined,
  trace: Trace[]
) {
  const selection = plan.config.selection;
  const shared = validRequestFacts(rawBody, tools, nativeOutputPlan(plan), {
    decisionContext: selection?.mode === "native" ? selection.decisionContext : undefined,
    clientTaskContextConsent: plan.clientTaskContextConsent,
  });
  if (!shared) throw new Error("decision_task_context_rejected");
  if (selection?.mode === "native" && selection.decisionContext?.mode === "task-text")
    trace.push({
      phase: "decision_context",
      reason: plan.clientTaskContextConsent ? "task_context_shared" : "task_context_local_summary",
    });
  return shared.facts;
}
async function selectApplicationCandidate(
  plan: AutomaticPlan,
  keyId: string,
  signal: AbortSignal,
  tools: ApplicationTools | undefined,
  facts: NonNullable<ReturnType<typeof validRequestFacts>>,
  state: SelectionState,
  trace: Array<{ phase: string; id?: string; reason: string }>,
  rawBody: Record<string, unknown>,
  session?: SessionClaim
): Promise<Candidate> {
  const snapshot = await candidateSnapshot(plan, keyId);
  const sessionBinding = session?.binding;
  if (sessionBinding && (retainSessionPin(plan, session) || tools?.continuation)) {
    if (tools?.continuation && plan.sessionInput?.boundary)
      throw new Error("decision_session_rejected");
    const pinned = plan.config.policy.candidates.find(
      (candidate) =>
        candidate.id === sessionBinding.candidateId &&
        candidate.provider === sessionBinding.provider &&
        candidate.model === sessionBinding.model &&
        candidate.effort.value === sessionBinding.effort &&
        plan.config.connections[candidate.id] === sessionBinding.connectionId &&
        !exclusionReasons(candidate, facts.facts, plan.config.policy, snapshot).length
    );
    if (
      !pinned ||
      !(await supportedExecutionCandidates(plan, [pinned], trace, !!tools, facts.body)).length
    )
      throw new Error("decision_session_rejected");
    state.mode = "session-pin";
    trace.push({ phase: "selection", id: pinned.id, reason: "session_pin" });
    return pinned;
  }
  if (tools?.continuation) {
    const binding = tools.continuation.binding;
    const pinned = eligibleCandidates(plan.config.policy, facts.facts, snapshot, trace).find(
      (candidate) =>
        candidate.id === binding.candidateId &&
        candidate.provider === binding.provider &&
        candidate.model === binding.model &&
        candidate.effort.value === binding.effort &&
        plan.config.connections[candidate.id] === binding.connectionId
    );
    if (!pinned) throw new Error("decision_no_route");
    if (!(await supportedExecutionCandidates(plan, [pinned], trace, true, facts.body)).length)
      throw new Error("decision_no_route");
    state.mode = "continuation-pin";
    trace.push({ phase: "selection", id: pinned.id, reason: "continuation_pin" });
    return pinned;
  }
  let eligible = eligibleCandidates(plan.config.policy, facts.facts, snapshot, trace);
  eligible = await supportedExecutionCandidates(
    plan,
    eligible,
    trace,
    tools !== undefined,
    facts.body
  );
  if (!eligible[0]) throw new Error("decision_no_route");
  state.mode = applicationSelectionMode(plan, eligible.length);
  if (state.mode === "native") {
    const shared = nativeSelectionFacts(plan, rawBody, tools, trace);
    state.native = await prepareNativeStage(plan, eligible, keyId, signal);
    return state.native.select(shared);
  }
  traceNoDecisionSelection(trace, eligible[0], state.mode);
  return eligible[0];
}
function prepareTools(plan: AutomaticPlan, keyId: string) {
  return plan.toolRequest ? new ApplicationTools(plan, keyId, plan.toolRequest) : undefined;
}
function prepareSessionCompletion(
  plan: AutomaticPlan,
  session: SessionClaim | undefined,
  attempt: ApplicationAttempt & AttemptIdentity,
  response: Response
): void {
  if (!session || !response.ok) return;
  if (attempt.stream?.active) {
    attempt.stream.onClientCompletion(
      (commitTools) => completeRoutingSession(session, attempt, plan.config.sessions!, commitTools),
      () => releaseRoutingSession(session)
    );
  } else completeRoutingSession(session, attempt, plan.config.sessions!);
}
function annotateApplicationResult(
  plan: AutomaticPlan,
  result: Awaited<ReturnType<typeof runApplicationAttempts>>,
  state: SelectionState,
  session?: SessionClaim
): Response {
  const annotated = completedResponse(
    result.response,
    result.attempt,
    result.candidate,
    state.mode,
    state.native
  );
  if (result.attempts > 1)
    annotated.headers.set("x-omniroute-execution-attempts", String(result.attempts));
  if (session) {
    annotated.headers.set("x-omniroute-routing-session", session.id);
    const exposed = annotated.headers.get("Access-Control-Expose-Headers");
    annotated.headers.set(
      "Access-Control-Expose-Headers",
      [exposed, "x-omniroute-routing-session"].filter(Boolean).join(", ")
    );
  }
  if (nativeOutputPlan(plan)) {
    annotated.headers.set("x-omniroute-output-policy", "provider-native");
    const contract = result.attempt.executionContract;
    annotated.headers.set(
      "x-omniroute-output-limit-enforced",
      contract === "codex-native-output-v1" || contract === "agy-opus-fixed-native-output-v1"
        ? "false"
        : "true"
    );
  }
  return annotated;
}
async function completeApplicationResponse(
  plan: AutomaticPlan,
  result: Awaited<ReturnType<typeof runApplicationAttempts>>,
  state: SelectionState,
  signal: AbortSignal,
  callerSignal: AbortSignal,
  session?: SessionClaim,
  responseSlot?: ResponseHistorySlot
): Promise<{ response: Response; streaming: boolean }> {
  const attempt = result.attempt;
  const responsesOptions = createResponsesResultOptions({
    state: plan.responses,
    attempt,
    signal,
    session,
    slot: responseSlot,
    sessionPolicy: plan.config.sessions,
    failureStatus: () => failureStatus(signal, callerSignal),
  });
  if (responsesOptions && !attempt.stream?.active)
    result.response = await applicationResponsesResult(
      result.response,
      attempt.model,
      responsesOptions
    );
  const response = result.response;
  signal.throwIfAborted();
  if (!responsesOptions) prepareSessionCompletion(plan, session, attempt, response);
  if (responsesOptions && attempt.stream?.active)
    attempt.stream.onClientCompletion(responsesOptions.prepare, () => {});
  const annotated = annotateApplicationResult(plan, result, state, session);
  if (attempt.stream?.active && response.ok) {
    const wrapped = attempt.stream.wrap(annotated);
    return {
      response: responsesOptions
        ? await applicationResponsesResult(wrapped, attempt.model, responsesOptions)
        : wrapped,
      streaming: true,
    };
  }
  return { response: annotated, streaming: false };
}
export async function executeAutomaticCombo(
  plan: AutomaticPlan,
  body: Record<string, unknown>,
  keyId: string,
  signal: AbortSignal,
  dispatch: (
    body: Record<string, unknown>,
    model: string,
    connectionId: string
  ) => Promise<Response>
): Promise<Response> {
  const callerSignal = signal;
  const deadlineAt = Date.now() + plan.config.policy.timeoutMs;
  signal = AbortSignal.any([signal, AbortSignal.timeout(plan.config.policy.timeoutMs)]);
  let attempt: (ApplicationAttempt & AttemptIdentity) | undefined;
  const state: SelectionState = { mode: "no-route" };
  let streamHandedOff = false;
  let session: SessionClaim | undefined;
  let responseSlot: ResponseHistorySlot | undefined;
  // A configured selector is not an observed selection before eligibility succeeds.

  try {
    signal.throwIfAborted();
    if (body.model !== plan.name) return automaticRejection();
    const tools = prepareTools(plan, keyId);
    if (tools?.continuation && plan.sessionInput?.boundary)
      throw new Error("decision_session_rejected");
    const extracted = validRequestFacts(body, tools, nativeOutputPlan(plan));
    if (!extracted) return automaticRejection();
    session = prepareApplicationSession(plan, keyId);
    responseSlot = reserveApplicationResponse(
      plan.responses,
      session,
      plan.sourcePolicy,
      plan.config.responses,
      plan.config.policy.timeoutMs
    );
    const trace: Array<{ phase: string; id?: string; reason: string }> = [];
    if (extracted.facts.difficulty)
      trace.push({ phase: "difficulty", reason: `local_difficulty_${extracted.facts.difficulty}` });
    if (nativeOutputPlan(plan))
      trace.push({ phase: "output_policy", reason: "provider_native_policy_selected" });
    const candidate = await selectApplicationCandidate(
      plan,
      keyId,
      signal,
      tools,
      extracted,
      state,
      trace,
      body,
      session
    );
    if (await getComboByName(`${candidate.provider}/${candidate.model}`))
      throw new Error("decision_no_route");
    const result = await runApplicationAttempts({
      plan,
      initial: candidate,
      signal,
      deadlineAt,
      continuation: !!tools?.continuation || state.mode === "session-pin",
      trace,
      capture: (value) => {
        attempt = value;
        if (session) attachRoutingSession(session, value);
      },
      acknowledge: (previous, failure) => state.native?.acknowledgeRejection(previous, failure),
      eligible: async () =>
        supportedExecutionCandidates(
          plan,
          eligibleCandidates(
            plan.config.policy,
            extracted.facts,
            await candidateSnapshot(plan, keyId),
            trace
          ),
          trace,
          !!tools,
          extracted.body
        ),
      build: (next, retry) =>
        buildAttempt(
          plan,
          next,
          keyId,
          signal,
          extracted.body.max_completion_tokens,
          trace,
          extracted.body,
          state.native,
          extracted.body.stream === true,
          extracted.body.stream_options,
          retry ? prepareTools(plan, keyId) : tools,
          retry
        ),
      dispatch: async (next, owned) => {
        if (session) assertRoutingSession(session);
        if (plan.responses?.store || plan.responses?.origin) assertResponseHistoryAllowed(keyId);
        return reportedClaudeClientUsage(
          await withApplicationAttempt(owned, () =>
            dispatch(
              selectedRequest(extracted.body, next),
              `${next.provider}/${next.model}`,
              owned.connectionId
            )
          ),
          owned
        );
      },
    });
    attempt = result.attempt;
    const completed = await completeApplicationResponse(
      plan,
      result,
      state,
      signal,
      callerSignal,
      session,
      responseSlot
    );
    streamHandedOff = completed.streaming;
    return completed.response;
  } catch (error) {
    const status = failureStatus(signal, callerSignal, state.native);
    state.native?.finishFailure(status);
    const response = rejectedAttempt(attempt, error, status);
    return state.native
      ? state.native.annotate(response)
      : annotateNoDecision(response, state.mode, attempt);
  } finally {
    if (!streamHandedOff && responseSlot) releaseResponseHistory(responseSlot, attempt);
    if (!streamHandedOff && session) releaseRoutingSession(session);
    if (!streamHandedOff) releaseAttempt(attempt);
  }
}
export function assertAutomaticModel(model: string): void {
  const attempt = currentApplicationAttempt();
  if (attempt && (attempt.signal.aborted || model !== `${attempt.provider}/${attempt.model}`))
    throw new Error("decision_model_changed");
}
