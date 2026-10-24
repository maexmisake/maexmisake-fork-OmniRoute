import { z } from "zod";
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
  type ApplicationAttempt,
} from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import {
  fetchSystemOne,
  systemOneHeaders,
  systemOneUrl,
} from "../../../open-sse/handlers/systemOneTransport.ts";
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
  const wire = new Headers(headers);
  return (
    wire.get("authorization") === authorization &&
    wire.get("accept") === "application/json" &&
    wire.get("content-type") === "application/json" &&
    [...wire.keys()].every((key) => ["authorization", "accept", "content-type"].includes(key))
  );
}

const nativeCredentials = z.object({
  connectionId: z.string(),
  apiKey: z.string(),
  accessToken: z.string().nullable().optional(),
  maxConcurrent: z.number().int().nonnegative().nullable().optional(),
  rateLimitMaxConcurrent: z.number().int().nonnegative().nullable().optional(),
  modelConcurrency: z.record(z.string(), z.number().int().nonnegative()).nullable().optional(),
});
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
    const connection = await getProviderConnectionById(plan.config.connections[candidate.id]);
    if (
      !connection ||
      connection.provider !== candidate.provider ||
      connection.isActive !== true ||
      candidate.effort.mode !== "set"
    )
      throw new Error("decision_binding_unsupported");
    const contract = resolveApplicationProvider(candidate, connection);
    assertApplicationEgress(candidate.provider, contract.endpoint);
    if (contract.claude) {
      assertReadyClaudeOAuth(contract.credentials);
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
    candidateId: "native-selector",
    provider: selection.provider,
    model: selection.model,
    connectionId: selection.connectionId,
    effort: "native",
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
    Object.keys(connection.providerSpecificData ?? {}).length
  )
    throw new Error("decision_connection_unsupported");
  const authorization = `Bearer ${connection.apiKey}`;
  const credentials = Object.freeze({
    apiKey: connection.apiKey,
    connectionId: selection.connectionId,
  });
  const endpoint = systemOneUrl(selection.provider, credentials);
  const headers = systemOneHeaders(selection.provider, credentials);
  const plugins = createValidationPluginFence();
  const assertFresh = () => {
    signal.throwIfAborted();
    plugins.assertIdle();
    unchanged();
    for (const item of stamped)
      assertUncappedDecision(keyId, item.provider, item.model, identity.id);
    assertApplicationEgress(selection.provider, endpoint);
  };
  assertFresh();
  let usage = unknownUsage(),
    outcome = "unknown",
    handedOver = false,
    started = false;
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
  return {
    identity,
    assertFresh,
    timedOut: () => deadline.aborted && !handedOver,
    select: async (facts) => {
      const client = nativeDecisionClient({
        id: "application-native",
        model: selection.model,
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
              selected.data.accessToken
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
        /* A durable pending reservation blocks later admission until reconciliation. */
      }
    },
    annotate: (response) => {
      const result = new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
      result.headers.set("x-omniroute-selection-mode", "native");
      result.headers.set("x-omniroute-decision-request", identity.id);
      result.headers.set(
        "x-omniroute-routing-cost",
        JSON.stringify(readLogicalDecisionCost(identity.id))
      );
      return result;
    },
  };
}
