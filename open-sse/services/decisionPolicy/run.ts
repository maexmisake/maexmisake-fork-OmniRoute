import { policySchema, requestSchema } from "./contract.ts";
import type {
  Candidate,
  Cost,
  DecisionClient,
  DecisionOutcome,
  ExecutionOutcome,
  LedgerEntry,
  PolicyConfig,
  PolicyDeps,
  PolicyRequest,
  PolicyResult,
} from "./contract.ts";
import { eligibleCandidates, exclusionReasons } from "./eligibility.ts";

class BudgetStopped extends Error {}
function bounded<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new BudgetStopped());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new BudgetStopped());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new BudgetStopped();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function validCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function summarize(entries: LedgerEntry[]): Cost {
  const reportedUsd = entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const unknownAttempts = entries.filter((entry) => entry.costUsd === null).length;
  return { reportedUsd, unknownAttempts, totalUsd: unknownAttempts ? null : reportedUsd };
}
function validDistribution(
  probabilities: Record<string, number>,
  ids: string[],
  selected: string
): boolean {
  if (
    Object.keys(probabilities).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(probabilities, id))
  )
    return false;
  const values = Object.values(probabilities);
  return (
    values.every(
      (value) =>
        Number.isFinite(value) && value >= 0 && value <= 1 && value <= probabilities[selected]
    ) && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-6
  );
}
function validSelection(outcome: DecisionOutcome, options: Candidate[]): boolean {
  if (!options.some((option) => option.id === outcome.optionId)) return false;
  if (outcome.confidence == null || outcome.probabilities == null) return false;
  if (!Number.isFinite(outcome.confidence) || outcome.confidence < 0 || outcome.confidence > 1)
    return false;
  return validDistribution(
    outcome.probabilities,
    options.map((option) => option.id),
    outcome.optionId!
  );
}
function freezeProfiles(config: PolicyConfig, request: PolicyRequest): void {
  for (const candidate of config.candidates) {
    Object.freeze(candidate.capabilities);
    if (candidate.effort.supported) Object.freeze(candidate.effort.supported);
    Object.freeze(candidate.effort);
    Object.freeze(candidate);
  }
  Object.freeze(request);
}
function matchesActual(candidate: Candidate, actual: ExecutionOutcome["actual"]): boolean {
  return (
    !!actual &&
    actual.provider === candidate.provider &&
    actual.model === candidate.model &&
    actual.effort === candidate.effort.value
  );
}

/** Request-scoped bookkeeping. No transport, DB, shared state or external side effects. */
class PolicyRun {
  private trace: PolicyResult["trace"] = [];
  private ledger: LedgerEntry[] = [];
  private decisions: PolicyResult["decisions"] = [];
  private selectedId: string | null = null;
  private activeEntry: LedgerEntry | null = null;
  private signal: AbortSignal;

