import { setTimeout as delay } from "node:timers/promises";
import type { Candidate } from "../../../open-sse/services/decisionPolicy/contract.ts";
import type { CompletedExecutionRejection } from "../../../open-sse/services/decisionPolicy/retryPolicy.ts";
import { executionRetryScopeAllows } from "../../../open-sse/services/decisionPolicy/retryPolicy.ts";
import type { AutomaticPlan } from "./applicationCombo";
import type { ApplicationAttempt } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import type { AttemptIdentity } from "../db/decisionAttempts";
import { finishDecisionApplication } from "../db/decisionAttempts";
import type { Trace } from "../../../open-sse/services/decisionPolicy/contract.ts";

export type RetryReservation = {
  previous: AttemptIdentity;
  failure: CompletedExecutionRejection;
  maxAttempts: number;
};
type OwnedAttempt = ApplicationAttempt & AttemptIdentity;

export function retryTargetMatchesScope(
  plan: AutomaticPlan,
  from: Candidate,
  to: Candidate,
  failure: CompletedExecutionRejection
): boolean {
  return executionRetryScopeAllows(
    failure.scope,
    { ...from, connectionId: plan.config.connections[from.id] },
    { ...to, connectionId: plan.config.connections[to.id] }
  );
}
/** No ambient alternatives, no second decision, no replay of a started unknown outcome.
 * Eligibility is obtained after any Retry-After wait, under the same caller deadline. */
export async function nextApplicationRetry(input: {
  plan: AutomaticPlan;
  from: Candidate;
  failure: CompletedExecutionRejection | null;
  attempted: ReadonlySet<string>;
  deadlineAt: number;
  signal: AbortSignal;
  continuation: boolean;
  eligible: () => Promise<Candidate[]>;
}): Promise<Candidate | null> {
  const { plan, failure, signal } = input;
  signal.throwIfAborted();
  if (
    !failure ||
    input.continuation ||
    !plan.config.retry ||
    input.attempted.size >= plan.config.policy.maxExecutionAttempts ||
    failure.retryAt >= input.deadlineAt
  )
    return null;
  const transitions = plan.config.retry.transitions.filter(
    (rule) =>
      rule.from === input.from.id &&
      rule.scopes.includes(failure.scope) &&
      !input.attempted.has(rule.to)
  );
  if (!transitions.length) return null;
  const wait = failure.retryAt - Date.now();
  if (wait > 0) await delay(wait, undefined, { signal });
  signal.throwIfAborted();
  const candidates = await input.eligible();
  signal.throwIfAborted();
  for (const rule of transitions) {
    const candidate = candidates.find((item) => item.id === rule.to);
    if (candidate && retryTargetMatchesScope(plan, input.from, candidate, failure))
      return candidate;
  }
  return null;
}

export async function runApplicationAttempts(input: {
  plan: AutomaticPlan;
  initial: Candidate;
  signal: AbortSignal;
  deadlineAt: number;
  continuation: boolean;
  trace: Trace[];
  eligible: () => Promise<Candidate[]>;
  build: (candidate: Candidate, retry?: RetryReservation) => Promise<OwnedAttempt>;
  dispatch: (candidate: Candidate, attempt: OwnedAttempt) => Promise<Response>;
  capture: (attempt: OwnedAttempt) => void;
  acknowledge?: (attempt: OwnedAttempt, failure: CompletedExecutionRejection) => void;
}) {
  const attempted = new Set<string>();
  let candidate = input.initial;
  let retry: RetryReservation | undefined;
  while (true) {
    input.signal.throwIfAborted();
    const attempt = await input.build(candidate, retry);
    input.capture(attempt);
    attempted.add(candidate.id);
    const response = await input.dispatch(candidate, attempt);
    input.signal.throwIfAborted();
    const failure = attempt.rejection?.() ?? null;
    if (response.ok || !failure || response.status !== failure.status || attempt.stream?.active)
      return { response, attempt, candidate, attempts: attempted.size };
    finishDecisionApplication(attempt.id, response.status);
    const next = await nextApplicationRetry({ ...input, from: candidate, failure, attempted });
    if (!next) return { response, attempt, candidate, attempts: attempted.size };
    input.acknowledge?.(attempt, failure);
    void response.body?.cancel().catch(() => {});
    attempt.release?.();
    input.trace.push({
      phase: "retry",
      id: next.id,
      reason: `configured_${failure.scope.replaceAll("-", "_")}`,
    });
    retry = {
      previous: attempt,
      failure,
      maxAttempts: input.plan.config.policy.maxExecutionAttempts,
    };
    candidate = next;
  }
}
