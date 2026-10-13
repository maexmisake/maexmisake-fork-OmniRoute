/**
 * System One candidate dispatch — the attempt loop behind `POST /v1/systemone`.
 *
 * The route resolves a client model id into ordered candidates
 * (`resolveSystemOneCandidates`); this module decides, between credential
 * spends, which candidate and which connection to try next, and it is the only
 * place where a decision request could cross an account, a provider or a
 * free/paid tier boundary. Two bounded loops, outer-last:
 *
 *   for each candidate (bounded by SYSTEMONE_MAX_FALLBACK_CANDIDATES)
 *     for each connection (bounded by SYSTEMONE_MAX_CONNECTION_ATTEMPTS)
 *
 * so a retryable failure first rotates to another account of the same provider —
 * cheapest, same contract, same price — and only a bare alias then crosses to
 * another backend. A provider-qualified id and a free-tier alias resolve to a
 * single candidate upstream of here, which is what makes "pinned never crosses
 * providers" and "a free alias never reaches a paid backend" structural rather
 * than a rule this loop has to remember.
 *
 * Fallback is deliberately narrow: only a status that says something about the
 * ACCOUNT (401/402/403/429) or the upstream's availability (408, 5xx except
 * 501/502) is retried. A caller-fault status would repeat on every account, and
 * `handleSystemOneProxy` maps both a contract-violating success body and a
 * transport failure onto 502 — indistinguishable from out here, so 502 fails
 * closed instead of spending more credentials on a request that cannot succeed.
 *
 * Every collaborator is injected: the route binds the real credential selector,
 * proxy and key-policy check, and the tests drive the loop with fakes. Nothing
 * here logs a request body — a decision `state` is routinely operator data.
 */

import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import {
  handleSystemOneProxy,
  type SystemOneProxyOptions,
} from "@omniroute/open-sse/handlers/systemOne.ts";
import {
  SYSTEMONE_MAX_FALLBACK_CANDIDATES,
  type SystemOneCandidate,
} from "@omniroute/open-sse/config/systemOneRegistry.ts";
import {
  validateSystemOneBackendBody,
  type SystemOneValidation,
} from "@omniroute/open-sse/services/typesafe/systemOneAnswers.ts";
import {
  clearRecoveredProviderState,
  getProviderCredentialsWithQuotaPreflight,
} from "@/sse/services/auth";
import * as log from "@/sse/utils/logger";

/**
 * Connections tried per candidate before moving on. A decision call is cheap
 * and idempotent, so rotating is safe, but an unbounded rotation would turn one
 * client request into a scan of every key the operator owns.
 */
export const SYSTEMONE_MAX_CONNECTION_ATTEMPTS = 3;

export type SystemOneCredentialSelection = {
  provider: string;
  /** Upstream model id — quota preflight scopes per-model cutoffs by it. */
  model: string;
  /** The calling key's connection allowlist, or null when it has none. */
  allowedConnections: string[] | null;
  /** Connections already attempted for this candidate. */
  excludeConnectionIds: string[];
};

export type SystemOneDispatchDeps = {
  selectCredentials: (selection: SystemOneCredentialSelection) => Promise<unknown>;
  dispatch: (options: SystemOneProxyOptions) => Promise<Response>;
  clearRecoveredProviderState: (credentials: unknown) => Promise<unknown>;
  /** Re-checks the key's model rules for one candidate's canonical id. */
  validateRoutingTarget: (canonicalModel: string) => Promise<Response | null>;
  validateBackendBody: (provider: string, body: Record<string, unknown>) => SystemOneValidation;
};

