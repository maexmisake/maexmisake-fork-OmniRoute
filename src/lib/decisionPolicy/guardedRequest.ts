import { z } from "zod";
import type { MockAgent } from "undici";
import { BaseExecutor, type StrictValidationDispatch } from "../../../open-sse/executors/base.ts";
import {
  boundedJson,
  extractRequestFacts,
  type ContextMeasure,
  type ChatPolicyBody,
} from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import { exclusionReasons } from "../../../open-sse/services/decisionPolicy/eligibility.ts";
import { runDecisionPolicy } from "../../../open-sse/services/decisionPolicy/run.ts";
import {
  policySchema,
  type Candidate,
  type CandidateState,
  type DecisionClient,
  type ExecutionOutcome,
  type PolicyResult,
  type PolicyConfig,
  type PolicyRequest,
  type Snapshot,
} from "../../../open-sse/services/decisionPolicy/contract.ts";
import { STRICT_CHAT_URL, assertStrictDirectEgress, strictTransport } from "./strictTransport.ts";

const bindingSchema = z
  .object({ candidateId: z.string(), connectionId: z.string().min(1), apiKey: z.string().min(1) })
  .strict();
export type DispatchReceipt = {
  candidateId: string;
  ordinal: number;
  status: number | null;
  costUsd: number | null;
};
export type GuardedResult = {
  policy: PolicyResult | null;
  rejection: string | null;
  synthetic: boolean;
  physicalDispatches: DispatchReceipt[];
  payload: unknown;
};
export type GuardedRequestOptions = {
  config: unknown;
  body: unknown;
  bindings: unknown;
  routeModel: string;
  measureContext: ContextMeasure;
  readState: (id: string, connectionId: string | null) => CandidateState | undefined;
  continuationCandidateId?: string | null;
  isOutputCommitted?: () => boolean;
  signal?: AbortSignal;
  decisionClients?: readonly DecisionClient[];
  fixtureAgent?: MockAgent;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function boundedResponse(
  response: Response,
  signal: AbortSignal
): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 262144) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    return boundedJson(parsed) && parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
}
function costOf(payload: Record<string, unknown> | null): number | null {
  const usage = payload?.usage;
  const value = usage && typeof usage === "object" ? (usage as Record<string, unknown>).cost : null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function terminalRefusal(payload: Record<string, unknown> | null): boolean {
  const choices = payload?.choices;
  return (
    Array.isArray(choices) &&
    choices.some((choice) => {
      const message = choice?.message;
      return (
        !!message &&
        typeof message === "object" &&
        typeof message.refusal === "string" &&
        message.refusal.length > 0
      );
    })
  );
}
function reconcile(policy: PolicyResult, receipts: DispatchReceipt[]): PolicyResult {
  const result = structuredClone(policy);
  for (const entry of result.ledger) {
    if (entry.lane !== "execution") continue;
    const receipt = receipts.find((row) => row.candidateId === entry.id);
    entry.costUsd = receipt ? receipt.costUsd : 0;
  }
  for (const lane of ["decision", "execution", "total"] as const) {
    const entries = result.ledger.filter((entry) => lane === "total" || entry.lane === lane);
    const reportedUsd = entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
    const unknownAttempts = entries.filter((entry) => entry.costUsd === null).length;
    result.costs[lane] = {
      reportedUsd,
      unknownAttempts,
      totalUsd: unknownAttempts ? null : reportedUsd,
    };
  }
  return result;
}

type Binding = z.infer<typeof bindingSchema>;
type Attempt = { receipt?: DispatchReceipt };
const answerSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal("function"),
                function: z.object({ name: z.string().min(1), arguments: z.string() }),
              })
            )
            .max(32)
            .optional(),
        }),
      })
    )
    .length(1),
});
function contentFiltered(data: Record<string, unknown> | null): boolean {
  return (
    Array.isArray(data?.choices) &&
    data.choices.some((choice) => choice?.finish_reason === "content_filter")
  );
}
function responseStatus(
  response: Response,
  data: Record<string, unknown> | null
): ExecutionOutcome["status"] {
  if ([401, 402, 403].includes(response.status)) return "auth";
  if (terminalRefusal(data) || contentFiltered(data)) return "terminal";
  if ([408, 429, 500, 502, 503, 504].includes(response.status)) return "retryable";
  if (!response.ok || !data || Object.hasOwn(data, "error")) return "terminal";
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) return "terminal";
  const message = parsed.data.choices[0].message;
  return message.content || message.tool_calls?.length ? "success" : "terminal";
}

