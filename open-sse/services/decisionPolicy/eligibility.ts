import type {
  Candidate,
  CandidateState,
  PolicyConfig,
  PolicyRequest,
  Snapshot,
  Trace,
} from "./contract.ts";

function effortExclusions(candidate: Candidate, request: PolicyRequest): string[] {
  const reasons: string[] = [];
  const effort = candidate.effort;
  if (
    effort.mode !== "preserve" &&
    (!effort.evidence || effort.value === null || !effort.supported?.includes(effort.value))
  )
    reasons.push("effort_unproven");
  if (effort.mode === "preserve" && effort.value !== null) reasons.push("invalid_preserved_effort");
  if (
    request.reasoning &&
    (candidate.capabilities.reasoning !== true || effort.value === null || effort.value === "none")
  )
    reasons.push("reasoning_effort_required");
  if (request.clientEffort !== null && request.clientEffort !== effort.value)
    reasons.push("client_effort_mismatch");
  return reasons;
}

function healthExclusions(state: CandidateState | undefined, config: PolicyConfig): string[] {
  const reasons: string[] = [];
  if (state?.authorized !== true) reasons.push("unauthorized_or_unknown");
  if (state?.available !== true) reasons.push("unavailable_or_unknown");
  if (state?.quota === "exhausted") reasons.push("quota_exhausted");
  if (
    (!state || !["available", "exhausted"].includes(state.quota)) &&
    config.unknownQuota === "reject"
  )
    reasons.push("quota_unknown");
  return reasons;
}
function capabilityExclusions(candidate: Candidate, request: PolicyRequest): string[] {
  const reasons: string[] = [];
  const caps = candidate.capabilities;
  if (caps.text !== true) reasons.push("text_unproven");
  if (request.images && caps.images !== true) reasons.push("images_unproven");
  if (request.tools && caps.tools !== true) reasons.push("tools_unproven");
  if (caps.contextTokens === null || request.contextTokens > caps.contextTokens)
    reasons.push("context_unproven_or_exceeded");
  return reasons;
}

/** Missing evidence is never transformed into capability or authorization. */
export function exclusionReasons(
  candidate: Candidate,
  request: PolicyRequest,
  config: PolicyConfig,
  snapshot: Snapshot
): string[] {
  const reasons: string[] = [];
  const state = Object.hasOwn(snapshot, candidate.id) ? snapshot[candidate.id] : undefined;
  if (request.routingDepth !== 0 || candidate.endpointKind !== "direct")
    reasons.push("recursion_unproven");
  if (!candidate.evidence) reasons.push("profile_unverified");
  reasons.push(...healthExclusions(state, config));
  reasons.push(...capabilityExclusions(candidate, request));
  reasons.push(...effortExclusions(candidate, request));
  if (request.continuationCandidateId !== null && request.continuationCandidateId !== candidate.id)
    reasons.push("continuation_pin");
  return reasons;
}

export function eligibleCandidates(
  config: PolicyConfig,
  request: PolicyRequest,
  snapshot: Snapshot,
  trace: Trace[]
): Candidate[] {
  const order = Object.hasOwn(config.taskOrder, request.task) ? config.taskOrder[request.task] : [];
  const byId = new Map(config.candidates.map((candidate) => [candidate.id, candidate]));
  const eligible: Candidate[] = [];
  for (const candidate of config.candidates) {
    const reasons = exclusionReasons(candidate, request, config, snapshot);
    if (!order.includes(candidate.id)) reasons.push("task_preference_unresolved");
    trace.push({ phase: "eligibility", id: candidate.id, reason: reasons.join(",") || "eligible" });
  }
  for (const id of order) {
    const candidate = byId.get(id)!;
    if (!exclusionReasons(candidate, request, config, snapshot).length) eligible.push(candidate);
  }
  return eligible;
}
