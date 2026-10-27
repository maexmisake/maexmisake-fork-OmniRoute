import { assertNativeConnectionUnleased } from "./exclusiveLease";
import { z } from "zod";
import { buildErrorBody } from "../../../open-sse/utils/error.ts";
import {
  projectSystemOneFailure,
  systemOneSensitiveValues,
  systemOneRetryAfter,
  type SystemOneFailureDiagnostic,
} from "../../../open-sse/handlers/systemOneDiagnostics.ts";
import { randomUUID } from "node:crypto";
import type {
  Candidate,
  PolicyRequest,
} from "../../../open-sse/services/decisionPolicy/contract.ts";
import {
  nativeDecisionClient,
  nativeReportedCost,
} from "../../../open-sse/services/decisionPolicy/nativeSelector.ts";
import {
  withApplicationAttempt,
  isAgyApplicationContract,
  type ApplicationAttempt,
} from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import {
  fetchSystemOne,
  hasExactSystemOneHeaders,
  systemOneHeaders,
  systemOneUrl,
  type SystemOneCredentials,
} from "../../../open-sse/handlers/systemOneTransport.ts";
import {
  isConnectionEligibleForTier,
  systemOneModelTier,
} from "../../../open-sse/config/systemOneRegistry.ts";
import { runWithSharedCapacity } from "../../../open-sse/handlers/systemOneCapacity.ts";
import { getExecutor } from "../../../open-sse/executors/index.ts";
import { getProviderCredentialsWithQuotaPreflight } from "../../sse/services/auth";
import { getApiKeyById, isModelAllowedForKey } from "../db/apiKeys";
import { getComboByName } from "../db/combos";
import { getProviderConnectionById } from "../db/providers";
import { createValidationPluginFence } from "../modelValidation/pluginFence";
import {
  assertUncappedDecision,
  decisionAuthorityStamp,
  reserveDecisionAttempt,
  assertDecisionLease,
  releaseDecisionAttempt,
  startDecisionAttempt,
  finishNativeDecision,
  handoverNativeDecision,
  readLogicalDecisionCost,
  type AttemptIdentity,
  type AttemptUsage,
} from "../db/decisionAttempts";
import {
  assertApplicationEgress,
  resolveApplicationProvider,
  assertReadyClaudeOAuth,
  isApplicationEffortSupported,
} from "./applicationProvider";
import type { AutomaticPlan } from "./applicationCombo";

export type NativeStage = {
  identity: AttemptIdentity;
  select: (facts: PolicyRequest) => Promise<Candidate>;
  assertFresh: () => void;
  handover: (child: AttemptIdentity) => void;
  finishFailure: (status: number) => void;
  timedOut: () => boolean;
  annotate: (response: Response) => Response;
};
function validNativeHeaders(headers: HeadersInit | undefined, authorization: string): boolean {
  return hasExactSystemOneHeaders(headers, authorization);
}

const nativeCredentials = z.object({
  connectionId: z.string(),
  apiKey: z.string(),
  accessToken: z.string().nullable().optional(),
  providerSpecificData: z.record(z.string(), z.unknown()).nullable().optional(),
  maxConcurrent: z.number().int().nonnegative().nullable().optional(),
  rateLimitMaxConcurrent: z.number().int().nonnegative().nullable().optional(),
  modelConcurrency: z.record(z.string(), z.number().int().nonnegative()).nullable().optional(),
});
const emptyNativeMetadata = z.object({}).strict();
const freeNativeMetadata = z.object({ systemOneTier: z.literal("free") }).strict();

/** The free marker is our routing guard, never a provider entitlement claim.
 * Other connection metadata cannot inject native headers or destinations. */
