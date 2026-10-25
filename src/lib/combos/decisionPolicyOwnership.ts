import { isDeepStrictEqual } from "node:util";

export class DecisionPolicyOwnershipError extends Error {
  constructor() {
    super(
      "Decision routing changed or requires its dedicated settings editor. Reload and try again."
    );
    this.name = "DecisionPolicyOwnershipError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function hasManagedDecisionPolicy(config: unknown): boolean {
  return Object.hasOwn(record(config), "decisionPolicy");
}

/** Run against the latest stored row inside the write transaction, not route admission. */
export function preserveManagedDecisionPolicy(current: unknown, incoming: unknown): unknown {
  const stored = record(current);
  const next = record(incoming);
  const owns = hasManagedDecisionPolicy(stored);
  if (
    hasManagedDecisionPolicy(next) &&
    (!owns || !isDeepStrictEqual(stored.decisionPolicy, next.decisionPolicy))
  ) {
    throw new DecisionPolicyOwnershipError();
  }
  if (!owns) return incoming;
  return { ...next, decisionPolicy: stored.decisionPolicy };
}
