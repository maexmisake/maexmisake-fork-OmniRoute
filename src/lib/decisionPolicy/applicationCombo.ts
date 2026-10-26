import { assertNativeConnectionUnleased } from "./exclusiveLease";
import { prepareNativeStage, type NativeStage } from "./applicationSelection";
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
} from "../../../open-sse/services/decisionPolicy/contract.ts";
import { eligibleCandidates } from "../../../open-sse/services/decisionPolicy/eligibility.ts";
import { extractRequestFacts } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import {
  currentApplicationAttempt,
  withApplicationAttempt,
  type ApplicationAttempt,
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
} from "../db/decisionAttempts";
import { boundedDecisionEnabled } from "../../../open-sse/services/decisionPolicy/applicationGate.ts";
import {
  assertApplicationEgress as assertEgress,
  resolveApplicationProvider,
  assertReadyClaudeOAuth,
  claudeWireFacts,
  claudeReportedUsage,
} from "./applicationProvider";

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
  comboId: string;
  name: string;
  config: z.infer<typeof configuration>;
};
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
  keyId?: string
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
  if (!validTextFacts(body)) return automaticRejection("request_facts_unsupported");
  // Only explicit exact names in this initial lane; aliases/nesting never fall into legacy execution.
  return {
    comboId: String(combo.id),
    name: model,
    config: parsed.data,
    sourcePolicy: JSON.stringify((combo.config as Record<string, unknown>).decisionPolicy),
  };
}
function validTextFacts(raw: unknown) {
  const facts = extractRequestFacts(raw, {
    measureContext: (body) =>
      Buffer.byteLength(JSON.stringify(body), "utf8") + body.messages.length * 256,
  });
  return facts.ok &&
    !facts.facts.images &&
    !facts.facts.tools &&
    !facts.body.messages.some((row) => row.role === "tool" || row.tool_calls?.length)
    ? facts
    : null;
}