function eligibleNativeCredentials(
  provider: string,
  model: string,
  credentials: SystemOneCredentials
): boolean {
  const tier = systemOneModelTier(provider, model);
  const schema = tier === "free" ? freeNativeMetadata : emptyNativeMetadata;
  return (
    schema.safeParse(credentials.providerSpecificData ?? {}).success &&
    isConnectionEligibleForTier(tier, credentials, provider)
  );
}
const unknownUsage = (): AttemptUsage => ({ status: null, input: null, output: null, cost: null });
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("decision_response_incomplete");
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) throw new Error("decision_response_too_large");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}
async function validateExecutionBindings(
  plan: AutomaticPlan,
  candidates: Candidate[],
  permitted: (provider: string, model: string, connectionId: string) => Promise<void>
) {
  for (const candidate of candidates) {
    await permitted(candidate.provider, candidate.model, plan.config.connections[candidate.id]);
    if (
      (await getComboByName(candidate.model)) ||
      (await getComboByName(`${candidate.provider}/${candidate.model}`))
    )
      throw new Error("decision_recursion_rejected");
    assertNativeConnectionUnleased(plan.config.connections[candidate.id]);
    const connection = await getProviderConnectionById(plan.config.connections[candidate.id]);
    if (
      !connection ||
      connection.provider !== candidate.provider ||
      connection.isActive !== true ||
      !isApplicationEffortSupported(
        candidate,
        plan.config.applicationMode === "provider-native-output-v1"
      )
    )
      throw new Error("decision_binding_unsupported");
    const contract = resolveApplicationProvider(
      candidate,
      connection,
      plan.config.applicationMode === "provider-native-output-v1"
    );
    assertApplicationEgress(candidate.provider, contract.endpoint);
    if (isAgyApplicationContract(contract.executionContract))
      assertApplicationEgress("antigravity", contract.endpoint);
    if (contract.claude || contract.executionContract) {
      if (contract.claude) assertReadyClaudeOAuth(contract.credentials);
      if ((await getExecutor(candidate.provider)).needsRefresh(contract.credentials))
        throw new Error("decision_oauth_unsupported");
    }
  }
}

