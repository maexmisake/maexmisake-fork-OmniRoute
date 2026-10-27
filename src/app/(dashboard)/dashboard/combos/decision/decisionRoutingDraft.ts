import {
  decisionPolicyEditorSchema,
  NATIVE_DECISION_BINDINGS,
  type DecisionPolicyEditorValue,
} from "@/shared/decisionPolicy/configuration";
import { guidanceDisclosureMatches } from "../../../../../../open-sse/services/decisionPolicy/taskContext";

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
  applicationMode: "bounded-v1" | "provider-native-output-v1";
  nativeOutputAcknowledged: boolean;
  contextOutputTokens: string;
  mode: "deterministic" | "native";
  binding: string;
  selectorConnection: string;
  decisionTimeout: string;
  maxCandidates: string;
  decisionContextMode: "local-summary" | "task-text";
  decisionContextAcknowledged: boolean;
  decisionContextMaxChars: string;
  guidanceAcknowledged: boolean;
  timeout: string;
  unknownQuota: "reject" | "allow";
  retryEnabled: boolean;
  maxExecutionAttempts: string;
  retryTransitions: string;
  sessionsEnabled: boolean;
  sessionIdleTtlMs: string;
  sessionMaxTurns: string;
  sessionMinStableTurns: string;
  sessionMaxActive: string;
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
    applicationMode: policy?.applicationMode ?? "bounded-v1",
    nativeOutputAcknowledged: policy?.nativeOutput?.acknowledgeNoTokenCeiling === true,
    contextOutputTokens: policy?.nativeOutput
      ? String(policy.nativeOutput.contextOutputTokens)
      : "",
    mode: native ? "native" : "deterministic",
    binding: native ? bindingKey(native) : "",
    selectorConnection: native?.connectionId ?? "",
    decisionTimeout: String(native?.timeoutMs ?? 8000),
    maxCandidates: String(native?.maxCandidates ?? 32),
    decisionContextMode: native?.decisionContext?.mode ?? "local-summary",
    decisionContextAcknowledged:
      native?.decisionContext?.mode === "task-text" &&
      native.decisionContext.acknowledgeExternalTransmission === true,
    decisionContextMaxChars: String(
      native?.decisionContext?.mode === "task-text" ? native.decisionContext.maxChars : 2048
    ),
    guidanceAcknowledged: !!native && guidanceDisclosureMatches(native, native.guidanceDisclosure),
    timeout: String(policy?.policy.timeoutMs ?? 30000),
    unknownQuota: policy?.policy.unknownQuota ?? "reject",
    retryEnabled: !!policy?.retry,
    maxExecutionAttempts: String(policy?.policy.maxExecutionAttempts ?? 1),
    retryTransitions: JSON.stringify(policy?.retry?.transitions ?? [], null, 2),
    sessionsEnabled: !!policy?.sessions,
    sessionIdleTtlMs: String(policy?.sessions?.idleTtlMs ?? 300000),
    sessionMaxTurns: String(policy?.sessions?.maxTurns ?? 64),
    sessionMinStableTurns: String(policy?.sessions?.minStableTurns ?? 2),
    sessionMaxActive: String(policy?.sessions?.maxActiveSessions ?? 8),
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

const ADJUSTABLE_EFFORTS = ["medium", "high", "xhigh", "max"];
function executionKeys(provider: string, models: string[], mode: string, efforts: string[]) {
  return models.flatMap((model) =>
    efforts.map((effort) => JSON.stringify([provider, model, mode, effort]))
  );
}
const BOUNDED_EXECUTION_PROFILES = new Set([
  ...executionKeys(
    "claude",
    ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    "set",
    ADJUSTABLE_EFFORTS
  ),
  ...executionKeys("agy", ["gemini-3.8-flash-high"], "set", ["high"]),
  ...executionKeys("agy", ["gemini-3.8-flash-high"], "fixed", ["high"]),
]);
const NATIVE_OUTPUT_EXECUTION_PROFILES = new Set([
  ...BOUNDED_EXECUTION_PROFILES,
  ...executionKeys("codex", ["gpt-5.6-sol", "gpt-6-sol"], "set", ADJUSTABLE_EFFORTS),
  ...executionKeys("codex", ["gpt-6-luna"], "fixed", ["max"]),
  ...executionKeys("agy", ["claude-opus-4-6-thinking"], "fixed", ["high"]),
]);
function supportedExecutionProfile(candidate: Candidate, nativeOutput: boolean): boolean {
  if (candidate.provider === "openai") return candidate.effort.mode === "set";
  const profiles = nativeOutput ? NATIVE_OUTPUT_EXECUTION_PROFILES : BOUNDED_EXECUTION_PROFILES;
  return profiles.has(
    JSON.stringify([
      candidate.provider,
      candidate.model,
      candidate.effort.mode,
      candidate.effort.value,
    ])
  );
}

