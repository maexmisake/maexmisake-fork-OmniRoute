/**
 * System One decision proxy (`POST /v1/systemone`).
 *
 * Dispatches one already-resolved target — provider, upstream model, selected
 * connection — to that backend's decision endpoint and accounts for it through
 * the existing writers: one `call_logs` row per attempt, one `usage_history` row
 * per successful call (so API-key budget and usage limits see decisions), and a
 * cost entry only when the cost is actually known.
 *
 * Every collaborator is injectable. The handler itself never reads the provider
 * store, so target selection, rotation and policy stay in the route and the
 * credential selector.
 *
 * Upstream error bodies are never passed through: a decision request carries the
 * caller's `state` (frequently the operator's own data) and some upstreams echo
 * it, or the request key, back in the error. Bounded sanitized diagnostic fields may reach the client after credential,
 * account and request-echo projection; raw error bodies never do.
 */

import { NativeConnectionLeaseError } from "@/lib/decisionPolicy/exclusiveLease";
import {
  projectSystemOneFailure,
  systemOneSensitiveValues,
  systemOneRetryAfter,
} from "./systemOneDiagnostics.ts";
import { updateFromHeaders } from "../services/rateLimitManager.ts";
import { runWithSharedCapacity } from "./systemOneCapacity.ts";
import {
  getClientSafeLocalRateLimitError,
  markLocalRateLimitError,
  markTrustedLocalRateLimitResponse,
  RATE_LIMIT_QUEUE_FULL_CODE,
  LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
  RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
} from "../services/rateLimitManager/errors.ts";
import { isOpencodeFreeTierRefusalForProvider } from "../executors/opencodeGeoBlock.ts";
import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse, sanitizeErrorMessage, buildErrorBody } from "../utils/error.ts";
import {
  nativeSystemOnePricing,
  systemOneBackend,
  type SystemOneTier,
} from "../config/systemOneRegistry.ts";
import { isConnectionEligibleForTier } from "../config/systemOneRegistry.ts";
import {
  parseSystemOneAnswers,
  parseSystemOneUsage,
} from "../services/typesafe/systemOneAnswers.ts";
import {
  SystemOneEndpointError,
  fetchSystemOne as defaultFetchSystemOne,
  systemOneHeaders,
  systemOneUrl,
  type SystemOneCredentials,
} from "./systemOneTransport.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { saveCallLog, saveRequestUsage } from "@/lib/usageDb";
import { recordCost } from "@/domain/costRules";
import { calculateCostDetailed } from "@/lib/usage/costCalculator";
import { markAccountUnavailable } from "../../src/sse/services/auth.ts";
import { isCredentialDiagnosticSentinel } from "../../src/sse/services/credentialSentinel.ts";
import { recordKeyQuotaUsage } from "@/domain/keyQuota";
import { recordTokenUsage } from "../services/tokenLimitCounter.ts";

export type { SystemOneCredentials } from "./systemOneTransport.ts";

export const SYSTEMONE_ROUTE_PATH = "/v1/systemone";

export interface SystemOneProxyOptions {
  provider: string;
  /** Body forwarded upstream, already validated; `model` is the upstream id. */
  body: Record<string, unknown>;
  /** `<provider>/<model>` — the identity used by policy, metadata and call logs. */
  canonicalModel: string;
  /** What the client asked for, kept for the call log. */
  requestedModel?: string | null;
  tier?: SystemOneTier;
  credentials: SystemOneCredentials | null;
  apiKeyInfo?: { id?: string | null; name?: string | null } | null;
  correlationId?: string | null;
  signal?: AbortSignal;
  requestDeadlineSignal?: AbortSignal;
  timeoutMs?: number;
}