/** Narrow application binding: native selection has one authorized transport and no recovery. */
export async function prepareNativeStage(
  plan: AutomaticPlan,
  candidates: Candidate[],
  keyId: string,
  signal: AbortSignal
): Promise<NativeStage> {
  const selection = plan.config.selection;
  if (selection?.mode !== "native") throw new Error("decision_mode_invalid");
  if (candidates.length < 2 || candidates.length > selection.maxCandidates)
    throw new Error("decision_no_route");
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId,
    comboId: plan.comboId,
    requestedModel: plan.name,
    candidateId: "native-selector",
    provider: selection.provider,
    model: selection.model,
    connectionId: selection.connectionId,
    effort: "native",
    ...(plan.config.applicationMode === "provider-native-output-v1"
      ? { outputPolicy: "provider-native" as const }
      : {}),
    lane: "decision",
  };
  identity.requestId = identity.id;
  const stamped = [
    identity,
    ...candidates.map((candidate) => ({
      ...identity,
      candidateId: candidate.id,
      provider: candidate.provider,
      model: candidate.model,
      effort: candidate.effort.value ?? "",
      connectionId: plan.config.connections[candidate.id],
    })),
  ];
  const stamps = stamped.map((item) => decisionAuthorityStamp(item, plan.sourcePolicy));
  const unchanged = () =>
    stamped.forEach((item, index) => {
      if (decisionAuthorityStamp(item, plan.sourcePolicy) !== stamps[index])
        throw new Error("decision_authority_changed");
    });
  const key = await getApiKeyById(keyId);
  if (!key) throw new Error("decision_key_unavailable");
  if (key.allowedQuotas?.length) throw new Error("decision_quota_scope_unsupported");
  const permitted = async (provider: string, model: string, connectionId: string) => {
    if (
      (key.allowedConnections?.length && !key.allowedConnections.includes(connectionId)) ||
      !(await isModelAllowedForKey(String(key.key), `${provider}/${model}`))
    )
      throw new Error("decision_connection_unauthorized");
  };
  await permitted(selection.provider, selection.model, selection.connectionId);
  if (
    Array.isArray(key.allowedEndpoints) &&
    key.allowedEndpoints.length &&
    !key.allowedEndpoints.includes("systemone")
  )
    throw new Error("decision_endpoint_unauthorized");
  await validateExecutionBindings(plan, candidates, permitted);
  assertNativeConnectionUnleased(selection.connectionId);
  const connection = await getProviderConnectionById(selection.connectionId);
  if (
    !connection ||
    connection.provider !== selection.provider ||
    !connection.isActive ||
    connection.authType !== "apikey" ||
    typeof connection.apiKey !== "string" ||
    !connection.apiKey.trim() ||
    connection.apiKey !== connection.apiKey.trim() ||
    connection.accessToken ||
    connection.refreshToken ||
    !eligibleNativeCredentials(selection.provider, selection.model, connection)
  )
    throw new Error("decision_connection_unsupported");
  const authorization = `Bearer ${connection.apiKey}`;
  const credentials = Object.freeze({
    apiKey: connection.apiKey,
    connectionId: selection.connectionId,
    ...(connection.providerSpecificData?.systemOneTier === "free"
      ? { providerSpecificData: Object.freeze({ systemOneTier: "free" }) }
      : {}),
  });
  const endpoint = systemOneUrl(selection.provider, credentials);
  const headers = systemOneHeaders(selection.provider, credentials);
  const plugins = createValidationPluginFence();
  let reserved = false,
    handedOver = false;
  const assertFresh = () => {
    signal.throwIfAborted();
    assertNativeConnectionUnleased(selection.connectionId);
    for (const candidate of candidates)
      assertNativeConnectionUnleased(plan.config.connections[candidate.id]);
    if (reserved && !handedOver) assertDecisionLease(identity);
    plugins.assertIdle();
    unchanged();
    for (const item of stamped)
      assertUncappedDecision(keyId, item.provider, item.model, identity.id, plan.name);
    assertApplicationEgress(selection.provider, endpoint);
  };
  assertFresh();
  let usage = unknownUsage(),
    outcome = "unknown",
    started = false;
  let failureDiagnostic: SystemOneFailureDiagnostic | null = null;
  let failureRetryAfter: string | null = null;
  let selectedCandidate: Candidate | undefined;
  let expectedBody = "",
    decoded: Record<string, unknown> | null = null;
  const deadline = AbortSignal.timeout(selection.timeoutMs);
  const decisionSignal = AbortSignal.any([signal, deadline]);
  const phase: ApplicationAttempt = {
    ...identity,
    signal: decisionSignal,
    assertIdle: plugins.assertIdle,
    assertFresh: () => {
      decisionSignal.throwIfAborted();
      assertFresh();
    },
    fence: () => {
      throw new Error("decision_recursion_rejected");
    },
    dispatch: {
      singleAttempt: true,
      reject() {
        throw new Error("decision_dispatch_rejected");
      },
      beforeFetch(details) {
        decisionSignal.throwIfAborted();
        assertFresh();
        if (
          started ||
          details.provider !== selection.provider ||
          details.model !== selection.model ||
          details.url !== endpoint ||
          details.credentials.connectionId !== selection.connectionId ||
          details.credentials.apiKey !== credentials.apiKey ||
          details.credentials.accessToken ||
          !eligibleNativeCredentials(selection.provider, selection.model, details.credentials) ||
          details.body !== expectedBody ||
          !validNativeHeaders(details.headers, authorization)
        )
          throw new Error("decision_identity_changed");
        startDecisionAttempt(identity);
        started = true;
      },
    },
    observe: async (send) => {
      const response = await send;
      const text = await readBounded(response, decisionSignal);
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          decoded = parsed as Record<string, unknown>;
      } catch {
        /* Invalid JSON still records the physical HTTP outcome. */
      }
      if (!response.ok) {
        failureDiagnostic = projectSystemOneFailure({
          status: response.status,
          body: decoded,
          bodyText: text,
          authenticated: true,
          sensitiveValues: systemOneSensitiveValues([
            credentials.apiKey,
            selection.connectionId,
            keyId,
            identity.id,
            JSON.parse(expectedBody),
          ]),
        });
        failureRetryAfter = systemOneRetryAfter(response.headers.get("retry-after"));
      }
      const raw = decoded?.usage as Record<string, unknown> | undefined;
      usage = {
        status: response.status,
        input: count(raw?.input_tokens),
        output: count(raw?.output_tokens),
        cost: decoded ? nativeReportedCost(decoded) : null,
      };
      decisionSignal.throwIfAborted();
      return new Response(null, { status: response.status });
    },
  };
  reserveDecisionAttempt(identity);
  reserved = true;
  return {
    identity,
    assertFresh,
    timedOut: () => deadline.aborted && !handedOver,
    select: async (facts) => {
      const client = nativeDecisionClient({
        id: "application-native",
        model: selection.model,
        provider: selection.provider,
        connectionId: selection.connectionId,
        guidanceDisclosure: selection.guidanceDisclosure,
        call: async (body) => {
          expectedBody = JSON.stringify(body);
          if (Buffer.byteLength(expectedBody) > 65536)
            throw new Error("decision_request_too_large");
          return withApplicationAttempt(phase, async () => {
            const selected = nativeCredentials.safeParse(
              await getProviderCredentialsWithQuotaPreflight(
                selection.provider,
                null,
                [selection.connectionId],
                selection.model
              )
            );
            phase.assertFresh();
            if (
              !selected.success ||
              selected.data.connectionId !== selection.connectionId ||
              selected.data.apiKey !== credentials.apiKey ||
              selected.data.accessToken ||
              !eligibleNativeCredentials(selection.provider, selection.model, selected.data)
            )
              throw new Error("decision_credentials_changed");
            const response = await runWithSharedCapacity(
              {
                provider: selection.provider,
                body,
                credentials: selected.data,
                timeoutMs: selection.timeoutMs,
              },
              decisionSignal,
              () =>
                fetchSystemOne(endpoint, credentials, {
                  method: "POST",
                  headers,
                  body: expectedBody,
                  signal: decisionSignal,
                })
            );
            if (response.status === 200 && decoded?.model !== selection.model)
              throw new Error("decision_response_identity");
            return { status: response.status, body: decoded ?? {} };
          });
        },
      });
      const result = await client.select(candidates, facts, decisionSignal);
      outcome = result.status;
      decisionSignal.throwIfAborted();
      assertFresh();
      if (result.status !== "selected") throw new Error(`decision_${result.status}`);
      const selected = candidates.find((candidate) => candidate.id === result.optionId);
      if (!selected) throw new Error("decision_invalid");
      selectedCandidate = selected;
      return selected;
    },
    handover: (child) => {
      if (
        !selectedCandidate ||
        child.candidateId !== selectedCandidate.id ||
        child.provider !== selectedCandidate.provider ||
        child.model !== selectedCandidate.model ||
        child.effort !== selectedCandidate.effort.value ||
        child.connectionId !== plan.config.connections[selectedCandidate.id]
      )
        throw new Error("decision_selection_changed");
      assertFresh();
      decisionSignal.throwIfAborted();
      handoverNativeDecision(identity, child, usage);
      handedOver = true;
    },
    finishFailure: (status) => {
      if (handedOver) return;
      try {
        finishNativeDecision(
          identity,
          usage,
          outcome === "selected" ? "selection_unavailable" : outcome,
          status
        );
      } catch {
        /* The durable receipt remains unresolved; no dispatch is replayed. */
      } finally {
        try {
          releaseDecisionAttempt(identity);
        } catch {
          // No fallback or replay; the durable pending receipt remains authoritative.
        }
      }
    },
    annotate: (response) => {
      const diagnostic =
        response.status === 409 &&
        ["decision_auth", "decision_denied", "decision_retryable", "decision_invalid"].includes(
          response.headers.get("x-omniroute-decision-reason") ?? ""
        )
          ? failureDiagnostic
          : null;
      const result = new Response(
        diagnostic
          ? JSON.stringify(
              buildErrorBody(response.status, diagnostic.message, diagnostic.details, {
                code: "decision_application_rejected",
              })
            )
          : response.body,
        {
          status: response.status,
          headers: response.headers,
        }
      );
      if (diagnostic) {
        result.headers.set("x-omniroute-provider-error-kind", diagnostic.kind);
        result.headers.set("x-omniroute-provider-auth-scope", diagnostic.authScope);
        if (failureRetryAfter) result.headers.set("retry-after", failureRetryAfter);
      }
      result.headers.set("x-omniroute-selection-mode", "native");
      result.headers.set("x-omniroute-decision-request", identity.id);
      try {
        const cost = readLogicalDecisionCost(identity.id);
        result.headers.set("x-omniroute-routing-cost", JSON.stringify(cost));
        result.headers.set(
          "x-omniroute-routing-cost-status",
          cost.totalUsd === null ? "unknown" : "known"
        );
      } catch {
        // Response annotation cannot replay already-settled decision/execution work.
        result.headers.delete("x-omniroute-routing-cost");
        result.headers.set("x-omniroute-routing-cost-status", "unknown");
      }
      return result;
    },
  };
}
