import type { ApplicationToolHooks } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import type { ProviderCredentials } from "../../../open-sse/executors/base/validationDispatch.ts";
import { assertNativeDecisionCodexCredentials } from "../../../open-sse/executors/codex/nativeDecision.ts";
import { CODEX_CHAT_DEFAULT_INSTRUCTIONS } from "../../../open-sse/config/codexInstructions.ts";
import { openaiToOpenAIResponsesRequest } from "../../../open-sse/translator/request/openai-responses/toResponses.ts";
import { sanitizeOpenAITools } from "../../../open-sse/services/toolSchemaSanitizer.ts";
import {
  canonicalClientPrefix,
  canonicalToolJSON,
  parseDecisionToolArguments,
  type InspectedToolRequest,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import {
  normalizeDecisionTextRequest,
  type ChatPolicyBody,
} from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import type { AutomaticPlan } from "./applicationCombo";
import type { AttemptIdentity } from "../db/decisionAttempts";
import { finishDecisionApplicationWithMetadata } from "../db/decisionAttempts";
import {
  claimToolContinuation,
  assertToolContinuationClaim,
  commitToolContinuation,
  commitToolContinuationEnd,
  type PreparedToolContinuation,
  type ToolContinuationRequest,
} from "../db/decisionContinuations";
import { RawCodexToolCollector } from "./codexResponseProof";
import { ClientOpenAIToolCollector, type ClientToolResponseProof } from "./toolResponseProof";
import {
  parseCodexToolReplay,
  restoreCodexToolReplay,
  storeCodexToolReplay,
  discardCodexToolReplay,
} from "./codexToolReplay";

type Json = Record<string, unknown>;
function fail(): never {
  throw new Error("decision_codex_tool_authority_rejected");
}
function same(left: unknown, right: unknown): boolean {
  return canonicalToolJSON(left) === canonicalToolJSON(right);
}
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Json;
}
function crossCheck(
  raw: { calls: Array<{ id: string; name: string; arguments: string }>; assistantText: string },
  client: ClientToolResponseProof
): void {
  if (
    raw.calls.length !== client.calls.length ||
    raw.assistantText !== (client.assistant.content ?? "")
  )
    fail();
  raw.calls.forEach((call, index) => {
    const other = client.calls[index];
    if (
      call.id !== other.id ||
      call.name !== other.name ||
      !same(parseDecisionToolArguments(call.arguments), parseDecisionToolArguments(other.arguments))
    )
      fail();
  });
}
/** Native items are private origin-bound replay, never reconstructed from client reasoning. */
export class ApplicationCodexTools {
  private replay: Record<string, string> = {};
  private items = new Map<number, Json[]>();
  private attached = false;
  constructor(
    private plan: AutomaticPlan,
    private keyId: string,
    private request: InspectedToolRequest,
    private continuation?: PreparedToolContinuation,
    private proof?: ToolContinuationRequest
  ) {
    if (plan.config.applicationMode !== "provider-native-output-v1" || !plan.config.nativeOutput)
      fail();
    if (!continuation) return;
    if (continuation.replayOrigins.length !== request.history.length) fail();
    continuation.replayOrigins.forEach((origin, index) => {
      if (!origin.requiresThinkingReplay) fail();
      const identity = {
        ...continuation.binding,
        id: origin.sourceAttemptId,
        keyId,
        comboId: plan.comboId,
      };
      const value = restoreCodexToolReplay(identity);
      this.replay[origin.sourceAttemptId] = value;
      this.items.set(
        request.history[index].assistantIndex,
        parseCodexToolReplay(value, identity).items
      );
    });
  }
  claim(identity: AttemptIdentity): void {
    if (!this.proof) fail();
    claimToolContinuation(this.proof, identity, this.replay);
  }
  assertFresh(identity: AttemptIdentity): void {
    if (this.proof) assertToolContinuationClaim(this.proof, identity, this.replay);
  }
  private projection(body: ChatPolicyBody, model: string, credentials: ProviderCredentials): Json {
    const value = record(openaiToOpenAIResponsesRequest(model, body, true, credentials));
    for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
      delete value[field];
    if (value.instructions === "") value.instructions = CODEX_CHAT_DEFAULT_INSTRUCTIONS;
    if (value.store === undefined) value.store = false;
    return value;
  }
  private prepareRequest(
    identity: AttemptIdentity,
    model: string,
    body: Json,
    stream: boolean,
    rawCredentials: Json | null
  ): Json {
    if (!stream || model !== identity.model || !rawCredentials) fail();
    const credentials = rawCredentials as ProviderCredentials;
    assertNativeDecisionCodexCredentials(credentials);
    if (credentials.connectionId !== identity.connectionId) fail();
    const accepted = normalizeDecisionTextRequest({
      ...this.request.body,
      reasoning_effort: identity.effort,
    });
    if (!accepted) fail();
    const original = this.projection(accepted, model, credentials);
    const preparedBody = normalizeDecisionTextRequest({
      ...accepted,
      tools: sanitizeOpenAITools(accepted.tools ?? []),
    });
    if (!preparedBody) fail();
    const prepared = this.projection(preparedBody, model, credentials);
    if (!same(body, original) && !same(body, prepared)) fail();
    return {
      ...original,
      // The shared Chat→Responses formatter omits this client control. Preserve
      // the exact accepted value only inside the guarded native contract.
      ...(accepted.parallel_tool_calls === undefined
        ? {}
        : { parallel_tool_calls: accepted.parallel_tool_calls }),
      input: this.replayInput(accepted, original.input as Json[], model, credentials),
    };
  }
  private replayInput(
    accepted: ChatPolicyBody,
    input: Json[],
    model: string,
    credentials: ProviderCredentials
  ): Json[] {
    const restored: Json[] = [];
    let cursor = 0;
    for (const [index, message] of accepted.messages.entries()) {
      if (!message.tool_calls?.length) continue;
      const items = this.items.get(index);
      if (!items) fail();
      // Only this single assistant shape is projected for matching. Its synthetic
      // missing-result placeholders are excluded; actual results come unchanged
      // from the COMPLETE accepted transcript below, never a partial prefix.
      const shape = (
        this.projection({ ...accepted, messages: [message] }, model, credentials).input as Json[]
      ).filter((item) => item.type !== "function_call_output");
      if (!shape.length) fail();
      const offset = input.findIndex(
        (_, position) =>
          position >= cursor && same(input.slice(position, position + shape.length), shape)
      );
      if (offset < cursor) fail();
      restored.push(...input.slice(cursor, offset), ...structuredClone(items));
      cursor = offset + shape.length;
    }
    restored.push(...input.slice(cursor));
    return restored;
  }
  attach(identity: AttemptIdentity, authority: string): ApplicationToolHooks {
    if (identity.provider !== "codex" || this.attached) fail();
    this.attached = true;
    const names = (this.request.body.tools ?? []).map((tool) => tool.function.name);
    const raw = new RawCodexToolCollector({
      model: identity.model,
      allowedNames: names,
      allowToolUse: this.request.body.tool_choice !== "none",
    });
    const client = new ClientOpenAIToolCollector(identity.model);
    let rawProof: ReturnType<typeof raw.finish> | null = null;
    let clientProof: ClientToolResponseProof | null = null;
    let rawVerified = false,
      validated = false,
      published = false;
    return {
      codexRequest: (model, body, stream, credentials) =>
        this.prepareRequest(identity, model, body, stream, credentials),
      beforeFetch: () => this.request.body.messages,
      restoreThinking: () => fail(),
      preserveWireThinking: () => fail(),
      rawEvent: (event) => raw.accept(event),
      rawComplete: () => {
        rawProof = raw.finish();
        rawVerified = true;
      },
      clientFrame: (payload, done) => {
        if (done) {
          client.done();
          return true;
        }
        return payload === undefined ? false : client.accept(payload).completion;
      },
      validateClientComplete: (status) => {
        if (validated || !rawVerified) fail();
        clientProof = client.finish();
        if ((clientProof && status >= 400) || Boolean(rawProof) !== Boolean(clientProof)) fail();
        if (rawProof && clientProof) crossCheck(rawProof, clientProof);
        validated = true;
      },
      commitClientComplete: () => {
        if (published || !validated || !rawVerified) fail();
        this.commit(identity, authority, rawProof, clientProof);
        published = true;
      },
    };
  }
  private commit(
    identity: AttemptIdentity,
    authority: string,
    raw: {
      items: Json[];
      calls: Array<{ id: string; name: string; arguments: string }>;
      assistantText: string;
    } | null,
    client: ClientToolResponseProof | null
  ): void {
    if (!client) {
      if (raw) fail();
      if (this.continuation) commitToolContinuationEnd(this.continuation.turnId, identity);
      else finishDecisionApplicationWithMetadata(identity, () => {});
      return;
    }
    if (!raw) fail();
    crossCheck(raw, client);
    if (this.request.body.parallel_tool_calls === false && client.calls.length > 1) fail();
    const replay = storeCodexToolReplay(identity, raw.items);
    try {
      commitToolContinuation(identity, {
        clientPrefixJSON: canonicalClientPrefix([
          ...this.request.body.messages,
          client.assistant as ChatPolicyBody["messages"][number],
        ]),
        toolContractJSON: this.request.toolContractJSON,
        calls: client.calls,
        thinkingBlocksJSON: replay,
        expectedPolicy: this.plan.sourcePolicy,
        expectedAuthority: authority,
        ...(this.continuation ? { previousTurnId: this.continuation.turnId } : {}),
      });
    } catch (error) {
      discardCodexToolReplay(identity, replay);
      throw error;
    }
  }
}
