import type {
  Candidate,
  DecisionOutcome,
  PolicyConfig,
  PolicyRequest,
  Snapshot,
} from "../../../open-sse/services/decisionPolicy/contract.ts";

const candidate = (
  id: string,
  effort: "none" | "medium" | "high",
  tokens: number,
  images = false,
  tools = false
): Candidate => ({
  id,
  provider: "synthetic",
  model: id.startsWith("code") ? "code-model" : id,
  endpointKind: "direct",
  evidence: "synthetic-fixture-v1; no provider evidence",
  capabilities: { text: true, reasoning: effort !== "none", images, tools, contextTokens: tokens },
  effort: {
    mode: "set",
    value: effort,
    supported: [effort],
    evidence: "synthetic exact-format contract",
  },
});
export const fixtureConfig: PolicyConfig = {
  version: 1,
  candidates: [
    candidate("basic", "none", 8000),
    candidate("code_high", "high", 128000, false, true),
    candidate("code_medium", "medium", 128000, false, true),
    candidate("multimodal", "high", 64000, true, true),
  ],
  taskOrder: {
    explanation: ["basic", "code_medium", "code_high", "multimodal"],
    complex_code: ["code_high", "code_medium", "multimodal", "basic"],
    long_context: ["code_high", "code_medium", "multimodal", "basic"],
    image: ["multimodal", "code_high", "basic"],
    tools: ["code_high", "multimodal", "basic"],
    continuation: ["basic", "code_medium", "code_high", "multimodal"],
  },
  unknownQuota: "reject",
  decisionFailure: "stop",
  maxDecisionAttempts: 2,
  maxExecutionAttempts: 2,
  timeoutMs: 1000,
};
export const fixtureRequest: PolicyRequest = {
  task: "explanation",
  contextTokens: 100,
  images: false,
  tools: false,
  reasoning: false,
  clientEffort: null,
  continuationCandidateId: null,
  routingDepth: 0,
  state: "Synthetic task. No user prompt, credentials or private configuration.",
};
export const fixtureSnapshot: Snapshot = Object.fromEntries(
  fixtureConfig.candidates.map((c) => [
    c.id,
    {
      authorized: true,
      available: true,
      quota: "available",
    },
  ])
);
export type Scenario = {
  id: string;
  expected: string;
  selected?: string | null;
  request?: Partial<PolicyRequest>;
  states?: Snapshot;
  decision?: DecisionOutcome[];
  executions?: Array<"success" | "retryable" | "auth" | "terminal">;
  config?: Partial<PolicyConfig>;
};
export const scenarios: Scenario[] = [
  { id: "simple_explanation_without_forced_thinking", expected: "success", selected: "basic" },
  {
    id: "complex_code_reasoning",
    expected: "success",
    selected: "code_high",
    request: { task: "complex_code", reasoning: true },
  },
  {
    id: "long_context",
    expected: "success",
    selected: "code_high",
    request: { task: "long_context", contextTokens: 100000 },
  },
  {
    id: "image_requirement",
    expected: "success",
    selected: "multimodal",
    request: { task: "image", images: true },
  },
  {
    id: "tools_requirement",
    expected: "success",
    selected: "code_high",
    request: { task: "tools", tools: true },
  },
  {
    id: "tool_continuation_pin",
    expected: "success",
    selected: "code_medium",
    request: { task: "continuation", tools: true, continuationCandidateId: "code_medium" },
  },
  {
    id: "unavailable_first_choice",
    expected: "success",
    selected: "code_medium",
    states: { basic: { authorized: true, available: false, quota: "available" } },
  },
  {
    id: "unknown_quota_rejected",
    expected: "success",
    selected: "code_medium",
    states: { basic: { authorized: true, available: true, quota: "unknown" } },
  },
  {
    id: "unknown_quota_explicitly_allowed",
    expected: "success",
    selected: "basic",
    config: { unknownQuota: "allow" },
    states: { basic: { authorized: true, available: true, quota: "unknown" } },
  },
  {
    id: "unknown_permissions_never_allowed",
    expected: "success",
    selected: "code_medium",
    config: { unknownQuota: "allow" },
    states: { basic: { authorized: null, available: true, quota: "unknown" } },
  },
  {
    id: "unknown_task_is_unresolved",
    expected: "no_route",
    selected: null,
    request: { task: "unresolved" },
  },
  {
    id: "no_eligible_context",
    expected: "no_route",
    selected: null,
    request: { contextTokens: 1000000 },
  },
  { id: "recursion_rejected", expected: "no_route", selected: null, request: { routingDepth: 1 } },
  {
    id: "continuation_cannot_switch",
    expected: "no_route",
    selected: null,
    request: { continuationCandidateId: "absent" },
  },
  {
    id: "respect_client_effort",
    expected: "success",
    selected: "code_medium",
    request: { clientEffort: "medium" },
  },
  {
    id: "unsupported_client_effort",
    expected: "no_route",
    selected: null,
    request: { clientEffort: "max" },
  },
  {
    id: "decision_refused",
    expected: "decision_stopped",
    selected: null,
    decision: [{ status: "refused", costUsd: 0.001 }],
  },
  {
    id: "decision_unknown",
    expected: "decision_stopped",
    selected: null,
    decision: [{ status: "unknown", costUsd: null }],
  },
  {
    id: "decision_invalid_offered_option",
    expected: "decision_stopped",
    selected: null,
    decision: [{ status: "selected", optionId: "unauthorized", costUsd: 0 }],
  },
  {
    id: "decision_auth_no_identity_rotation",
    expected: "decision_stopped",
    selected: null,
    decision: [
      { status: "auth", costUsd: 0 },
      { status: "selected", optionId: "basic", costUsd: 0 },
    ],
  },
  {
    id: "decision_provider_failover_separate",
    expected: "success",
    selected: "code_high",
    decision: [
      { status: "retryable", costUsd: 0.001 },
      {
        status: "selected",
        optionId: "code_high",
        confidence: 1,
        probabilities: { basic: 0, code_high: 1, code_medium: 0, multimodal: 0 },
        costUsd: 0.002,
      },
    ],
  },
  {
    id: "explicit_deterministic_failure_policy",
    expected: "success",
    selected: "basic",
    config: { decisionFailure: "deterministic" },
    decision: [{ status: "unknown", costUsd: null }],
  },
  {
    id: "execution_failover_accounted",
    expected: "success",
    selected: "code_medium",
    executions: ["retryable", "success"],
  },
  {
    id: "execution_attempt_limit",
    expected: "execution_failed",
    selected: "basic",
    config: { maxExecutionAttempts: 1 },
    executions: ["retryable", "success"],
  },
  {
    id: "execution_auth_is_terminal",
    expected: "execution_failed",
    selected: "basic",
    executions: ["auth", "success"],
  },
];