export type SystemOneProxyDeps = {
  fetchSystemOne: typeof defaultFetchSystemOne;
  withCapacity: (
    options: SystemOneProxyOptions,
    signal: AbortSignal,
    run: () => Promise<Response>
  ) => Promise<Response>;
  saveCallLog: (entry: Record<string, unknown>) => Promise<void>;
  saveRequestUsage: (entry: Record<string, unknown>) => Promise<void>;
  recordCost: (apiKeyId: string, costUsd: number, details?: Record<string, unknown>) => void;
  markAccountUnavailable: (
    connectionId: string,
    status: number,
    errorText: string,
    provider: string | null,
    model: string | null,
    providerProfile?: null,
    options?: { headers?: Headers | Record<string, string> | null; correlationId?: string | null }
  ) => Promise<unknown>;
  calculateCost: (
    provider: string,
    model: string,
    tokens: Record<string, number | undefined>
  ) => Promise<{ costUsd: number; priced: boolean }>;
  generateRequestId: () => string;
};

export const defaultSystemOneProxyDeps: SystemOneProxyDeps = {
  fetchSystemOne: defaultFetchSystemOne,
  withCapacity: runWithSharedCapacity,
  saveCallLog: (entry) => saveCallLog(entry),
  saveRequestUsage: async (entry) => {
    await saveRequestUsage(entry as Parameters<typeof saveRequestUsage>[0]);
  },
  recordCost: (apiKeyId, costUsd, details) =>
    recordCost(apiKeyId, costUsd, details as Parameters<typeof recordCost>[2]),
  markAccountUnavailable: (connectionId, status, errorText, provider, model, _profile, options) =>
    markAccountUnavailable(connectionId, status, errorText, provider, model, null, options ?? {}),
  calculateCost: (provider, model, tokens) => calculateCostDetailed(provider, model, tokens),
  generateRequestId,
};

/** 4xx that describe the caller's request, not the health of the account. */
const CALLER_FAULT_STATUSES = new Set([400, 404, 405, 409, 413, 415, 422]);

function shouldCoolDownConnection(status: number): boolean {
  if (CALLER_FAULT_STATUSES.has(status)) return false;
  return status === 401 || status === 402 || status >= 500;
}

type UpstreamBody = Record<string, unknown> | null;

function parseUpstreamBody(text: string): UpstreamBody {
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type CallContext = {
  provider: string;
  canonicalModel: string;
  requestedModel: string | null;
  upstreamModel: string | null;
  connectionId: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  correlationId: string | null;
  startTime: number;
};

function describeCall(options: SystemOneProxyOptions): CallContext {
  const upstreamModel = typeof options.body.model === "string" ? options.body.model : null;
  return {
    provider: options.provider,
    canonicalModel: options.canonicalModel,
    requestedModel: options.requestedModel ?? upstreamModel,
    upstreamModel,
    connectionId: options.credentials?.connectionId || null,
    apiKeyId: options.apiKeyInfo?.id || null,
    apiKeyName: options.apiKeyInfo?.name || null,
    correlationId: options.correlationId || null,
    startTime: Date.now(),
  };
}

type Tokens = { prompt_tokens: number | null; completion_tokens: number | null };

function tokenCounts(inputTokens: number | null, outputTokens: number | null): Tokens {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
  };
}

async function logCall(
  deps: SystemOneProxyDeps,
  call: CallContext,
  status: number,
  tokens: Tokens,
  error?: string
): Promise<void> {
  await deps
    .saveCallLog({
      method: "POST",
      path: SYSTEMONE_ROUTE_PATH,
      status,
      model: call.canonicalModel,
      requestedModel: call.requestedModel,
      provider: call.provider,
      duration: Date.now() - call.startTime,
      tokens,
      connectionId: call.connectionId,
      requestType: "systemone",
      correlationId: call.correlationId,
      ...(call.apiKeyId ? { apiKeyId: call.apiKeyId } : {}),
      ...(call.apiKeyName ? { apiKeyName: call.apiKeyName } : {}),
      ...(error ? { error } : {}),
    })
    .catch(() => {});
}

