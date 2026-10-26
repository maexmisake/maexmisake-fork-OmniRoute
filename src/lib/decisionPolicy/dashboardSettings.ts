/** Local management settings only. Never performs discovery, inference, sync or health recovery. */
import { z } from "zod";
import {
  decisionPolicyEditorSchema,
  NATIVE_DECISION_BINDINGS,
  type DecisionPolicyEditorValue,
} from "../../shared/decisionPolicy/configuration";
import {
  DecisionSettingsError,
  settingsRecord,
  readStoredDecisionSettings,
  listDecisionComboNames,
  readDecisionConnectionRows,
  connectionSettingsRevision,
  storedConnectionMetadata,
  readDecisionActivationConnection,
  compareAndSetDecisionPolicy,
  compareAndSetZenTier,
} from "../db/decisionPolicySettings";
import {
  resolveApplicationProvider,
  assertApplicationEgress,
  isApplicationEffortSupported,
} from "./applicationProvider";
import {
  systemOneModelTier,
  isConnectionEligibleForTier,
} from "../../../open-sse/config/systemOneRegistry.ts";
import { systemOneUrl } from "../../../open-sse/handlers/systemOneTransport.ts";
import { createErrorResponse } from "../api/errorResponse";
import { requireManagementAuth } from "../api/requireManagementAuth";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const policyWriteSchema = z.discriminatedUnion("action", [
  z
    .object({
      revision: revisionSchema,
      action: z.literal("save"),
      policy: decisionPolicyEditorSchema,
    })
    .strict(),
  z.object({ revision: revisionSchema, action: z.literal("disable") }).strict(),
]);
const tierWriteSchema = z
  .object({ revision: revisionSchema, tier: z.enum(["free", "paid"]) })
  .strict();