function numberOrNull(value: unknown, integer = false): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!integer || Number.isSafeInteger(value))
    ? value
    : null;
}
async function observeResponse(
  identity: AttemptIdentity,
  signal: AbortSignal,
  send: Promise<Response>
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
async function buildAttempt(
  plan: AutomaticPlan,
  candidate: Candidate,
  keyId: string,
  signal: AbortSignal,
  outputLimit: number,
  trace: Array<{ phase: string; id?: string; reason: string }>,
  native?: NativeStage
): Promise<ApplicationAttempt> {
  const connectionId = plan.config.connections[candidate.id];
  assertNativeConnectionUnleased(connectionId);
  const connection = await getProviderConnectionById(connectionId);
  if (
    !connection ||
    connection.provider !== candidate.provider ||
    connection.isActive !== true ||
    !candidate.effort.value ||
    candidate.effort.mode !== "set"
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
  const contract = resolveApplicationProvider(candidate, connection);
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
    trace,
    ...(native
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
    native?.identity.id,
    plan.name
  );
  const stamp = authorityStamp(identity, plan.sourcePolicy);
  const endpoint = new URL(contract.endpoint);
  assertEgress(candidate.provider, endpoint.href);
  const plugins = createValidationPluginFence();
  let reserved = false;
  const assertFresh = () => {
    try {
      signal.throwIfAborted();
      assertNativeConnectionUnleased(connectionId);
      if (reserved) assertDecisionLease(identity);
      native?.assertFresh();
      plugins.assertIdle();
      assertUncappedDecision(
        keyId,
        candidate.provider,
        candidate.model,
        native?.identity.id,
        plan.name
      );
      if (authorityStamp(identity, plan.sourcePolicy) !== stamp)
        throw new Error("decision_authority_changed");
      if (contract.claude) {
        assertReadyClaudeOAuth(contract.credentials);
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
  });
  if (native) native.handover(identity);
  else reserveDecisionAttempt(identity);
  reserved = true;
  return {
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
        assertEgress(candidate.provider, details.url);
        const wire = typeof details.body === "string" ? JSON.parse(details.body) : null;
        const headers = new Headers(details.headers);
        if (
          authorityStamp(identity, plan.sourcePolicy) !== stamp ||
          details.provider !== candidate.provider ||
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
          wire?.model !== candidate.model ||
          (!contract.claude &&
            (wire?.reasoning_effort ?? wire?.reasoning?.effort) !== candidate.effort.value) ||
          wire?.stream === true ||
          (!contract.claude &&
            Object.keys(wire ?? {}).some(
              (key) =>
                ![
                  "model",
                  "messages",
                  "stream",
                  "reasoning_effort",
                  "reasoning",
                  "max_tokens",
                  "max_completion_tokens",
                  "prompt_cache_key",
                ].includes(key)
            ))
        )
          throw new Error("decision_identity_changed");
        const messages = contract.claude
          ? claudeWireFacts(wire, candidate.effort.value!, outputLimit)
          : wire.messages;
        const finalFacts = validTextFacts({
          model: plan.name,
          messages,
          stream: false,
          max_completion_tokens: wire.max_completion_tokens ?? wire.max_tokens,
          ...(wire.tools ? { tools: wire.tools } : {}),
          reasoning_effort: candidate.effort.value,
        });
        if (
          !finalFacts ||
          (wire.max_completion_tokens ?? wire.max_tokens) !== outputLimit ||
          candidate.capabilities.contextTokens === null ||
          Buffer.byteLength(JSON.stringify(wire), "utf8") +
            wire.messages.length * 256 +
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
    observe: (send) => observeResponse(identity, signal, send),
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
  if (attempt.provider !== "claude" || !response.ok) return response;
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
  for (const candidate of plan.config.policy.candidates) {
    const allowed = await isModelAllowedForKey(
      String((await getApiKeyById(keyId))?.key ?? ""),
      `${candidate.provider}/${candidate.model}`
    );
    const conn = await getProviderConnectionById(plan.config.connections[candidate.id]);
    snapshot[candidate.id] = {
      authorized: allowed,
      available: conn?.isActive === true,
      quota: "unknown",
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
  signal = AbortSignal.any([signal, AbortSignal.timeout(plan.config.policy.timeoutMs)]);
  let attempt: ApplicationAttempt | undefined;
  let native: NativeStage | undefined;
  try {
    signal.throwIfAborted();
    if (body.model !== plan.name) return automaticRejection();
    const extracted = validTextFacts(body);
    if (!extracted) return automaticRejection();
    const snapshot = await candidateSnapshot(plan, keyId);
    const trace: Array<{ phase: string; id?: string; reason: string }> = [];
    const eligible = eligibleCandidates(plan.config.policy, extracted.facts, snapshot, trace);
    let candidate = eligible[0];
    if (plan.config.selection?.mode === "native") {
      native = await prepareNativeStage(plan, eligible, keyId, signal);
      candidate = await native.select(extracted.facts);
    }
    if (!candidate || (await getComboByName(`${candidate.provider}/${candidate.model}`)))
      throw new Error("decision_no_route");
    attempt = await buildAttempt(
      plan,
      candidate,
      keyId,
      signal,
      extracted.body.max_completion_tokens,
      trace,
      native
    );
    let response = await withApplicationAttempt(attempt, () =>
      dispatch(
        { ...extracted.body, stream: false, reasoning_effort: candidate.effort.value },
        `${candidate.provider}/${candidate.model}`,
        attempt!.connectionId
      )
    );
    if (signal.aborted)
      response = rejectedAttempt(
        attempt,
        new Error("decision_deadline"),
        callerSignal.aborted ? 499 : 504
      );
    response = await reportedClaudeClientUsage(response, attempt);
    signal.throwIfAborted();
    finishDecisionApplication(attempt.id, response.status);
    const result = new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
    result.headers.set("x-omniroute-decision-attempt", attempt.id);
    result.headers.set("x-omniroute-decision-candidate", candidate.id);
    return native ? native.annotate(result) : result;
  } catch (error) {
    const status = failureStatus(signal, callerSignal, native);
    native?.finishFailure(status);
    const response = rejectedAttempt(attempt, error, status);
    return native ? native.annotate(response) : response;
  } finally {
    releaseAttempt(attempt);
  }
}
export function assertAutomaticModel(model: string): void {
  const attempt = currentApplicationAttempt();
  if (attempt && (attempt.signal.aborted || model !== `${attempt.provider}/${attempt.model}`))
    throw new Error("decision_model_changed");
}