  constructor(
    private config: PolicyConfig,
    private request: PolicyRequest,
    private deps: PolicyDeps,
    private callerSignal?: AbortSignal
  ) {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    this.signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  }
  private checkAbort(): void {
    if (this.signal.aborted) throw new BudgetStopped();
  }
  private stopStatus(): "cancelled" | "timeout" {
    return this.callerSignal?.aborted ? "cancelled" : "timeout";
  }
  finish(status: PolicyResult["status"]): PolicyResult {
    return {
      status,
      selectedId: this.selectedId,
      trace: this.trace,
      ledger: this.ledger,
      decisions: this.decisions,
      costs: {
        decision: summarize(this.ledger.filter((entry) => entry.lane === "decision")),
        execution: summarize(this.ledger.filter((entry) => entry.lane === "execution")),
        total: summarize(this.ledger),
      },
    };
  }
  private begin(lane: LedgerEntry["lane"], id: string): void {
    this.activeEntry = { lane, id, status: "pending", costUsd: null };
    this.ledger.push(this.activeEntry);
  }
  private record(outcome: { status: string; costUsd: number | null }): void {
    this.activeEntry!.status = outcome.status;
    this.activeEntry!.costUsd = validCost(outcome.costUsd);
    this.checkAbort(); // Preserve known billing even when cancellation wins settlement.
  }
  private async decisionAttempt(
    client: DecisionClient,
    eligible: Candidate[]
  ): Promise<DecisionOutcome> {
    try {
      const outcome = await bounded(this.signal, () => {
        this.begin("decision", client.id);
        return client.select(Object.freeze([...eligible]), this.request, this.signal);
      });
      this.record(outcome);
      return outcome;
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.activeEntry!.status = "unknown";
      this.trace.push({ phase: "decision", id: client.id, reason: "exception_unknown_outcome" });
      return { status: "unknown", costUsd: null };
    }
  }
  private recordDecision(
    client: DecisionClient,
    outcome: DecisionOutcome,
    eligible: Candidate[]
  ): Candidate | undefined {
    let chosen: Candidate | undefined;
    if (outcome.status === "selected") {
      if (validSelection(outcome, eligible))
        chosen = eligible.find((candidate) => candidate.id === outcome.optionId);
      else
        this.activeEntry!.status =
          outcome.confidence == null || outcome.probabilities == null ? "unknown" : "invalid";
    }
    this.decisions.push({
      clientId: client.id,
      status: this.activeEntry!.status,
      optionId: chosen?.id ?? null,
      confidence: chosen ? outcome.confidence! : null,
      probabilities: chosen ? { ...outcome.probabilities! } : null,
    });
    this.trace.push({ phase: "decision", id: client.id, reason: this.activeEntry!.status });
    this.activeEntry = null;
    return chosen;
  }
  private async select(eligible: Candidate[]): Promise<Candidate[] | null> {
    const clients = this.deps.decisionClients ?? [];
    if (!clients.length || !this.config.maxDecisionAttempts || eligible.length < 2) {
      this.trace.push({ phase: "selection", reason: "configured_task_order" });
      return [...eligible];
    }
    for (const client of clients.slice(0, this.config.maxDecisionAttempts)) {
      const outcome = await this.decisionAttempt(client, eligible);
      this.checkAbort();
      const chosen = this.recordDecision(client, outcome, eligible);
      if (["auth", "denied", "refused"].includes(outcome.status)) return null;
      if (chosen) return [chosen, ...eligible.filter((candidate) => candidate.id !== chosen.id)];
      if (outcome.status !== "retryable") break;
    }
    if (this.config.decisionFailure === "stop") return null;
    this.trace.push({ phase: "selection", reason: "explicit_deterministic_fallback" });
    return [...eligible];
  }
  private async executionAttempt(
    candidate: Candidate
  ): Promise<"success" | "execution_failed" | "retryable"> {
    const outcome = await bounded(this.signal, () => {
      this.selectedId = candidate.id;
      this.begin("execution", candidate.id);
      return this.deps.execute(candidate, this.signal);
    });
    this.record(outcome);
    if (!matchesActual(candidate, outcome.actual)) {
      this.activeEntry!.status = "identity_or_effort_mismatch";
      this.trace.push({ phase: "execution", id: candidate.id, reason: this.activeEntry!.status });
      return "execution_failed";
    }
    this.trace.push({ phase: "execution", id: candidate.id, reason: outcome.status });
    this.activeEntry = null;
    if (outcome.status === "success") return "success";
    return outcome.status === "retryable" && outcome.committed === false
      ? "retryable"
      : "execution_failed";
  }
  private async execute(ordered: Candidate[]): Promise<PolicyResult["status"]> {
    let attempts = 0;
    for (const candidate of ordered) {
      if (attempts >= this.config.maxExecutionAttempts) break;
      const fresh = await bounded(this.signal, () => this.deps.snapshot(this.signal));
      this.checkAbort();
      const reasons = exclusionReasons(candidate, this.request, this.config, fresh);
      if (reasons.length) {
        this.trace.push({ phase: "recheck", id: candidate.id, reason: reasons.join(",") });
        continue;
      }
      attempts++;
      const status = await this.executionAttempt(candidate);
      this.checkAbort();
      if (status !== "retryable") return status;
    }
    return attempts ? "execution_failed" : "no_route";
  }
  async start(): Promise<PolicyResult> {
    try {
      const initial = await bounded(this.signal, () => this.deps.snapshot(this.signal));
      this.checkAbort();
      const eligible = eligibleCandidates(this.config, this.request, initial, this.trace);
      if (!eligible.length) return this.finish("no_route");
      const ordered = await this.select(eligible);
      this.checkAbort();
      if (ordered === null) return this.finish("decision_stopped");
      const status = await this.execute(ordered);
      this.checkAbort();
      return this.finish(status);
    } catch {
      if (this.activeEntry)
        this.activeEntry.status = this.signal.aborted ? this.stopStatus() : "unknown";
      this.trace.push({
        phase: "stop",
        reason: this.signal.aborted ? this.stopStatus() : "dependency_unknown_outcome",
      });
      return this.finish(this.signal.aborted ? this.stopStatus() : "execution_failed");
    }
  }
}

/** Purely injected policy lane. Not wired to any HTTP route/combo or provider. */
export async function runDecisionPolicy(
  rawConfig: unknown,
  rawRequest: unknown,
  deps: PolicyDeps,
  callerSignal?: AbortSignal
): Promise<PolicyResult> {
  const parsedConfig = policySchema.safeParse(rawConfig),
    parsedRequest = requestSchema.safeParse(rawRequest);
  const invalidStatus = parsedConfig.success ? "invalid_request" : "invalid_config";
  if (!parsedConfig.success || !parsedRequest.success) {
    const empty: Cost = { reportedUsd: 0, unknownAttempts: 0, totalUsd: 0 };
    return {
      status: invalidStatus,
      selectedId: null,
      trace: [],
      ledger: [],
      decisions: [],
      costs: { decision: { ...empty }, execution: { ...empty }, total: { ...empty } },
    };
  }
  freezeProfiles(parsedConfig.data, parsedRequest.data);
  return new PolicyRun(parsedConfig.data, parsedRequest.data, deps, callerSignal).start();
}