export const defaultSystemOneDispatchDeps: SystemOneDispatchDeps = {
  selectCredentials: ({ provider, model, allowedConnections, excludeConnectionIds }) =>
    getProviderCredentialsWithQuotaPreflight(provider, null, allowedConnections, model, {
      excludeConnectionIds,
    }),
  dispatch: (options) => handleSystemOneProxy(options),
  clearRecoveredProviderState: (credentials) => clearRecoveredProviderState(credentials),
  // No key policy by default: a keyless (local/session) request has no rules to
  // re-check, and the route injects the real check whenever a key is present.
  validateRoutingTarget: async () => null,
  validateBackendBody: validateSystemOneBackendBody,
};

export type SystemOneDispatchInput = {
  candidates: readonly SystemOneCandidate[];
  /** Validated request envelope; `model` is replaced per candidate. */
  body: Record<string, unknown>;
  /** What the client asked for, kept for the call log. */
  requestedModel: string;
  allowedConnections?: string[] | null;
  apiKeyInfo?: { id?: string | null; name?: string | null } | null;
  correlationId?: string | null;
  signal?: AbortSignal;
};

/**
 * Whether another account (or another backend) is worth trying after this
 * status. See the module header for why 501/502 are excluded from the 5xx rule.
 */
export function isRetryableSystemOneStatus(status: number): boolean {
  if (status === 501 || status === 502) return false;
  if (status >= 500) return true;
  return (
    status === HTTP_STATUS.UNAUTHORIZED ||
    status === HTTP_STATUS.PAYMENT_REQUIRED ||
    status === HTTP_STATUS.FORBIDDEN ||
    status === HTTP_STATUS.REQUEST_TIMEOUT ||
    status === HTTP_STATUS.RATE_LIMITED
  );
}

function connectionIdOf(credentials: unknown): string | null {
  const id = (credentials as { connectionId?: unknown } | null)?.connectionId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Translate a non-credential selector answer into the response the client
 * should get for it, or `null` when the selection is usable.
 *
 * The selector returns a truthy diagnostic sentinel instead of credentials when
 * every connection of the provider is unusable (#13945), so a plain truthiness
 * test here would dispatch a request with no account at all.
 */
function describeUnusableSelection(provider: string, credentials: unknown): Response | null {
  if (isAllRateLimitedCredentials(credentials)) {
    return rateLimitedProviderResponse(provider, credentials);
  }
  if (!credentials || typeof credentials !== "object") {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `No active ${provider} connection is available for System One`
    );
  }

  const record = credentials as Record<string, unknown>;
  if (record.allExpired) {
    const status = typeof record.expiredStatus === "string" ? record.expiredStatus : "expired";
    const count = typeof record.expiredCount === "number" ? record.expiredCount : 1;
    // Credits exhausted is quota (402), not a broken credential (#12441).
    return status === "credits_exhausted"
      ? errorResponse(
          HTTP_STATUS.PAYMENT_REQUIRED,
          `[${provider}] All ${count} connection(s) have exhausted their credits`
        )
      : errorResponse(
          HTTP_STATUS.UNAUTHORIZED,
          `[${provider}] All ${count} connection(s) need to be reconnected in the dashboard`
        );
  }
  if (record.blockedByKeyPolicy) {
    const count = typeof record.blockedCount === "number" ? record.blockedCount : 1;
    return errorResponse(
      HTTP_STATUS.FORBIDDEN,
      `[${provider}] ${count} connection(s) exist but are excluded by this API key's connection allowlist / quota scope`
    );
  }
  if (record.leaseConnectionMismatch || record.leaseFenceStale || record.leaseRequired) {
    return errorResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `[${provider}] The exclusive connection lease for this request is no longer valid`
    );
  }
  if (record.waitingForCapacity) {
    return errorResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `[${provider}] Every eligible connection is leased by another request`
    );
  }
  return null;
}

type Outcome = {
  /** Last answer from an upstream attempt — preferred over a diagnostic. */
  upstream: Response | null;
  /** Last reason a candidate never reached an upstream. */
  diagnostic: Response | null;
};

/**
 * Run one candidate's bounded connection rotation.
 *
 * Returns a terminal `Response` (success, or a failure no other candidate can
 * improve on) or `null` to let the caller try the next candidate.
 */
