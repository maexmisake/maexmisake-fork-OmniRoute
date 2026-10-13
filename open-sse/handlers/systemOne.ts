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
 * it, or the request key, back in the error. Only the status and a short, safe
 * upstream error code reach the client.
 */

import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import {
  nativeSystemOnePricing,
  systemOneBackend,
  type SystemOneTier,
} from "../config/systemOneRegistry.ts";
import { isConnectionEligibleForTier } from "../config/systemOneRegistry.ts";
import { parseSystemOneAnswers } from "../services/typesafe/systemOneAnswers.ts";
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

export type { SystemOneCredentials } from "./systemOneTransport.ts";

export const SYSTEMONE_ROUTE_PATH = "/v1/systemone";

export interface SystemOneProxyOptions {
  provider: string;
  /** Body forwarded upstream, already validated; `model` is the upstream id. */
  body: Record<string, unknown>;
  /** `<provider>/<model>` — the identity policy, usage and cooldown speak. */
  canonicalModel: string;
  /** What the client asked for, kept for the call log. */
  requestedModel?: string | null;
  tier?: SystemOneTier;
  credentials: SystemOneCredentials | null;
  apiKeyInfo?: { id?: string | null; name?: string | null } | null;
  correlationId?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type SystemOneProxyDeps = {
  fetchSystemOne: typeof defaultFetchSystemOne;
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
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
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

/** A short identifier-shaped token cannot carry a sentence of request state. */
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function upstreamErrorCode(parsed: UpstreamBody): string | null {
  const error = parsed?.error;
  const candidates: unknown[] = [
    typeof error === "string" ? error : null,
    error && typeof error === "object" ? (error as Record<string, unknown>).code : null,
    error && typeof error === "object" ? (error as Record<string, unknown>).type : null,
    parsed?.code,
    parsed?.type,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && SAFE_CODE.test(candidate.trim())) return candidate.trim();
  }
  return null;
}

/**
 * Status-derived message plus, when present, the upstream's own short error code
 * (`FreeTierError`, `insufficient_quota`, …). The upstream's prose is dropped.
 */
function upstreamFailureMessage(parsed: UpstreamBody, status: number): string {
  const code = upstreamErrorCode(parsed);
  return code ? `Provider returned HTTP ${status} (${code})` : `Provider returned HTTP ${status}`;
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

type Tokens = { prompt_tokens: number; completion_tokens: number };

function tokenCounts(inputTokens: number | null, outputTokens: number | null): Tokens {
  return {
    prompt_tokens: inputTokens !== null && inputTokens >= 0 ? inputTokens : 0,
    completion_tokens: outputTokens !== null && outputTokens >= 0 ? outputTokens : 0,
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
  if (usage.inputTokens === null) return null;
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
      call.canonicalModel,
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
  parsed: UpstreamBody
): Promise<Response> {
  const message = sanitizeErrorMessage(upstreamFailureMessage(parsed, response.status));
  await logCall(deps, call, response.status, tokenCounts(null, null), message);
  if (shouldCoolDownConnection(response.status)) {
    await coolDown(deps, call, response.status, message, response.headers);
  }
  const failure = errorResponse(response.status, message);
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) failure.headers.set("retry-after", retryAfter);
  return failure;
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

  const credentials = options.credentials;
  if (!hasDispatchableCredentials(options.provider, credentials)) {
    return errorResponse(401, `No usable credentials for provider: ${options.provider}`);
  }

  const tier: SystemOneTier = options.tier ?? "paid";
  if (!isConnectionEligibleForTier(tier, credentials ?? {}, options.provider)) {
    // A free model routed through a paid account would bill that account for a
    // model the caller requested as free.
    return errorResponse(
      tier === "free" ? 403 : 401,
      tier === "free"
        ? `Model ${options.canonicalModel} is a free-tier model and the selected account is not the free tier`
        : `The selected ${options.provider} account cannot serve ${options.canonicalModel}`
    );
  }

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

  try {
    const response = await deps.fetchSystemOne(url, credentials ?? {}, {
      method: "POST",
      headers: systemOneHeaders(options.provider, credentials ?? {}),
      body: JSON.stringify(options.body),
      signal,
    });
    const text = await response.text();
    const parsed = parseUpstreamBody(text);

    if (!response.ok) return upstreamFailure(deps, call, response, parsed);

    const answers = parseSystemOneAnswers(parsed);
    if (!answers.ok) {
      const message = `System One upstream returned an invalid response body: ${answers.detail}`;
      await logCall(deps, call, 502, tokenCounts(null, null), message);
      return errorResponse(502, message);
    }

    const tokens = tokenCounts(answers.usage.inputTokens, answers.usage.outputTokens);
    const costUsd = await resolveCost(deps, call, answers.usage);

    await logCall(deps, call, 200, tokens);
    await deps
      .saveRequestUsage({
        provider: call.provider,
        model: call.canonicalModel,
        tokens,
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
  } catch (error) {
    if (options.signal?.aborted) {
      // The client hung up: nothing was learned about the account's health.
      return errorResponse(499, "System One request aborted by caller");
    }
    const timedOut = timeoutSignal.aborted;
    const status = timedOut ? 504 : 502;
    const message = timedOut
      ? "System One request timed out"
      : sanitizeErrorMessage(error) || "System One request failed";
    await logCall(deps, call, status, tokenCounts(null, null), message);
    await coolDown(deps, call, status, message);
    return errorResponse(status, message);
  }
}
