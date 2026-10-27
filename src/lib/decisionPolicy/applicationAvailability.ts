import type {
  Candidate,
  CandidateState,
} from "../../../open-sse/services/decisionPolicy/contract.ts";
import {
  getRuntimeProviderProfile,
  isAccountUnavailable,
  isModelLocked,
} from "../../../open-sse/services/accountFallback.ts";
import { getCreditsMode } from "../../../open-sse/services/antigravityCredits.ts";
import { isQuotaExhaustedForRequest } from "../../domain/quotaCache";
import { evaluateQuotaLimitPolicy } from "../../sse/services/auth";
import { resolveProviderId } from "../../shared/constants/providers";
import { getCircuitBreaker } from "../../shared/utils/circuitBreaker";
import {
  toProviderConnection,
  type ProviderConnectionView,
} from "../db/providers/lazyConnectionView";

/** Local preflight facts only. No credential selection, refresh, probe or physical attempt.
 * A positive/absent cached observation is not proof of available quota. */
function applicationCandidateHealth(
  candidate: Candidate,
  connection: ProviderConnectionView | null | undefined,
  providerBlocked: boolean
): Pick<CandidateState, "available" | "quota" | "availabilityReason"> {
  if (!connection || connection.provider !== candidate.provider)
    return { available: false, quota: "unknown" };
  const provider = resolveProviderId(candidate.provider);
  const terminal = ["banned", "expired", "credits_exhausted"].includes(
    connection.testStatus?.trim().toLowerCase() ?? ""
  );
  const cooldown = isAccountUnavailable(connection.rateLimitedUntil);
  const modelLocked = isModelLocked(provider, connection.id, candidate.model);
  // Match credential selection's explicit credits-first policy; never activate it here.
  const bypassQuota = provider === "antigravity" && getCreditsMode() === "always";
  const quotaBlocked =
    !bypassQuota &&
    (isQuotaExhaustedForRequest(
      connection.id,
      provider,
      candidate.model,
      connection.providerSpecificData
    ) ||
      evaluateQuotaLimitPolicy(provider, connection, candidate.model).blocked);
  const failures: Array<[boolean, NonNullable<CandidateState["availabilityReason"]>]> = [
    [providerBlocked, "provider_breaker_unavailable"],
    [terminal, "connection_terminal"],
    [cooldown, "connection_cooldown"],
    [modelLocked, "model_lockout"],
  ];
  const availabilityReason = failures.find(([blocked]) => blocked)?.[1];
  return {
    available: connection.isActive === true && availabilityReason === undefined,
    quota: quotaBlocked ? "exhausted" : "unknown",
    ...(availabilityReason ? { availabilityReason } : {}),
  };
}

/** One configured, lazy breaker read per provider; canExecute does not reserve a probe. */
export async function createApplicationHealthReader(candidates: readonly Candidate[]) {
  const blocked = new Map<string, boolean>();
  for (const candidate of candidates) {
    const provider = resolveProviderId(candidate.provider);
    if (blocked.has(provider)) continue;
    const profile = await getRuntimeProviderProfile(provider);
    const breaker = getCircuitBreaker(provider, {
      failureThreshold: profile.failureThreshold ?? profile.circuitBreakerThreshold,
      degradationThreshold: profile.degradationThreshold,
      resetTimeout: profile.resetTimeoutMs ?? profile.circuitBreakerReset,
    });
    blocked.set(provider, !breaker.canExecute());
  }
  return (candidate: Candidate, connection: unknown) =>
    applicationCandidateHealth(
      candidate,
      connection == null ? null : toProviderConnection(connection),
      blocked.get(resolveProviderId(candidate.provider)) ?? true
    );
}
