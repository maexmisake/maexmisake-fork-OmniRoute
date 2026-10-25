import {
  decisionPolicyEditorSchema,
  NATIVE_DECISION_BINDINGS,
  type DecisionPolicyEditorValue,
} from "@/shared/decisionPolicy/configuration";

export type Binding = (typeof NATIVE_DECISION_BINDINGS)[number];
export type Connection = {
  id: string;
  provider: string;
  label: string;
  active: boolean;
  credentialPresent: boolean;
  freeTier: boolean;
  metadataCompatible: boolean;
  revision: string;
};
export type EditorOptions = {
  bindings: Binding[];
  connections: Connection[];
  combos: Array<{ id: string; name: string }>;
};
export type SavedPolicy = {
  comboId: string;
  name: string;
  revision: string;
  policy: DecisionPolicyEditorValue | null;
  status: "unconfigured" | "enabled" | "disabled" | "invalid";
};
export type Draft = {
  enabled: boolean;
  mode: "deterministic" | "native";
  binding: string;
  selectorConnection: string;
  decisionTimeout: string;
  maxCandidates: string;
  timeout: string;
  unknownQuota: "reject" | "allow";
  candidates: string;
  taskOrder: string;
  connections: Record<string, string>;
};
export type Candidate = DecisionPolicyEditorValue["policy"]["candidates"][number];

export function bindingKey(binding: { provider: string; model: string }): string {
  return JSON.stringify([binding.provider, binding.model]);
}

export function draftFromPolicy(policy: DecisionPolicyEditorValue | null): Draft {
  const selection = policy?.selection;
  const native = selection?.mode === "native" ? selection : null;
  return {
    enabled: policy?.enabled ?? false,
    mode: native ? "native" : "deterministic",
    binding: native ? bindingKey(native) : "",
    selectorConnection: native?.connectionId ?? "",
    decisionTimeout: String(native?.timeoutMs ?? 8000),
    maxCandidates: String(native?.maxCandidates ?? 32),
    timeout: String(policy?.policy.timeoutMs ?? 30000),
    unknownQuota: policy?.policy.unknownQuota ?? "reject",
    candidates: JSON.stringify(policy?.policy.candidates ?? [], null, 2),
    taskOrder: JSON.stringify(policy?.policy.taskOrder ?? {}, null, 2),
    connections: { ...(policy?.connections ?? {}) },
  };
}