function executionIssues(
  candidate: Candidate,
  options: EditorOptions,
  connectionId: string,
  nativeOutput: boolean
) {
  const connection = options.connections.find((row) => row.id === connectionId);
  if (!supportedExecutionProfile(candidate, nativeOutput))
    return "An execution profile uses an unsupported provider/model/effort for this output policy.";
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
    !candidate.effort.value ||
    !candidate.effort.supported?.includes(candidate.effort.value)
  )
    return "Enabled profiles need explicit direct text, context and supported effort declarations.";
  return null;
}
function nativeOutputIssues(draft: Draft): string[] {
  if (draft.applicationMode !== "provider-native-output-v1") return [];
  const issues: string[] = [];
  if (!draft.nativeOutputAcknowledged)
    issues.push(
      "Acknowledge that provider-native output has no provider-enforced token ceiling before saving."
    );
  const allowance = Number(draft.contextOutputTokens);
  if (!Number.isSafeInteger(allowance) || allowance < 1 || allowance > 1000000)
    issues.push("Enter an explicit output context-planning allowance from 1 to 1,000,000 tokens.");
  return issues;
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
          ...(draft.guidanceAcknowledged
            ? {
                guidanceDisclosure: {
                  acknowledgeExternalTransmission: true,
                  provider: binding?.provider,
                  model: binding?.model,
                  connectionId: draft.selectorConnection,
                },
              }
            : {}),
          connectionId: draft.selectorConnection,
          timeoutMs: Number(draft.decisionTimeout),
          maxCandidates: Number(draft.maxCandidates),
          ...(draft.decisionContextMode === "task-text"
            ? {
                decisionContext: {
                  mode: "task-text",
                  acknowledgeExternalTransmission: draft.decisionContextAcknowledged,
                  maxChars: Number(draft.decisionContextMaxChars),
                },
              }
            : {}),
        }
      : { mode: "deterministic" };
  return decisionPolicyEditorSchema.safeParse({
    enabled: draft.enabled,
    applicationMode: draft.applicationMode,
    ...(draft.applicationMode === "provider-native-output-v1"
      ? {
          nativeOutput: {
            acknowledgeNoTokenCeiling: draft.nativeOutputAcknowledged,
            contextOutputTokens: Number(draft.contextOutputTokens),
          },
        }
      : {}),
    selection,
    connections: draft.connections,
    ...(draft.retryEnabled ? { retry: { transitions: parseJson(draft.retryTransitions) } } : {}),
    ...(draft.sessionsEnabled
      ? {
          sessions: {
            mode: "task-boundary",
            idleTtlMs: Number(draft.sessionIdleTtlMs),
            maxTurns: Number(draft.sessionMaxTurns),
            minStableTurns: Number(draft.sessionMinStableTurns),
            maxActiveSessions: Number(draft.sessionMaxActive),
          },
        }
      : {}),
    policy: {
      version: 1,
      candidates,
      taskOrder,
      unknownQuota: draft.unknownQuota,
      decisionFailure: "stop",
      maxDecisionAttempts: draft.mode === "native" ? 1 : 0,
      maxExecutionAttempts: draft.retryEnabled ? Number(draft.maxExecutionAttempts) : 1,
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
    const issue = executionIssues(
      candidate,
      options,
      draft.connections[candidate.id],
      draft.applicationMode === "provider-native-output-v1"
    );
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
  const outputIssues = nativeOutputIssues(draft);
  if (draft.mode === "native" && draft.decisionContextMode === "task-text") {
    if (!draft.decisionContextAcknowledged)
      outputIssues.push(
        "Acknowledge external task-text sharing before saving this decision policy."
      );
    const maximum = Number(draft.decisionContextMaxChars);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2048)
      outputIssues.push("Set a shared task bound from 1 to 2,048 characters.");
  }
  if (outputIssues.length)
    return { policy: null, candidates: [] as Candidate[], issues: outputIssues };
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
