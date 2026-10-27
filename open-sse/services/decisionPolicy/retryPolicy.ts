import { z } from "zod";
import type { PolicyConfig } from "./contract.ts";

export const executionFailureScopeSchema = z.enum([
  "account-quota",
  "account-rate-limit",
  "model-unavailable",
  "provider-unavailable",
]);
export type ExecutionFailureScope = z.infer<typeof executionFailureScopeSchema>;
export type CompletedExecutionRejection = {
  scope: ExecutionFailureScope;
  status: number;
  retryAt: number;
};
export const applicationRetrySchema = z
  .object({
    transitions: z
      .array(
        z
          .object({
            from: z.string().min(1).max(80),
            to: z.string().min(1).max(80),
            scopes: z.array(executionFailureScopeSchema).min(1).max(4),
          })
          .strict()
      )
      .min(1)
      .max(64),
  })
  .strict();
export type ApplicationRetryPolicy = z.infer<typeof applicationRetrySchema>;
type RetryTarget = { provider: string; model: string; connectionId: string };
export function executionRetryScopeAllows(
  scope: ExecutionFailureScope,
  from: RetryTarget,
  to: RetryTarget
) {
  if (scope.startsWith("account-")) return from.connectionId !== to.connectionId;
  if (scope === "model-unavailable")
    return from.provider !== to.provider || from.model !== to.model;
  return from.provider !== to.provider;
}
export function validApplicationRetry(
  policy: PolicyConfig,
  retry: ApplicationRetryPolicy | undefined,
  connections: Record<string, string>
): boolean {
  if (!retry) return policy.maxExecutionAttempts === 1;
  if (policy.maxExecutionAttempts < 2) return false;
  const seen = new Set<string>();
  for (const rule of retry.transitions) {
    const from = policy.candidates.find((candidate) => candidate.id === rule.from);
    const to = policy.candidates.find((candidate) => candidate.id === rule.to);
    const pair = JSON.stringify([rule.from, rule.to]);
    if (
      !from ||
      !to ||
      from.id === to.id ||
      seen.has(pair) ||
      !connections[from.id] ||
      !connections[to.id] ||
      new Set(rule.scopes).size !== rule.scopes.length ||
      !rule.scopes.every((scope) =>
        executionRetryScopeAllows(
          scope,
          { ...from, connectionId: connections[from.id] },
          { ...to, connectionId: connections[to.id] }
        )
      )
    )
      return false;
    seen.add(pair);
  }
  return true;
}

/** Closed error shapes only: a successful/partial output is never a rejection proof.
 * Missing billing remains unknown; this classifies completion, not price. */
function cleanRejectionBody(body: Record<string, unknown> | null): body is Record<string, unknown> {
  if (!body || ["choices", "output", "response", "content"].some((key) => key in body))
    return false;
  if (body.usage !== undefined) {
    if (!body.usage || typeof body.usage !== "object" || Array.isArray(body.usage)) return false;
    const usage = body.usage as Record<string, unknown>;
    if (
      ["completion_tokens", "output_tokens", "reasoning_tokens"].some(
        (key) => key in usage && usage[key] !== 0
      )
    )
      return false;
  }
  return true;
}
function accountFailureScope(
  error: Record<string, unknown>,
  provider?: string
): ExecutionFailureScope | null {
  const { code, scope, type } = error;
  if (scope !== undefined && scope !== "account") return null;
  if (provider === "claude" && type === "rate_limit_error") return "account-rate-limit";
  if (provider === "codex" && (type === "usage_limit_reached" || code === "usage_limit_reached"))
    return "account-quota";
  if (
    ["insufficient_quota", "quota_exceeded"].includes(String(code)) &&
    (scope === "account" || code === "insufficient_quota")
  )
    return "account-quota";
  return code === "rate_limit_exceeded" && scope === "account" ? "account-rate-limit" : null;
}
function rejectionScope(
  status: number,
  error: Record<string, unknown>,
  provider?: string
): ExecutionFailureScope | null {
  const { code, scope } = error;
  if (status === 429) return accountFailureScope(error, provider);
  if (status === 404 && code === "model_not_found" && (scope === undefined || scope === "model"))
    return "model-unavailable";
  if (
    [502, 503, 504].includes(status) &&
    ["server_error", "overloaded", "service_unavailable"].includes(String(code)) &&
    (scope === undefined || scope === "provider")
  )
    return "provider-unavailable";
  return null;
}
function rejectionRetryAt(retryAfter: string | null, now: number): number | null {
  if (retryAfter === null) return now;
  const trimmed = retryAfter.trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(trimmed);
  if (!seconds && !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed))
    return null;
  const wait = seconds ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(wait)) return null;
  return now + Math.max(0, wait);
}
export function completedExecutionRejection(
  status: number,
  body: Record<string, unknown> | null,
  retryAfter: string | null,
  now = Date.now(),
  provider?: string
): CompletedExecutionRejection | null {
  if (!cleanRejectionBody(body)) return null;
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const scope = rejectionScope(status, error as Record<string, unknown>, provider);
  const retryAt = rejectionRetryAt(retryAfter, now);
  return scope && retryAt !== null ? { scope, status, retryAt } : null;
}
