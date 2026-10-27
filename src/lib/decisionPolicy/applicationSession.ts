import type { AutomaticPlan } from "./applicationCombo";
import { claimRoutingSession, type SessionClaim } from "../db/decisionSessions";

export type SessionInput = { locator: string; boundary: boolean };
export function parseApplicationSession(
  headers: Headers,
  enabled: boolean
): SessionInput | undefined {
  const locator = headers.get("x-omniroute-routing-session");
  const boundary = headers.get("x-omniroute-task-boundary");
  if (locator === null && boundary === null) return;
  if (
    !enabled ||
    !locator ||
    (locator !== "new" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(locator)) ||
    (boundary !== null && boundary !== "new-task")
  )
    throw new Error("decision_session_rejected");
  return { locator, boundary: boundary === "new-task" };
}
export function prepareApplicationSession(
  plan: AutomaticPlan,
  keyId: string
): SessionClaim | undefined {
  if (!plan.sessionInput || !plan.config.sessions) return;
  return claimRoutingSession({
    locator: plan.sessionInput.locator,
    keyId,
    comboId: plan.comboId,
    policy: plan.sourcePolicy,
    limits: plan.config.sessions,
    timeoutMs: plan.config.policy.timeoutMs,
  });
}
export function retainSessionPin(plan: AutomaticPlan, claim?: SessionClaim): boolean {
  return (
    !!claim?.binding &&
    (!plan.sessionInput?.boundary || claim.stableTurns < plan.config.sessions!.minStableTurns)
  );
}
