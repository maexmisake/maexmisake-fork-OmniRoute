import { getProviderValidationGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { getExecutor } from "../../../open-sse/executors/index.ts";
import { createValidationDispatchFence } from "../modelValidation/dispatchFence";
import { createValidationPluginFence } from "../modelValidation/pluginFence";
import { getSettings } from "../db/settings";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  policySchema,
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
  cancelUnstartedDecision,
  type AttemptIdentity,
} from "../db/decisionAttempts";
import {
  hasAmbientProxyContext,
  isTlsFingerprintActive,
  resolveProxyForRequest,
} from "../../../open-sse/utils/proxyFetch.ts";
import { boundedDecisionEnabled } from "../../../open-sse/services/decisionPolicy/applicationGate.ts";

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
const configuration = z
  .object({
    enabled: z.literal(true),
    applicationMode: z.literal("bounded-v1"),
    policy: policySchema,
    connections: z.record(z.string(), z.string().min(1)),
  })
  .strict()
  .refine(
    (value) => value.policy.maxExecutionAttempts === 1 && value.policy.maxDecisionAttempts === 0
  );
export type AutomaticPlan = {
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
  return { comboId: String(combo.id), name: model, config: parsed.data };
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
function assertEgress(provider: string, url: string): void {
  if (
    getProviderValidationGuard() === "none" ||
    hasAmbientProxyContext() ||
    isTlsFingerprintActive(provider, false) ||
    process.env.ENABLE_TLS_FINGERPRINT === "true" ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    process.env.PROXY_FAIL_OPEN === "true" ||
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
      (key) => !!process.env[key]
    ) ||
    resolveProxyForRequest(url).source !== "direct"
  )
    throw new Error("decision_egress_unsupported");
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
  const usage =
    data?.usage && typeof data.usage === "object" ? (data.usage as Record<string, unknown>) : {};
  try {
    settleDecisionAttempt(identity, {
      status: complete && !signal.aborted ? response.status : null,
      input: numberOrNull(usage.prompt_tokens, true),
      output: numberOrNull(usage.completion_tokens, true),
      cost: numberOrNull(usage.cost),
      reasoning: numberOrNull(
        (usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens,
        true
      ),
      cacheRead: numberOrNull(
        (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
        true
      ),
      cacheCreation: numberOrNull(
        (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cache_creation_tokens,
        true
      ),
    });
  } catch {
    throw new Error("decision_settlement_pending");
  }
  if (!complete || signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw new Error("decision_response_incomplete");
  }
  signal.throwIfAborted();
  return response;
}
async function buildAttempt(
  plan: AutomaticPlan,
  candidate: Candidate,
  keyId: string,
  signal: AbortSignal,
  outputLimit: number,
  trace: Array<{ phase: string; id?: string; reason: string }>
): Promise<ApplicationAttempt> {
  const connectionId = plan.config.connections[candidate.id];
  const connection = await getProviderConnectionById(connectionId);
  if (
    !connection ||
    connection.provider !== candidate.provider ||
    connection.authType !== "apikey" ||
    connection.isActive !== true ||
    candidate.provider !== "openai" ||
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
  const data = z.record(z.string(), z.unknown()).parse(connection.providerSpecificData ?? {});
  if (data.extraApiKeys || data.cliproxyapiMode || data.darioMode)
    throw new Error("decision_connection_unsupported");
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId,
    comboId: plan.comboId,
    candidateId: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    connectionId,
    effort: candidate.effort.value,
    trace,
  };
  assertUncappedDecision(keyId, candidate.provider, candidate.model);
  const stamp = authorityStamp(identity);
  const base =
    typeof data.baseUrl === "string" ? data.baseUrl : "https://api.openai.com/v1/chat/completions";
  const endpoint = new URL(
    base.endsWith("/chat/completions") ? base : base.replace(/\/$/, "") + "/chat/completions"
  );
  assertEgress(candidate.provider, endpoint.href);
  const plugins = createValidationPluginFence();
  const assertFresh = () => {
    try {
      signal.throwIfAborted();
      plugins.assertIdle();
      assertUncappedDecision(keyId, candidate.provider, candidate.model);
      if (authorityStamp(identity) !== stamp) throw new Error("decision_authority_changed");
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
    expectedExecutor: await getExecutor(candidate.provider),
    expectedCredentials: { apiKey: String(connection.apiKey), connectionId },
  });
  reserveDecisionAttempt(identity);
  return {
    ...identity,
    signal,
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
          authorityStamp(identity) !== stamp ||
          details.provider !== candidate.provider ||
          details.model !== candidate.model ||
          details.credentials.connectionId !== connectionId ||
          details.credentials.apiKey !== connection.apiKey ||
          headers.get("authorization") !== `Bearer ${connection.apiKey}` ||
          details.url !== endpoint.href ||
          wire?.model !== candidate.model ||
          (wire?.reasoning_effort ?? wire?.reasoning?.effort) !== candidate.effort.value ||
          wire?.stream === true ||
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
          )
        )
          throw new Error("decision_identity_changed");
        const finalFacts = validTextFacts({
          model: plan.name,
          messages: wire.messages,
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
  try {
    signal.throwIfAborted();
    if (body.model !== plan.name) return automaticRejection();
    const extracted = validTextFacts(body);
    if (!extracted) return automaticRejection();
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
    const trace: Array<{ phase: string; id?: string; reason: string }> = [];
    const eligible = eligibleCandidates(plan.config.policy, extracted.facts, snapshot, trace);
    const candidate = eligible[0];
    if (!candidate || (await getComboByName(`${candidate.provider}/${candidate.model}`)))
      return automaticRejection("no_route");
    attempt = await buildAttempt(
      plan,
      candidate,
      keyId,
      signal,
      extracted.body.max_completion_tokens,
      trace
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
    finishDecisionApplication(attempt.id, response.status);
    const result = new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
    result.headers.set("x-omniroute-decision-attempt", attempt.id);
    result.headers.set("x-omniroute-decision-candidate", candidate.id);
    return result;
  } catch (error) {
    return rejectedAttempt(
      attempt,
      error,
      signal.aborted ? (callerSignal.aborted ? 499 : 504) : 409
    );
  } finally {
    if (attempt) cancelUnstartedDecision(attempt.id);
  }
}
export function assertAutomaticModel(model: string): void {
  const attempt = currentApplicationAttempt();
  if (attempt && (attempt.signal.aborted || model !== `${attempt.provider}/${attempt.model}`))
    throw new Error("decision_model_changed");
}