/**
 * Real credentials name the selected connection. Selector markers (allExpired,
 * lease fences, key-policy blocks) are not credentials, and a keyless backend
 * still needs a selected connection — otherwise a request with no account at
 * all would dispatch to the default host.
 */
function hasDispatchableCredentials(provider: string, credentials: unknown): boolean {
  if (!credentials || typeof credentials !== "object") return false;
  if (isCredentialDiagnosticSentinel(credentials)) return false;
  const record = credentials as SystemOneCredentials & Record<string, unknown>;
  if (record.leaseFenceStale || record.leaseRequired || record.waitingForCapacity) return false;
  const hasToken = Boolean(record.apiKey || record.accessToken);
  if (systemOneBackend(provider).requiresKey) return hasToken;
  return hasToken || typeof record.connectionId === "string";
}

function validateProxyCredentials(options: SystemOneProxyOptions): Response | null {
  if (!hasDispatchableCredentials(options.provider, options.credentials)) {
    return errorResponse(401, `No usable credentials for provider: ${options.provider}`);
  }

  const tier: SystemOneTier = options.tier ?? "paid";
  if (!isConnectionEligibleForTier(tier, options.credentials ?? {}, options.provider)) {
    // A free model routed through a paid account would bill that account for a
    // model the caller requested as free.
    return errorResponse(
      tier === "free" ? 403 : 401,
      tier === "free"
        ? `Model ${options.canonicalModel} is a free-tier model and the selected account is not the free tier`
        : `The selected ${options.provider} account cannot serve ${options.canonicalModel}`
    );
  }
  return null;
}

/**
 * Resolve the request's cost. `null` means unknown, which is reported as unknown
 * rather than billed as zero; a reported zero is a known zero.
 */
async function resolveCost(
  deps: SystemOneProxyDeps,
  call: CallContext,
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
): Promise<number | null> {
  if (usage.costUsd !== null) return usage.costUsd;
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const tokens = tokenCounts(usage.inputTokens, usage.outputTokens);
  const pricingModel = call.upstreamModel || call.canonicalModel;
  const priced = await deps
    .calculateCost(call.provider, pricingModel, {
      input_tokens: tokens.prompt_tokens,
      output_tokens: tokens.completion_tokens,
    })
    .catch(() => ({ costUsd: 0, priced: false }));
  if (priced.priced) return priced.costUsd;
  const published = nativeSystemOnePricing(call.provider, pricingModel);
  if (!published) return null;
  return (
    (tokens.prompt_tokens * published.input + tokens.completion_tokens * published.output) /
    1_000_000
  );
}

function successResponse(
  deps: SystemOneProxyDeps,
  text: string,
  call: CallContext,
  tokens: Tokens,
  costUsd: number | null
): Response {
  const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
  attachOmniRouteMetaHeaders(headers, {
    provider: call.provider,
    model: call.canonicalModel,
    costUsd: costUsd ?? 0,
    latencyMs: Date.now() - call.startTime,
    requestId: call.correlationId || deps.generateRequestId(),
    usage: tokens,
  });
  if (costUsd === null) headers.delete("X-OmniRoute-Response-Cost");
  if (tokens.prompt_tokens === null) headers.delete("X-OmniRoute-Tokens-In");
  if (tokens.completion_tokens === null) {
    headers.delete("X-OmniRoute-Tokens-Out");
    headers.delete("X-OmniRoute-Tokens-Per-Second");
  }
  headers.set("X-OmniRoute-Cost-Status", costUsd === null ? "unknown" : "known");
  return new Response(text, { status: 200, headers });
}

async function coolDown(
  deps: SystemOneProxyDeps,
  call: CallContext,
  status: number,
  message: string,
  headers?: Headers
): Promise<void> {
  if (!call.connectionId) return;
  await deps
    .markAccountUnavailable(
      call.connectionId,
      status,
      message,
      call.provider,
      call.upstreamModel,
      null,
      { headers: headers ?? null, correlationId: call.correlationId }
    )
    .catch(() => {
      // The upstream answer has priority over a best-effort cooldown write.
    });
}

