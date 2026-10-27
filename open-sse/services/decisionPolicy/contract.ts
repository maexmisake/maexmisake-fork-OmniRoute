import { z } from "zod";
import { TASK_DIFFICULTY_LEVELS } from "./taskDifficulty.ts";

const knownFlag = z.boolean().nullable();
const effortName = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const candidateSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,80}$/)
      .refine((id) => id !== "__proto__", "Reserved candidate ID"),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    endpointKind: z.enum(["direct", "router", "unknown"]),
    evidence: z.string().min(1).max(500).nullable(),
    // Operator preference text for the selector, never inferred capability or a client override.
    selectionGuidance: z.string().trim().min(1).max(1000).optional(),
    capabilities: z
      .object({
        text: knownFlag,
        images: knownFlag,
        tools: knownFlag,
        reasoning: knownFlag,
        contextTokens: z.number().int().positive().nullable(),
      })
      .strict(),
    effort: z
      .object({
        mode: z.enum(["preserve", "set", "fixed"]),
        value: effortName.nullable(),
        supported: z.array(effortName).max(7).nullable(),
        evidence: z.string().min(1).max(500).nullable(),
      })
      .strict(),
  })
  .strict();
export const policySchema = z
  .object({
    version: z.literal(1),
    candidates: z.array(candidateSchema).max(255),
    // Explicit task preference orders, never inferred from historical benchmark scores/cost.
    taskOrder: z.record(z.string().min(1).max(100), z.array(z.string()).max(255)),
    unknownQuota: z.enum(["reject", "allow"]),
    decisionFailure: z.enum(["stop", "deterministic"]),
    maxDecisionAttempts: z.number().int().min(0).max(3),
    maxExecutionAttempts: z.number().int().min(1).max(5),
    timeoutMs: z.number().int().min(1).max(30000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.candidates.map((candidate) => candidate.id));
    // Exact application bindings additionally include the configured connection.
    // Separate IDs may intentionally represent one model/effort on different accounts.
    if (ids.size !== value.candidates.length)
      ctx.addIssue({ code: "custom", message: "Duplicate candidate ID" });
    for (const order of Object.values(value.taskOrder)) {
      if (new Set(order).size !== order.length || order.some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", message: "Invalid task preference order" });
    }
  });
export const requestSchema = z
  .object({
    task: z.string().min(1).max(100),
    // Optional trusted local heuristic. A raw HTTP body cannot set this field.
    difficulty: z.enum(TASK_DIFFICULTY_LEVELS).optional(),
    contextTokens: z.number().int().min(0),
    images: z.boolean(),
    tools: z.boolean(),
    reasoning: z.boolean(),
    // Trusted caller classifies task facts; client text is never an authorization source.
    clientEffort: effortName.nullable(),
    continuationCandidateId: z.string().nullable(),
    routingDepth: z.number().int().min(0),
    // Bounded local metadata plus at most 2,048 explicitly consented task characters.
    state: z.string().max(16384),
  })
  .strict();
export type PolicyConfig = z.infer<typeof policySchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type PolicyRequest = z.infer<typeof requestSchema>;
export type CandidateState = {
  authorized: boolean | null;
  available: boolean | null;
  quota: "available" | "exhausted" | "unknown";
  availabilityReason?:
    | "provider_breaker_unavailable"
    | "connection_terminal"
    | "connection_cooldown"
    | "model_lockout";
};
export type Snapshot = Readonly<Record<string, CandidateState | undefined>>;
export type Trace = { phase: string; id?: string; reason: string };
export type Cost = { reportedUsd: number; unknownAttempts: number; totalUsd: number | null };
export type LedgerEntry = {
  lane: "decision" | "execution";
  id: string;
  status: string;
  costUsd: number | null;
};
export type DecisionOutcome = {
  status: "selected" | "refused" | "unknown" | "invalid" | "retryable" | "auth" | "denied";
  optionId?: string;
  confidence?: number | null;
  probabilities?: Record<string, number> | null;
  costUsd: number | null;
};
export type DecisionClient = {
  id: string;
  // One physical call, already authorized for this provider; never an OmniRoute combo.
  select: (
    options: readonly Candidate[],
    request: PolicyRequest,
    signal: AbortSignal
  ) => Promise<DecisionOutcome>;
};
export type ExecutionOutcome = {
  committed: boolean;
  status: "success" | "retryable" | "terminal" | "auth";
  costUsd: number | null;
  // Executor must assert exact target after formatting/sanitizing, BEFORE physical dispatch.
  actual: { provider: string; model: string; effort: string | null };
};
export type PolicyDeps = {
  snapshot: (signal: AbortSignal) => Promise<Snapshot>;
  decisionClients?: readonly DecisionClient[];
  execute: (candidate: Candidate, signal: AbortSignal) => Promise<ExecutionOutcome>;
};
export type PolicyResult = {
  status:
    | "success"
    | "invalid_config"
    | "invalid_request"
    | "no_route"
    | "decision_stopped"
    | "execution_failed"
    | "cancelled"
    | "timeout";
  selectedId: string | null;
  trace: Trace[];
  ledger: LedgerEntry[];
  decisions: Array<{
    clientId: string;
    status: string;
    optionId: string | null;
    confidence: number | null;
    probabilities: Record<string, number> | null;
  }>;
  costs: { decision: Cost; execution: Cost; total: Cost };
};