function parseJson(value: string): unknown {
  if (value.length > 262144) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function selectedBinding(draft: Draft, options: EditorOptions): Binding | undefined {
  return options.bindings.find((binding) => bindingKey(binding) === draft.binding);
}

export function eligibleSelector(connection: Connection | undefined, binding: Binding): boolean {
  return Boolean(
    connection?.active &&
    connection.credentialPresent &&
    connection.provider === binding.provider &&
    connection.metadataCompatible &&
    (binding.provider !== "opencode-zen" || connection.freeTier === (binding.tier === "free"))
  );
}

function executionIssues(candidate: Candidate, options: EditorOptions, connectionId: string) {
  const connection = options.connections.find((row) => row.id === connectionId);
  const supportedProvider =
    candidate.provider === "openai" ||
    (candidate.provider === "claude" &&
      candidate.model === "claude-opus-5-5" &&
      ["medium", "high"].includes(candidate.effort.value ?? ""));
  if (!supportedProvider) return "An execution profile uses an unsupported provider/model/effort.";
  if (
    !connection?.active ||
    !connection.credentialPresent ||
    connection.provider !== candidate.provider
  )
    return "Every execution profile needs an active, matching configured connection.";
  if (
    candidate.endpointKind !== "direct" ||
    candidate.capabilities.text !== true ||
    candidate.capabilities.contextTokens === null ||
    candidate.effort.mode !== "set" ||
    !candidate.effort.value ||
    !candidate.effort.supported?.includes(candidate.effort.value)
  )
    return "Enabled profiles need explicit direct text, context and supported effort declarations.";
  return null;
}

function parseDraft(draft: Draft, options: EditorOptions) {
  const candidates = parseJson(draft.candidates);
  const taskOrder = parseJson(draft.taskOrder);
  const binding = selectedBinding(draft, options);
  const selection =
    draft.mode === "native"
      ? {
          mode: "native",
          provider: binding?.provider,
          model: binding?.model,
          connectionId: draft.selectorConnection,
          timeoutMs: Number(draft.decisionTimeout),
          maxCandidates: Number(draft.maxCandidates),
        }
      : { mode: "deterministic" };
  return decisionPolicyEditorSchema.safeParse({
    enabled: draft.enabled,
    applicationMode: "bounded-v1",
    selection,
    connections: draft.connections,
    policy: {
      version: 1,
      candidates,
      taskOrder,
      unknownQuota: draft.unknownQuota,
      decisionFailure: "stop",
      maxDecisionAttempts: draft.mode === "native" ? 1 : 0,
      maxExecutionAttempts: 1,
      timeoutMs: Number(draft.timeout),
    },
  });
}

function enabledIssues(policy: DecisionPolicyEditorValue, draft: Draft, options: EditorOptions) {
  const issues: string[] = [];
  if (!draft.enabled) return issues;
  const minimum = draft.mode === "native" ? 2 : 1;
  if (policy.policy.candidates.length < minimum)
    issues.push(`This enabled mode needs at least ${minimum} explicit model-and-effort profiles.`);
  for (const candidate of policy.policy.candidates) {
    const issue = executionIssues(candidate, options, draft.connections[candidate.id]);
    if (issue) issues.push(issue);
  }
  if (!Object.values(policy.policy.taskOrder).some((order) => order.length > 0))
    issues.push("Declare a preference order for at least one supported task category.");
  const binding = selectedBinding(draft, options);
  if (draft.mode === "native" && binding) {
    const connection = options.connections.find((row) => row.id === draft.selectorConnection);
    if (!eligibleSelector(connection, binding))
      issues.push(
        "Choose an active matching selector connection with compatible routing metadata."
      );
  }
  return issues;
}

export function validateDraft(draft: Draft, options: EditorOptions) {
  const parsed = parseDraft(draft, options);
  if (!parsed.success)
    return {
      policy: null,
      candidates: [] as Candidate[],
      issues: [
        "Check the version 1 profile/task JSON, exact binding and timeout/candidate bounds.",
      ],
    };
  const policy = parsed.data;
  const issues = enabledIssues(policy, draft, options);
  const rawOrders = parseJson(draft.taskOrder);
  if (rawOrders && typeof rawOrders === "object" && Object.hasOwn(rawOrders, "__proto__"))
    issues.push(
      "The reserved task category __proto__ cannot be saved. Correct advanced JSON; its text is retained."
    );
  const saveBody = JSON.stringify({ revision: "0".repeat(64), action: "save", policy });
  if (new TextEncoder().encode(saveBody).byteLength > 65536)
    issues.push("The complete settings save must fit within 64 KiB. Shorten profile/task JSON.");
  return {
    policy: issues.length ? null : policy,
    candidates: policy.policy.candidates,
    issues: [...new Set(issues)],
  };
}

export function readSavedPolicy(value: unknown, comboId: string): SavedPolicy {
  if (!value || typeof value !== "object") throw new Error("Invalid settings response");
  const row = value as Record<string, unknown>;
  if (
    row.comboId !== comboId ||
    typeof row.name !== "string" ||
    typeof row.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.revision) ||
    !["unconfigured", "enabled", "disabled", "invalid"].includes(String(row.status))
  )
    throw new Error("Invalid settings response");
  const status = row.status as SavedPolicy["status"];
  const parsed = decisionPolicyEditorSchema.safeParse(row.policy);
  if (status === "enabled" && (!parsed.success || !parsed.data.enabled))
    throw new Error("Invalid enabled settings response");
  if (status === "disabled" && row.policy !== null && (!parsed.success || parsed.data.enabled))
    throw new Error("Invalid disabled settings response");
  if (status === "unconfigured" && row.policy !== null)
    throw new Error("Invalid unconfigured settings response");
  return {
    comboId,
    name: row.name,
    revision: row.revision,
    status,
    policy: status !== "invalid" && parsed.success ? parsed.data : null,
  };
}