async function upstreamFailure(
  deps: SystemOneProxyDeps,
  call: CallContext,
  response: Response,
  parsed: UpstreamBody,
  text: string,
  options: SystemOneProxyOptions
): Promise<Response> {
  const requestScoped = isOpencodeFreeTierRefusalForProvider(
    call.provider,
    response.status,
    JSON.stringify(parsed)
  );
  const diagnostic = projectSystemOneFailure({
    status: response.status,
    body: parsed,
    bodyText: text,
    authenticated: true,
    sensitiveValues: systemOneSensitiveValues([
      options.credentials?.apiKey,
      options.credentials?.accessToken,
      options.credentials?.connectionId,
      options.apiKeyInfo?.id,
      options.apiKeyInfo?.name,
      options.correlationId,
      options.body,
    ]),
  });
  const message = diagnostic.message;
  const usage = parseSystemOneUsage(parsed ?? {});
  const tokens = tokenCounts(usage.inputTokens, usage.outputTokens);
  await logCall(deps, call, response.status, tokens, message);
  await recordFailedUsage(deps, call, response.status, usage, tokens);
  if (!requestScoped && shouldCoolDownConnection(response.status)) {
    await coolDown(deps, call, response.status, message, response.headers);
  }
  const body = buildErrorBody(response.status, message, diagnostic.details, {
    code: requestScoped
      ? "upstream_request_error"
      : response.status === 502
        ? "upstream_error"
        : undefined,
  });
  const failure = new Response(JSON.stringify(body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
  failure.headers.set("x-omniroute-cost-status", usage.costUsd === null ? "unknown" : "known");
  if (usage.costUsd !== null)
    failure.headers.set("x-omniroute-response-cost", String(usage.costUsd));
  failure.headers.set("x-omniroute-provider-error-kind", diagnostic.kind);
  failure.headers.set("x-omniroute-provider-auth-scope", diagnostic.authScope);
  const retryAfter = systemOneRetryAfter(response.headers.get("retry-after"));
  if (retryAfter) failure.headers.set("retry-after", retryAfter);
  return failure;
}

/** Non-2xx may still report a charge. Preserve exact receipts through the existing
 * writers; never estimate an error charge from a catalog or turn missing into zero. */
async function recordFailedUsage(
  deps: SystemOneProxyDeps,
  call: CallContext,
  status: number,
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null },
  tokens: Tokens
): Promise<void> {
  if (usage.inputTokens === null && usage.outputTokens === null && usage.costUsd === null) return;
  recordDecisionTokenUsage(call, tokens);
  await deps
    .saveRequestUsage({
      provider: call.provider,
      model: call.upstreamModel || call.canonicalModel,
      tokens: { ...tokens, cost_usd: usage.costUsd ?? undefined },
      status: String(status),
      success: false,
      endpoint: SYSTEMONE_ROUTE_PATH,
      connectionId: call.connectionId,
      apiKeyId: call.apiKeyId,
      apiKeyName: call.apiKeyName,
    })
    .catch(() => {});
  if (call.apiKeyId && usage.costUsd !== null)
    deps.recordCost(call.apiKeyId, usage.costUsd, {
      provider: call.provider,
      model: call.canonicalModel,
      success: false,
      requestId: call.correlationId ?? undefined,
    });
}

function recordDecisionTokenUsage(call: CallContext, tokens: Tokens): void {
  if (!call.apiKeyId) return;
  const billable = (tokens.prompt_tokens ?? 0) + (tokens.completion_tokens ?? 0);
  recordKeyQuotaUsage(call.apiKeyId, billable);
  recordTokenUsage(
    call.apiKeyId,
    call.provider,
    call.upstreamModel || call.canonicalModel,
    billable
  );
}

async function handleSuccessfulResponse(
  deps: SystemOneProxyDeps,
  call: CallContext,
  text: string,
  parsed: UpstreamBody,
  body: SystemOneProxyOptions["body"]
): Promise<Response> {
  const answers = parseSystemOneAnswers(parsed, body);
  if (answers.ok === false) {
    const message = `System One upstream returned an invalid response body: ${answers.detail}`;
    // HTTP success may be billed even when its answer contract is malformed.
    // Preserve an exact report; missing counts/cost remain explicitly unknown.
    const usage = parseSystemOneUsage(parsed && typeof parsed === "object" ? parsed : {});
    const tokens = tokenCounts(usage.inputTokens, usage.outputTokens);
    recordDecisionTokenUsage(call, tokens);
    await logCall(deps, call, 502, tokens, message);
    await deps.saveRequestUsage({
      provider: call.provider,
      model: call.upstreamModel || call.canonicalModel,
      tokens: {
        ...tokens,
        cost_usd: usage.costUsd ?? undefined,
      },
      status: "502",
      success: false,
      endpoint: SYSTEMONE_ROUTE_PATH,
      timestamp: new Date().toISOString(),
      connectionId: call.connectionId,
      apiKeyId: call.apiKeyId,
      apiKeyName: call.apiKeyName,
    });
    if (call.apiKeyId && usage.costUsd !== null) {
      deps.recordCost(call.apiKeyId, usage.costUsd, {
        provider: call.provider,
        model: call.canonicalModel,
        success: false,
        requestId: call.correlationId ?? undefined,
      });
    }
    return errorResponse(502, message, { code: "upstream_protocol_error" });
  }

  const tokens = tokenCounts(answers.usage.inputTokens, answers.usage.outputTokens);
  const costUsd = await resolveCost(deps, call, answers.usage);

  recordDecisionTokenUsage(call, tokens);
  // Counter initialization must finish before this call enters usage history.
  await logCall(deps, call, 200, tokens);
  await deps
    .saveRequestUsage({
      provider: call.provider,
      model: call.upstreamModel || call.canonicalModel,
      tokens: { ...tokens, cost_usd: answers.usage.costUsd ?? undefined },
      status: "200",
      success: true,
      latencyMs: Date.now() - call.startTime,
      endpoint: SYSTEMONE_ROUTE_PATH,
      ...(call.connectionId ? { connectionId: call.connectionId } : {}),
      ...(call.apiKeyId ? { apiKeyId: call.apiKeyId } : {}),
      ...(call.apiKeyName ? { apiKeyName: call.apiKeyName } : {}),
    })
    .catch(() => {});
  if (call.apiKeyId && costUsd !== null) {
    deps.recordCost(call.apiKeyId, costUsd, {
      provider: call.provider,
      model: call.canonicalModel,
      tokens: { input: tokens.prompt_tokens, output: tokens.completion_tokens },
      success: true,
      requestId: call.correlationId ?? undefined,
    });
  }
  return successResponse(deps, text, call, tokens, costUsd);
}

function normalizeCapacityFailure(
  error: unknown,
  timeoutSignal: AbortSignal,
  upstreamStarted: boolean
): unknown {
  const semaphoreCode = (error as { code?: string })?.code;
  if (
    semaphoreCode === "SEMAPHORE_QUEUE_FULL" ||
    semaphoreCode === "SEMAPHORE_TIMEOUT" ||
    (!upstreamStarted && timeoutSignal.aborted)
  ) {
    error = markLocalRateLimitError(
      new Error("System One local capacity unavailable"),
      semaphoreCode === "SEMAPHORE_QUEUE_FULL"
        ? RATE_LIMIT_QUEUE_FULL_CODE
        : timeoutSignal.aborted
          ? RATE_LIMIT_EXECUTION_TIMEOUT_CODE
          : LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE
    );
  }
  return error;
}

async function requestFailure(
  deps: SystemOneProxyDeps,
  call: CallContext,
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  upstreamStarted: boolean,
  requestDeadlineSignal?: AbortSignal
): Promise<Response> {
  if (callerSignal?.aborted) {
    const deadline = requestDeadlineSignal?.aborted === true;
    const status = deadline ? 504 : 499;
    const message = deadline
      ? "System One dispatch deadline exceeded"
      : "System One request aborted by caller";
    // A local dispatch deadline or caller abort says nothing about account health.
    await logCall(deps, call, status, tokenCounts(null, null), message);
    return errorResponse(status, message, deadline ? { code: "upstream_timeout" } : undefined);
  }
  if (error instanceof NativeConnectionLeaseError)
    return errorResponse(409, "Native connection is reserved by an exclusive session lease", {
      type: "lease_error",
      code: "LEASE_CAPACITY_UNAVAILABLE",
    });
  error = normalizeCapacityFailure(error, timeoutSignal, upstreamStarted);
  const local = getClientSafeLocalRateLimitError(error);
  if (local) {
    await logCall(
      deps,
      call,
      local.status,
      tokenCounts(null, null),
      "System One local capacity unavailable"
    );
    return markTrustedLocalRateLimitResponse(
      errorResponse(local.status, "System One local capacity unavailable", { code: local.code }),
      error
    );
  }
  const timedOut = timeoutSignal.aborted;
  const status = timedOut ? 504 : 502;
  const message = timedOut
    ? "System One request timed out"
    : sanitizeErrorMessage(error) || "System One request failed";
  await logCall(deps, call, status, tokenCounts(null, null), message);
  if (upstreamStarted) await coolDown(deps, call, status, message);
  return errorResponse(status, message, {
    code: timedOut ? "upstream_timeout" : "upstream_error",
  });
}

export async function handleSystemOneProxy(
  options: SystemOneProxyOptions,
  overrides: Partial<SystemOneProxyDeps> = {}
): Promise<Response> {
  const deps: SystemOneProxyDeps = { ...defaultSystemOneProxyDeps, ...overrides };
  let backendTimeoutMs: number;
  try {
    backendTimeoutMs = systemOneBackend(options.provider).timeoutMs;
  } catch (error) {
    return errorResponse(400, sanitizeErrorMessage(error));
  }

  const credentialRejection = validateProxyCredentials(options);
  if (credentialRejection) return credentialRejection;
  const credentials = options.credentials;
  const call = describeCall(options);

  let url: string;
  try {
    url = systemOneUrl(options.provider, credentials ?? {});
  } catch (error) {
    // A rejected endpoint is a configuration error: no cooldown, no upstream call.
    const status = error instanceof SystemOneEndpointError ? error.status : 400;
    return errorResponse(status, sanitizeErrorMessage(error));
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? backendTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let upstreamStarted = false;
  try {
    return await deps.withCapacity(options, signal, async () => {
      signal.throwIfAborted();
      upstreamStarted = true;
      const response = await deps.fetchSystemOne(url, credentials ?? {}, {
        method: "POST",
        headers: systemOneHeaders(options.provider, credentials ?? {}),
        body: JSON.stringify(options.body),
        signal,
      });
      updateFromHeaders(
        options.provider,
        credentials?.connectionId,
        response.headers,
        response.status,
        call.upstreamModel
      );
      const text = await response.text();
      const parsed = parseUpstreamBody(text);

      if (!response.ok) return upstreamFailure(deps, call, response, parsed, text, options);

      return await handleSuccessfulResponse(deps, call, text, parsed, options.body);
    });
  } catch (error) {
    return requestFailure(
      deps,
      call,
      error,
      options.signal,
      timeoutSignal,
      upstreamStarted,
      options.requestDeadlineSignal
    );
  }
}
