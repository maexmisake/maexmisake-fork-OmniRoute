import { z } from "zod";
import { guidanceDisclosureMatches } from "./taskContext.ts";

const record = z.record(z.string(), z.unknown());
const choice = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable().optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable().optional(),
});
export function nativeReportedCost(body: Record<string, unknown>): number | null {
  const usage = record.safeParse(body.usage);
  const reported = usage.success ? usage.data.cost : null;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) return reported;
  const metadata = record.safeParse(body.provider_metadata);
  const gateway = record.safeParse(metadata.success ? metadata.data.gateway : null);
  const gatewayCost = gateway.success ? gateway.data.cost : null;
  if (typeof gatewayCost !== "string" || !/^\d+(?:\.\d+)?$/.test(gatewayCost)) return null;
  const cost = Number(gatewayCost);
  return Number.isFinite(cost) ? cost : null;
}
import type { Candidate, DecisionClient, DecisionOutcome } from "./contract.ts";

/** No URL, key, discovery, retry or chat substitution here. The caller must inject
 * one authorized native transport. This adapter never forwards credentials. */
export function nativeDecisionClient(options: {
  id: string;
  model: string;
  provider?: string;
  connectionId?: string;
  guidanceDisclosure?: unknown;
  call: (
    body: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
}): DecisionClient {
  return {
    id: options.id,
    select: async (candidates, request, signal) => {
      // Default is local-only. Consent must acknowledge this exact provider/model/connection.
      const discloseGuidance = guidanceDisclosureMatches(options, options.guidanceDisclosure);
      if (candidates.length < 2 || candidates.length > 255)
        return { status: "invalid", costUsd: 0 };
      const body = {
        model: options.model,
        state: request.state,
        questions: {
          route: {
            type: "choice",
            instructions:
              "Select one offered model and effort for the task. Do not invent options.",
            criteria: Object.fromEntries(
              candidates.map((candidate) => [
                candidate.id,
                JSON.stringify({
                  provider: candidate.provider,
                  model: candidate.model,
                  effort: {
                    mode: candidate.effort.mode,
                    value: candidate.effort.value,
                    supported: candidate.effort.supported,
                  },
                  capabilities: candidate.capabilities,
                  task: request.task,
                  ...(discloseGuidance && candidate.selectionGuidance !== undefined
                    ? { selectionGuidance: candidate.selectionGuidance }
                    : {}),
                }),
              ])
            ),
          },
        },
      };
      const response = await options.call(body, signal);
      const costUsd = nativeReportedCost(response.body);
      if (response.status === 401) return { status: "auth", costUsd };
      // Access, billing and rate/quota restrictions never authorize identity rotation.
      if ([402, 403, 429, 451].includes(response.status)) return { status: "denied", costUsd };
      if ([408, 500, 502, 503, 504].includes(response.status))
        return { status: "retryable", costUsd };
      if (response.status !== 200) return { status: "invalid", costUsd };
      return parseNativeChoice(response.body, candidates, costUsd);
    },
  };
}

function parseNativeChoice(
  body: Record<string, unknown>,
  candidates: readonly Candidate[],
  costUsd: number | null
): DecisionOutcome {
  const answers = record.safeParse(body.answers);
  if (
    !answers.success ||
    Object.keys(answers.data).length !== 1 ||
    !Object.hasOwn(answers.data, "route")
  )
    return { status: "invalid", costUsd };
  const raw = record.safeParse(answers.data.route);
  if (raw.success && raw.data.type === "refusal") return { status: "refused", costUsd };
  const parsed = choice.safeParse(answers.data.route);
  if (!parsed.success) return { status: "invalid", costUsd };
  const answer = parsed.data;
  if (!candidates.some((candidate) => candidate.id === answer.choice))
    return { status: "invalid", costUsd };
  if (answer.probabilities == null) return { status: "unknown", costUsd };
  const probabilities = answer.probabilities;
  const values = Object.values(probabilities);
  if (
    answer.confidence == null ||
    Object.keys(probabilities).length !== candidates.length ||
    candidates.some((candidate) => !Object.hasOwn(probabilities, candidate.id)) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-6 ||
    values.some((value) => value > probabilities[answer.choice])
  )
    return { status: "invalid", costUsd };
  return {
    status: "selected",
    optionId: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    costUsd,
  };
}