export type DecisionConnectionOption = {
  id: string;
  provider: string;
  label: string;
  active: boolean;
  credentialPresent: boolean;
  freeTier: boolean;
  metadataCompatible: boolean;
  revision: string;
};
export type DecisionPolicySettingsView = {
  comboId: string;
  name: string;
  revision: string;
  policy: DecisionPolicyEditorValue | null;
  status: "unconfigured" | "enabled" | "disabled" | "invalid";
  issues: string[];
};
function invalid(): never {
  throw new DecisionSettingsError(400, "invalid_settings");
}
function compatibleMetadata(provider: string, metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  const keys = Object.keys(metadata);
  return (
    keys.length === 0 ||
    (provider === "opencode-zen" && keys.length === 1 && metadata.systemOneTier === "free")
  );
}
function connectionProjection(
  row: Record<string, unknown>,
  index: number
): DecisionConnectionOption {
  const metadata = storedConnectionMetadata(row);
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: `Connection ${index + 1}`,
    active: row.is_active === 1,
    credentialPresent: row.credential_present === 1,
    freeTier: metadata?.systemOneTier === "free",
    metadataCompatible: compatibleMetadata(String(row.provider), metadata),
    revision: connectionSettingsRevision(row),
  };
}
export function getDecisionRoutingOptions() {
  return {
    bindings: NATIVE_DECISION_BINDINGS,
    connections: readDecisionConnectionRows().map(connectionProjection),
    combos: listDecisionComboNames(),
  };
}
export function getDecisionPolicySettings(id: string): DecisionPolicySettingsView {
  if (!idSchema.safeParse(id).success) invalid();
  const stored = readStoredDecisionSettings(id);
  const parsed = decisionPolicyEditorSchema.safeParse(stored.rawPolicy);
  if (!stored.hasPolicy)
    return {
      comboId: stored.comboId,
      name: stored.name,
      revision: stored.revision,
      policy: null,
      status: "unconfigured",
      issues: [],
    };
  const disabled = settingsRecord(stored.rawPolicy)?.enabled === false;
  return {
    comboId: stored.comboId,
    name: stored.name,
    revision: stored.revision,
    policy: parsed.success ? parsed.data : null,
    status: parsed.success
      ? parsed.data.enabled
        ? "enabled"
        : "disabled"
      : disabled
        ? "disabled"
        : "invalid",
    issues: parsed.success ? [] : ["Stored decision settings are invalid; raw values are hidden."],
  };
}
function readyConnection(id: string, provider: string) {
  if (!idSchema.safeParse(id).success) invalid();
  const connection = readDecisionActivationConnection(id);
  if (
    !connection ||
    connection.provider !== provider ||
    connection.isActive !== true ||
    connection.credentialDecryptFailed
  )
    invalid();
  return connection;
}
function apiKeyOnly(connection: Record<string, unknown>): boolean {
  return (
    connection.authType === "apikey" &&
    typeof connection.apiKey === "string" &&
    !!connection.apiKey.trim() &&
    connection.apiKey === connection.apiKey.trim() &&
    !connection.accessToken &&
    !connection.refreshToken
  );
}
function nativeMetadataMatches(
  provider: string,
  model: string,
  connection: Record<string, unknown>
): boolean {
  const raw = connection.providerSpecificData;
  const metadata = raw == null ? {} : settingsRecord(raw);
  if (!metadata || !compatibleMetadata(provider, metadata)) return false;
  const tier = systemOneModelTier(provider, model);
  if (tier === "free" ? metadata.systemOneTier !== "free" : Object.keys(metadata).length !== 0)
    return false;
  return isConnectionEligibleForTier(tier, connection, provider);
}
function validateNativeSelection(policy: DecisionPolicyEditorValue): void {
  const selection = policy.selection;
  if (selection?.mode !== "native") return;
  if (
    policy.policy.candidates.length < 2 ||
    policy.policy.candidates.length > selection.maxCandidates
  )
    invalid();
  const connection = readyConnection(selection.connectionId, selection.provider);
  if (
    !apiKeyOnly(connection) ||
    !nativeMetadataMatches(selection.provider, selection.model, connection)
  )
    invalid();
  try {
    assertApplicationEgress(
      selection.provider,
      systemOneUrl(selection.provider, {
        apiKey: String(connection.apiKey),
        connectionId: selection.connectionId,
      })
    );
  } catch {
    invalid();
  }
}
type EditorCandidate = DecisionPolicyEditorValue["policy"]["candidates"][number];
function explicitExecutionProfile(candidate: EditorCandidate, nativeOutput: boolean): boolean {
  return (
    candidate.endpointKind === "direct" &&
    candidate.capabilities.text === true &&
    candidate.capabilities.contextTokens !== null &&
    isApplicationEffortSupported(candidate, nativeOutput) &&
    !!candidate.effort.value &&
    !!candidate.effort.supported?.includes(candidate.effort.value)
  );
}
function validateExecutionCandidate(
  policy: DecisionPolicyEditorValue,
  candidate: EditorCandidate,
  comboNames: Set<string>
): void {
  if (comboNames.has(candidate.model) || comboNames.has(`${candidate.provider}/${candidate.model}`))
    invalid();
  const connection = readyConnection(policy.connections[candidate.id], candidate.provider);
  const nativeOutput = policy.applicationMode === "provider-native-output-v1";
  if (!explicitExecutionProfile(candidate, nativeOutput)) invalid();
  if (candidate.provider === "openai" && !apiKeyOnly(connection)) invalid();
  try {
    const contract = resolveApplicationProvider(candidate, connection, nativeOutput);
    assertApplicationEgress(candidate.provider, contract.endpoint);
  } catch {
    invalid();
  }
}
export function validateDecisionPolicyForSave(raw: unknown): void {
  const parsed = decisionPolicyEditorSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const policy = parsed.data;
  if (!policy.enabled) return; // Disabled drafts assert no availability or measured quality.
  if (policy.policy.candidates.length === 0) invalid();
  validateNativeSelection(policy);
  const comboNames = new Set(listDecisionComboNames().map((combo) => combo.name));
  for (const candidate of policy.policy.candidates)
    validateExecutionCandidate(policy, candidate, comboNames);
  const ids = new Set(policy.policy.candidates.map((candidate) => candidate.id));
  if (Object.keys(policy.connections).some((id) => !ids.has(id))) invalid();
}
export function saveDecisionPolicySettings(
  id: string,
  raw: unknown,
  signal?: AbortSignal
): DecisionPolicySettingsView {
  if (!idSchema.safeParse(id).success) invalid();
  const parsed = policyWriteSchema.safeParse(raw);
  if (!parsed.success) invalid();
  compareAndSetDecisionPolicy({
    id,
    expectedRevision: parsed.data.revision,
    action: parsed.data.action,
    policy: parsed.data.action === "save" ? parsed.data.policy : undefined,
    validate: validateDecisionPolicyForSave,
    signal,
  });
  return getDecisionPolicySettings(id);
}
export function saveDecisionConnectionTier(
  id: string,
  raw: unknown,
  signal?: AbortSignal
): DecisionConnectionOption {
  if (!idSchema.safeParse(id).success) invalid();
  const parsed = tierWriteSchema.safeParse(raw);
  if (!parsed.success) invalid();
  compareAndSetZenTier({
    id,
    expectedRevision: parsed.data.revision,
    tier: parsed.data.tier,
    signal,
  });
  const rows = readDecisionConnectionRows();
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw new DecisionSettingsError(404, "not_found");
  return connectionProjection(rows[index], index);
}
async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const parts: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      request.signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) invalid();
      parts.push(next.value);
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      invalid();
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}
function failure(error: unknown, request?: Request): Response {
  const known = error instanceof DecisionSettingsError ? error : null;
  const status = request?.signal.aborted ? 499 : (known?.status ?? 500);
  const code = known?.code ?? "invalid_settings";
  const messages = {
    not_found: "Decision settings were not found",
    stale_revision: "Settings changed; reload before saving",
    invalid_settings: "Unsupported decision routing settings",
    unsupported_connection: "Only OpenCode Zen has this tier setting",
    cancelled: "Settings request cancelled",
  };
  return createErrorResponse({
    status,
    message:
      status === 499
        ? messages.cancelled
        : status === 500
          ? "Decision settings are unavailable"
          : messages[code],
    details: { code: status === 499 ? "cancelled" : code },
  });
}
function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  return response;
}
/** Shared HTTP boundary; no trusted absent-Request shortcut and no raw error echo. */
export async function decisionSettingsApi(
  request: Request,
  operation: (body: unknown) => unknown,
  write = false
): Promise<Response> {
  if (!(request instanceof Request))
    return privateResponse(
      createErrorResponse({ status: 401, message: "Authentication required" })
    );
  try {
    const auth = await requireManagementAuth(request, { alwaysRequireAuth: true });
    if (auth) return privateResponse(auth);
    request.signal.throwIfAborted();
    const body = write ? await boundedJson(request) : null;
    request.signal.throwIfAborted();
    return privateResponse(Response.json(operation(body)));
  } catch (error) {
    return privateResponse(failure(error, request));
  }
}
