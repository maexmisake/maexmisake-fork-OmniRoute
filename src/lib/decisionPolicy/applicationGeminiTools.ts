import type { ApplicationToolHooks } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import type { ProviderCredentials } from "../../../open-sse/executors/base/validationDispatch.ts";
import { assertBoundedAgyCredentials } from "../../../open-sse/executors/antigravity/bounded.ts";
import { sanitizeOpenAITools } from "../../../open-sse/services/toolSchemaSanitizer.ts";
import {
  canonicalClientPrefix,
  canonicalToolJSON,
  inspectToolRequest,
  type InspectedToolRequest,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import type { ChatPolicyBody } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
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
import { GeminiToolClient } from "./geminiToolClient";
import { RawGeminiToolCollector, type GeminiToolTurnProof } from "./geminiToolResponseProof";
import {
  ClientOpenAIToolCollector,
  crossCheckToolCalls,
  type ClientToolResponseProof,
} from "./toolResponseProof";
import { buildGeminiToolWire, assertGeminiToolWire } from "./geminiToolWire";
import {
  assertGeminiReplayIdentity,
  parseGeminiToolReplay,
  restoreGeminiToolReplay,
  storeGeminiToolReplay,
  discardGeminiToolReplay,
} from "./geminiToolReplay";

type Json = Record<string, unknown>;
function fail(): never {
  throw new Error("decision_gemini_tool_authority_rejected");
}
function same(left: unknown, right: unknown): boolean {
  return canonicalToolJSON(left) === canonicalToolJSON(right);
}
function assertPreparedRequest(raw: Json, expected: InspectedToolRequest, effort: string): void {
  const actual = inspectToolRequest(raw);
  if (!actual) throw new Error("decision_gemini_tool_request_unsupported");
  // chatCore runs this exact sanitizer before the native request hook (for
  // example, it makes an opaque object's default openness explicit). Recognize
  // only that prepared transformation; the final native wire still uses the
  // original accepted declarations, never the sanitizer's lossy schema output.
  const prepared = inspectToolRequest({
    ...expected.body,
    tools: sanitizeOpenAITools(expected.body.tools ?? []),
  });
  if (!prepared) throw new Error("decision_gemini_tool_request_unsupported");
  const checks = [
    ["stream", actual.body.stream === true],
    ["effort", actual.body.reasoning_effort === effort],
    ["output", actual.body.max_completion_tokens === expected.body.max_completion_tokens],
    ["contract", actual.toolContractJSON === prepared.toolContractJSON],
    ["messages", same(actual.body.messages, expected.body.messages)],
  ] as const;
  const failed = checks.find(([, matches]) => !matches);
  if (failed) throw new Error("decision_gemini_tool_" + failed[0] + "_changed");
}
/** Provider-specific strategy inside the existing application continuation transaction. */
export class ApplicationGeminiTools {
  private replay: Record<string, string> = {};
  private parts = new Map<number, readonly Json[]>();
  private expectedWire?: Json;
  private attached = false;
  constructor(
    private plan: AutomaticPlan,
    private keyId: string,
    private request: InspectedToolRequest,
    private continuation?: PreparedToolContinuation,
    private proof?: ToolContinuationRequest
  ) {
    if (!continuation) return;
    if (continuation.replayOrigins.length !== request.history.length) fail();
    continuation.replayOrigins.forEach((origin, index) => {
      if (!origin.requiresThinkingReplay) fail();
      const value = restoreGeminiToolReplay({
        ...continuation.binding,
        id: origin.sourceAttemptId,
        keyId,
        comboId: plan.comboId,
      });
      this.replay[origin.sourceAttemptId] = value;
      this.parts.set(request.history[index].assistantIndex, parseGeminiToolReplay(value));
    });
  }
  claim(identity: AttemptIdentity): void {
    if (!this.proof) fail();
    claimToolContinuation(this.proof, identity, this.replay);
  }
  assertFresh(identity: AttemptIdentity): void {
    if (this.proof) assertToolContinuationClaim(this.proof, identity, this.replay);
  }
  private prepareRequest(
    identity: AttemptIdentity,
    model: string,
    body: Json,
    stream: boolean,
    rawCredentials: Json | null
  ): Json {
    if (model !== identity.model || !stream || !rawCredentials) fail();
    const credentials = rawCredentials as ProviderCredentials;
    assertBoundedAgyCredentials(credentials);
    if (credentials.connectionId !== identity.connectionId) fail();
    assertPreparedRequest(body, this.request, identity.effort);
    const project = credentials.projectId ?? credentials.providerSpecificData?.projectId;
    if (typeof project !== "string") fail();
    this.expectedWire = buildGeminiToolWire(this.request.body, model, project, this.parts);
    return structuredClone(this.expectedWire);
  }
  attach(identity: AttemptIdentity, authority: string): ApplicationToolHooks {
    assertGeminiReplayIdentity(identity);
    if (this.attached) fail();
    this.attached = true;
    const names = new Set((this.request.body.tools ?? []).map((tool) => tool.function.name));
    const raw = new RawGeminiToolCollector({
      model: identity.model,
      allowedNames: names,
      allowToolUse: this.request.body.tool_choice !== "none",
    });
    const client = new ClientOpenAIToolCollector(identity.model);
    const translator = new GeminiToolClient(identity.model, "chatcmpl-" + identity.id, names);
    let rawVerified = false,
      terminalValidated = false,
      published = false;
    let rawProof: GeminiToolTurnProof | null = null;
    let clientProof: ClientToolResponseProof | null = null;
    return {
      geminiRequest: (model, body, stream, credentials) =>
        this.prepareRequest(identity, model, body, stream, credentials),
      geminiResponse: (frame) => translator.accept(frame),
      beforeFetch: (wire) => {
        if (!this.expectedWire) fail();
        assertGeminiToolWire(wire, this.expectedWire);
        return this.request.body.messages;
      },
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
        if (terminalValidated || !rawVerified) fail();
        // The core can pre-read raw EOF before translating buffered frames.
        // Seal projection only at client completion, after every frame arrived.
        translator.finish();
        clientProof = client.finish();
        if (clientProof && status >= 400) fail();
        if (Boolean(rawProof) !== Boolean(clientProof)) fail();
        if (rawProof && clientProof) this.crossCheck(rawProof, clientProof, names);
        terminalValidated = true;
      },
      commitClientComplete: () => {
        if (published || !rawVerified || !terminalValidated) fail();
        this.commit(identity, authority, rawProof, clientProof);
        published = true;
      },
    };
  }
  private crossCheck(
    raw: GeminiToolTurnProof,
    client: ClientToolResponseProof,
    names: Set<string>
  ) {
    crossCheckToolCalls(raw, client, (name) => (names.has(name) ? name : fail()));
    const text = raw.parts
      .filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text !== (client.assistant.content ?? "")) fail();
  }
  private commit(
    identity: AttemptIdentity,
    authority: string,
    raw: GeminiToolTurnProof | null,
    client: ClientToolResponseProof | null
  ): void {
    if (!client) {
      if (raw) fail();
      if (this.continuation) commitToolContinuationEnd(this.continuation.turnId, identity);
      else finishDecisionApplicationWithMetadata(identity, () => {});
      return;
    }
    if (!raw) fail();
    const replay = storeGeminiToolReplay(identity, raw.parts);
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
      // Physical usage was settled independently. A failed/uncertain DB publish
      // cannot retain reusable private authority or trigger another execution.
      discardGeminiToolReplay(identity, replay);
      throw error;
    }
  }
}