class GuardedSession {
  private receipts: DispatchReceipt[] = [];
  private payload: unknown = null;
  private byId: Map<string, Binding>;
  constructor(
    private options: GuardedRequestOptions,
    private config: PolicyConfig,
    private body: ChatPolicyBody,
    private facts: PolicyRequest,
    bindings: Binding[],
    private transport: ReturnType<typeof strictTransport>
  ) {
    this.byId = new Map(bindings.map((binding) => [binding.candidateId, Object.freeze(binding)]));
  }
  private snapshot(): Snapshot {
    return Object.fromEntries(
      this.config.candidates.map((candidate) => {
        const binding = this.byId.get(candidate.id);
        const supported = candidate.provider === "openai" && candidate.effort.mode !== "fixed";
        return [
          candidate.id,
          binding && supported
            ? this.options.readState(candidate.id, binding.connectionId)
            : undefined,
        ];
      })
    );
  }
  private assertUsable(candidate: Candidate, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.options.isOutputCommitted?.()) throw new Error("policy_output_committed");
    if (candidate.provider !== "openai" || candidate.effort.mode === "fixed")
      throw new Error("policy_transport_unsupported");
    if (exclusionReasons(candidate, this.facts, this.config, this.snapshot()).length)
      throw new Error("policy_target_ineligible");
    assertStrictDirectEgress();
    signal.throwIfAborted();
  }
  private assertWire(body: BodyInit | null | undefined, proof: string): void {
    if (typeof body !== "string") throw new Error("policy_wire_mismatch");
    const parsed: unknown = JSON.parse(body);
    if (!boundedJson(parsed) || canonical(parsed) !== proof)
      throw new Error("policy_wire_mismatch");
    const count = this.options.measureContext(parsed as Parameters<ContextMeasure>[0]);
    if (
      count === null ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count + this.body.max_completion_tokens > this.facts.contextTokens
    )
      throw new Error("policy_context_unknown");
  }
  private observer(
    candidate: Candidate,
    signal: AbortSignal,
    binding: Binding,
    proof: string,
    attempt: Attempt
  ): StrictValidationDispatch {
    const reject = (): never => {
      throw new Error("policy_dispatch_mismatch");
    };
    return {
      singleAttempt: true,
      reject,
      beforeFetch: (wire) => {
        this.assertUsable(candidate, signal);
        if (
          wire.provider !== candidate.provider ||
          wire.model !== candidate.model ||
          wire.url !== STRICT_CHAT_URL
        )
          reject();
        if (
          wire.credentials.connectionId !== binding.connectionId ||
          wire.credentials.apiKey !== binding.apiKey ||
          wire.credentials.accessToken ||
          wire.credentials.refreshToken ||
          wire.credentials.providerSpecificData
        )
          reject();
        const headers = new Headers(wire.headers);
        if (headers.get("authorization") !== `Bearer ${binding.apiKey}`) reject();
        if (
          [...headers.keys()].some(
            (key) => !["authorization", "content-type", "accept"].includes(key)
          )
        )
          reject();
        this.assertWire(wire.body, proof);
      },
      transport: (url, init) => {
        this.assertUsable(candidate, signal);
        if (attempt.receipt) reject();
        attempt.receipt = {
          candidateId: candidate.id,
          ordinal: this.receipts.length + 1,
          status: null,
          costUsd: null,
        };
        this.receipts.push(attempt.receipt);
        return this.transport.send(url, init);
      },
    };
  }
  private preparedBody(candidate: Candidate): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...structuredClone(this.body),
      model: candidate.model,
      stream: false,
    };
    if (candidate.effort.value !== null) body.reasoning_effort = candidate.effort.value;
    else delete body.reasoning_effort;
    return body;
  }
  private async dispatch(
    candidate: Candidate,
    signal: AbortSignal,
    attempt: Attempt
  ): Promise<ExecutionOutcome["status"]> {
    this.assertUsable(candidate, signal);
    const binding = this.byId.get(candidate.id);
    if (!binding) throw new Error("policy_binding_missing");
    const body = this.preparedBody(candidate);
    const executor = new BaseExecutor("openai", {
      id: "openai",
      baseUrl: STRICT_CHAT_URL,
      format: "openai",
      timeoutMs: this.config.timeoutMs,
    });
    const result = await executor.execute({
      model: candidate.model,
      body,
      stream: false,
      signal,
      credentials: Object.freeze({ connectionId: binding.connectionId, apiKey: binding.apiKey }),
      skipUpstreamRetry: true,
      validationDispatch: this.observer(candidate, signal, binding, canonical(body), attempt),
    });
    if (!attempt.receipt) throw new Error("policy_missing_dispatch");
    signal.throwIfAborted();
    const response = result instanceof Response ? result : result.response;
    attempt.receipt.status = response.status;
    const data = await boundedResponse(response, signal);
    attempt.receipt.costUsd = costOf(data);
    signal.throwIfAborted();
    this.payload = data;
    return responseStatus(response, data);
  }
  private async execute(candidate: Candidate, signal: AbortSignal): Promise<ExecutionOutcome> {
    const attempt: Attempt = {};
    let status: ExecutionOutcome["status"] = "terminal";
    try {
      status = await this.dispatch(candidate, signal, attempt);
    } catch {
      /* Closed failure; no exception text enters traces. */
    }
    return {
      status,
      actual: {
        provider: candidate.provider,
        model: candidate.model,
        effort: candidate.effort.value,
      },
      costUsd: attempt.receipt ? attempt.receipt.costUsd : 0,
      committed: this.options.isOutputCommitted?.() ?? false,
    };
  }
  async run(): Promise<GuardedResult> {
    try {
      const policy = await runDecisionPolicy(
        this.config,
        this.facts,
        {
          snapshot: async () => this.snapshot(),
          decisionClients: this.options.decisionClients,
          execute: (candidate, signal) => this.execute(candidate, signal),
        },
        this.options.signal
      );
      return {
        policy: reconcile(policy, this.receipts),
        rejection: null,
        synthetic: this.transport.synthetic,
        physicalDispatches: structuredClone(this.receipts),
        payload: this.payload,
      };
    } finally {
      await this.transport.close();
    }
  }
}

