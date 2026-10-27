import { randomUUID } from "node:crypto";
import type { DecisionPolicyEditorValue } from "../../shared/decisionPolicy/configuration";
import type { ApplicationAttempt } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import { canonicalToolJSON } from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import {
  assertResponseHistoryAllowed,
  readResponseHistory,
  reserveResponseHistory,
  admitResponseHistoryOrigin,
  publishResponseHistory,
  releaseResponseHistory,
  type ResponseHistoryOrigin,
  type ResponseHistorySlot,
  type ResponseHistoryLimits,
} from "../db/decisionResponses";
import {
  completeRoutingSession,
  releaseRoutingSession,
  type SessionClaim,
  type SessionPolicy,
} from "../db/decisionSessions";
import {
  finishDecisionApplication,
  finishDecisionApplicationWithMetadata,
  type AttemptIdentity,
} from "../db/decisionAttempts";
import {
  applicationResponsesIntent,
  applicationResponsesHistoryInput,
  prepareApplicationResponses,
  type ResponsesResultOptions,
} from "./applicationResponses";
import type { SessionInput } from "./applicationSession";

export type ApplicationResponsesState = {
  id: string;
  store: boolean;
  history: unknown[];
  origin?: ResponseHistoryOrigin;
};
const fail = (): never => {
  throw new Error("decision_responses_history_rejected");
};
function responseSession(
  input: SessionInput | undefined,
  origin: ResponseHistoryOrigin | undefined,
  store: boolean
): SessionInput | undefined {
  if (origin) {
    if (input && (input.locator !== origin.sessionId || input.boundary)) fail();
    return { locator: origin.sessionId, boundary: false };
  }
  return store && !input ? { locator: "new", boundary: false } : input;
}
export function prepareResponsesRouting(input: {
  client: unknown;
  working: unknown;
  keyId: string;
  comboId: string;
  policy: string;
  config: Pick<DecisionPolicyEditorValue, "responses" | "sessions">;
  sessionInput?: SessionInput;
  echo: boolean;
}) {
  const intent = applicationResponsesIntent(input.client);
  if (input.echo) fail();
  if (intent.store || intent.previous) {
    if (!input.config.responses || !input.config.sessions) fail();
    assertResponseHistoryAllowed(input.keyId);
  }
  const origin = intent.previous
    ? readResponseHistory(intent.previous, input.keyId, input.comboId, input.policy)
    : undefined;
  const body = prepareApplicationResponses(input.client, origin?.messages);
  if (
    canonicalToolJSON(body) !==
    canonicalToolJSON(prepareApplicationResponses(input.working, origin?.messages))
  )
    fail();
  const state: ApplicationResponsesState = {
    id: "resp_" + randomUUID(),
    store: intent.store,
    history: applicationResponsesHistoryInput(input.client, origin?.messages),
    origin,
  };
  if (state.store && state.history.length >= 128) fail();
  return { body, state, sessionInput: responseSession(input.sessionInput, origin, intent.store) };
}
export function reserveApplicationResponse(
  state: ApplicationResponsesState | undefined,
  session: SessionClaim | undefined,
  policy: string,
  limits: ResponseHistoryLimits | undefined,
  timeoutMs: number
): ResponseHistorySlot | undefined {
  if (
    state?.origin &&
    canonicalToolJSON(session?.binding) !== canonicalToolJSON(state.origin.binding)
  )
    fail();
  if (!state?.store) {
    if (state?.origin) {
      if (!session) fail();
      admitResponseHistoryOrigin(state.origin, session!, policy);
    }
    return;
  }
  if (!session || !limits) fail();
  const slot: ResponseHistorySlot = { id: state.id, claim: session!, policy, limits: limits! };
  reserveResponseHistory(slot, timeoutMs, state.origin);
  return slot;
}
export function createResponsesResultOptions(input: {
  state: ApplicationResponsesState | undefined;
  attempt: ApplicationAttempt & AttemptIdentity;
  signal: AbortSignal;
  session?: SessionClaim;
  slot?: ResponseHistorySlot;
  sessionPolicy?: SessionPolicy;
  failureStatus: () => number;
}): ResponsesResultOptions | undefined {
  const { state, attempt, signal, session, slot } = input;
  if (!state) return;
  let committed = false;
  let preparedTools: (() => void) | undefined;
  return {
    id: state.id,
    store: state.store,
    streaming: attempt.stream?.active === true,
    signal,
    prepare: (commitTools) => {
      if (preparedTools) fail();
      preparedTools = commitTools;
    },
    reportedUsage: () => attempt.stream?.reportedClientUsage() ?? null,
    complete: (assistant) => {
      signal.throwIfAborted();
      if (attempt.stream?.active && !preparedTools) fail();
      const publish = () => {
        signal.throwIfAborted();
        preparedTools?.();
        if (slot) publishResponseHistory(slot, attempt, [...state.history, assistant]);
      };
      if (session) completeRoutingSession(session, attempt, input.sessionPolicy!, publish);
      else finishDecisionApplicationWithMetadata(attempt, publish);
      committed = true;
    },
    release: () => {
      try {
        if (slot) releaseResponseHistory(slot, attempt);
      } finally {
        if (session) releaseRoutingSession(session);
      }
    },
    fail: () => {
      if (!committed)
        finishDecisionApplication(attempt.id, signal.aborted ? input.failureStatus() : 409);
    },
  };
}