async function attemptCandidate(
  candidate: SystemOneCandidate,
  input: SystemOneDispatchInput,
  deps: SystemOneDispatchDeps,
  outcome: Outcome
): Promise<Response | null> {
  const body = { ...input.body, model: candidate.model };
  const limits = deps.validateBackendBody(candidate.provider, body);
  if (!limits.ok) {
    // A request shape this backend refuses is the caller's: another account or
    // backend would refuse the same bytes.
    return errorResponse(limits.status, limits.message);
  }

  const attempted = new Set<string>();
  for (let attempt = 0; attempt < SYSTEMONE_MAX_CONNECTION_ATTEMPTS; attempt++) {
    const credentials = await deps.selectCredentials({
      provider: candidate.provider,
      model: candidate.model,
      allowedConnections: input.allowedConnections ?? null,
      excludeConnectionIds: [...attempted],
    });

    const unusable = describeUnusableSelection(candidate.provider, credentials);
    if (unusable) {
      outcome.diagnostic = unusable;
      return null;
    }

    const connectionId = connectionIdOf(credentials);
    // A selector that ignored the exclusion list would otherwise re-dispatch to
    // the account that just failed until the attempt budget ran out.
    if (connectionId && attempted.has(connectionId)) return null;
    if (connectionId) attempted.add(connectionId);

    const response = await deps.dispatch({
      provider: candidate.provider,
      body,
      canonicalModel: candidate.canonicalModel,
      requestedModel: input.requestedModel,
      tier: candidate.tier,
      credentials: credentials as SystemOneProxyOptions["credentials"],
      apiKeyInfo: input.apiKeyInfo ?? null,
      correlationId: input.correlationId ?? null,
      signal: input.signal,
    });

    if (response.ok) {
      await deps.clearRecoveredProviderState(credentials).catch(() => {
        // Recovery bookkeeping must never fail a successful decision.
      });
      return response;
    }
    if (!isRetryableSystemOneStatus(response.status)) return response;

    outcome.upstream = response;
    log.warn("SYSTEMONE", "Decision attempt failed; considering another account", {
      provider: candidate.provider,
      model: candidate.canonicalModel,
      status: response.status,
      ...(connectionId ? { connectionId } : {}),
    });
    // Nothing identifies the account that just failed, so there is nothing to
    // exclude and the selector would return it again.
    if (!connectionId) return null;
  }
  return null;
}

/**
 * Dispatch a validated System One request across its resolved candidates.
 *
 * Returns the first successful decision, or the most informative failure: the
 * last real upstream answer (which carries its own `Retry-After`) in preference
 * to a selector diagnostic, mirroring the chat path's credential-exhaustion
 * handling in `src/sse/handlers/chatHelpers.ts::handleNoCredentials`.
 */
export async function dispatchSystemOne(
  input: SystemOneDispatchInput,
  overrides: Partial<SystemOneDispatchDeps> = {}
): Promise<Response> {
  const deps: SystemOneDispatchDeps = { ...defaultSystemOneDispatchDeps, ...overrides };
  const candidates = input.candidates.slice(0, SYSTEMONE_MAX_FALLBACK_CANDIDATES);
  const outcome: Outcome = { upstream: null, diagnostic: null };

  for (const candidate of candidates) {
    // Routing may have widened the key's access: the request-level policy saw
    // the client's id (a bare alias), so each candidate is re-checked against
    // the canonical `<provider>/<model>` id before a credential is selected.
    const rejection = await deps.validateRoutingTarget(candidate.canonicalModel);
    if (rejection) {
      outcome.diagnostic = rejection;
      continue;
    }

    const response = await attemptCandidate(candidate, input, deps, outcome);
    if (response) return response;
  }

  return (
    outcome.upstream ??
    outcome.diagnostic ??
    errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `No System One backend is available for ${input.requestedModel}`
    )
  );
}