function standaloneControlsSupported(body: ChatPolicyBody): boolean {
  return (
    body.stream !== true && body.tool_choice === undefined && body.parallel_tool_calls === undefined
  );
}
/** Standalone BaseExecutor physical integration. No legacy combo/core/resolver/fallback is called. */
export async function runGuardedDecisionRequest(
  options: GuardedRequestOptions
): Promise<GuardedResult> {
  const rejected = (reason: string): GuardedResult => ({
    policy: null,
    rejection: reason,
    synthetic: !!options.fixtureAgent,
    physicalDispatches: [],
    payload: null,
  });
  if (!options.fixtureAgent) return rejected("production_transport_unvalidated");
  const config = policySchema.safeParse(options.config),
    bindings = z.array(bindingSchema).max(255).safeParse(options.bindings);
  if (
    !config.success ||
    !bindings.success ||
    new Set(bindings.data.map((b) => b.candidateId)).size !== bindings.data.length
  )
    return rejected("invalid_binding_configuration");
  let extracted: ReturnType<typeof extractRequestFacts>;
  try {
    extracted = extractRequestFacts(options.body, options);
  } catch {
    return rejected("context_unknown");
  }
  if (!extracted.ok) return rejected(extracted.reason);
  if (!standaloneControlsSupported(extracted.body))
    return rejected("controls_unsupported_in_standalone_fixture");
  if (extracted.body.model !== options.routeModel) return rejected("route_model_mismatch");
  try {
    assertStrictDirectEgress();
  } catch {
    return rejected("egress_unsupported");
  }
  const transport = strictTransport({ fixtureAgent: options.fixtureAgent });
  return new GuardedSession(
    options,
    config.data,
    extracted.body,
    extracted.facts,
    bindings.data,
    transport
  ).run();
}
