import { z } from "zod";
import { candidateSchema } from "../../../../../../open-sse/services/decisionPolicy/contract";
import type { Candidate, Draft } from "./decisionRoutingDraft";

// Partial form rows remain editable; strict configuration validation still controls saving.
const editableCandidate = candidateSchema.extend({
  provider: z.string().max(100),
  model: z.string().max(200),
  capabilities: candidateSchema.shape.capabilities.extend({
    contextTokens: z.number().nullable(),
  }),
});
const editableProfiles = z.array(editableCandidate).max(255);
const editableOrder = z.array(z.string()).max(255);
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const TASK_LABELS: Record<string, string> = {
  unresolved: "Unresolved",
  explanation: "Explanation",
  reasoning: "Reasoning",
  complex_code: "Complex code",
  long_context: "Long context",
  image: "Image (unsupported)",
  tools: "Tools",
  continuation: "Continuation",
};
export function readProfiles(text: string): Candidate[] | null {
  try {
    const result = editableProfiles.safeParse(JSON.parse(text));
    if (!result.success) return null;
    const ids = result.data.map((row) => row.id);
    return new Set(ids).size === ids.length ? result.data : null;
  } catch {
    return null;
  }
}
export function readOrders(text: string): Record<string, string[]> | null {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.some(([, order]) => !editableOrder.safeParse(order).success)) return null;
    return Object.fromEntries(entries) as Record<string, string[]>;
  } catch {
    return null;
  }
}
export function unknownProfile(id: string): Candidate {
  return {
    id,
    provider: "",
    model: "",
    endpointKind: "unknown",
    evidence: null,
    capabilities: { text: null, images: null, tools: null, reasoning: null, contextTokens: null },
    effort: { mode: "set", value: null, supported: null, evidence: null },
  };
}
export function addProfile(
  profiles: Candidate[],
  draft: Draft,
  orders: Record<string, string[]>
): Candidate[] {
  const used = new Set([
    ...profiles.map((row) => row.id),
    ...Object.keys(draft.connections),
    ...Object.values(orders).flat(),
  ]);
  let next = 1;
  while (used.has(`profile-${next}`)) next++;
  return [...profiles, unknownProfile(`profile-${next}`)];
}
export function changeProfile(
  draft: Draft,
  profiles: Candidate[],
  id: string,
  patch: Partial<Candidate>
): Partial<Draft> {
  const identityChanged = Object.hasOwn(patch, "provider") || Object.hasOwn(patch, "model");
  const next = profiles.map((row) => {
    if (row.id !== id) return row;
    const reset = identityChanged ? unknownProfile(id) : row;
    return { ...reset, provider: row.provider, model: row.model, ...patch };
  });
  return {
    candidates: JSON.stringify(next, null, 2),
    ...(identityChanged
      ? {
          connections: Object.fromEntries(
            Object.entries(draft.connections).filter(([key]) => key !== id)
          ),
        }
      : {}),
  };
}
export function removeProfile(
  draft: Draft,
  profiles: Candidate[],
  orders: Record<string, string[]>,
  id: string
): Partial<Draft> {
  return {
    candidates: JSON.stringify(
      profiles.filter((row) => row.id !== id),
      null,
      2
    ),
    connections: Object.fromEntries(
      Object.entries(draft.connections).filter(([key]) => key !== id)
    ),
    taskOrder: JSON.stringify(
      Object.fromEntries(
        Object.entries(orders).map(([key, values]) => [key, values.filter((value) => value !== id)])
      ),
      null,
      2
    ),
  };
}
export function orderPatch(
  orders: Record<string, string[]>,
  task: string,
  values: string[]
): Partial<Draft> {
  // Object.fromEntries treats custom keys such as __proto__ as inert own data.
  return {
    taskOrder: JSON.stringify(
      Object.fromEntries([
        ...Object.entries(orders).filter(([key]) => key !== task),
        [task, values],
      ]),
      null,
      2
    ),
  };
}
export function moveInOrder(values: string[], index: number, offset: number): string[] {
  const next = [...values];
  const destination = index + offset;
  if (destination < 0 || destination >= next.length) return next;
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
