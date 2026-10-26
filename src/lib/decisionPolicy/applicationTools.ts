import type { ApplicationToolHooks } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import {
  canonicalClientPrefix,
  canonicalToolJSON,
  inspectToolRequest,
  type InspectedToolRequest,
} from "../../../open-sse/services/decisionPolicy/toolContract.ts";
import type { ChatPolicyBody } from "../../../open-sse/services/decisionPolicy/requestFacts.ts";
import type { AutomaticPlan } from "./applicationCombo";
import { ApplicationGeminiTools } from "./applicationGeminiTools";
import type { AttemptIdentity } from "../db/decisionAttempts";
import { finishDecisionApplicationWithMetadata } from "../db/decisionAttempts";
import {
  prepareToolContinuation,
  claimToolContinuation,
  assertToolContinuationClaim,
  commitToolContinuation,
  commitToolContinuationEnd,
  type PreparedToolContinuation,
  type ToolContinuationRequest,
} from "../db/decisionContinuations";
import {
  restoreClaudeThinkingBlocks,
  storeClaudeThinkingBlocks,
  type ClaudeSignedThinkingBlock,
} from "../../../open-sse/services/claudeThinkingStore.ts";
import {
  normalizeClaudeToolInputSchema,
  coerceSchemaNumericFields,
} from "../../../open-sse/translator/helpers/schemaCoercion.ts";
import {
  RawClaudeToolCollector,
  ClientOpenAIToolCollector,
  crossCheckToolCalls,
  type RawToolResponseProof,
  type ClientToolResponseProof,
} from "./toolResponseProof";

type Json = Record<string, unknown>;
function fail(): never {
  throw new Error("decision_tool_authority_rejected");
}
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Json;
}
function same(a: unknown, b: unknown): boolean {
  return canonicalToolJSON(a) === canonicalToolJSON(b);
}
function assertWireStructure(wire: Json): void {
  if (!Array.isArray(wire.messages) || wire.messages.length > 256) return fail();
  for (const raw of wire.messages) {
    const message = record(raw);
    if (
      !["user", "assistant"].includes(String(message.role)) ||
      Object.keys(message).some((key) => !["role", "content"].includes(key)) ||
      !Array.isArray(message.content) ||
      message.content.length > 128
    )
      return fail();
    for (const rawBlock of message.content) assertWireBlock(record(rawBlock), String(message.role));
  }
}
function assertWireBlock(block: Json, role: string): void {
  const keys: Record<string, string[]> = {
    text: ["type", "text", "cache_control"],
    thinking: ["type", "thinking", "signature"],
    redacted_thinking: ["type", "data"],
    tool_use: ["type", "id", "name", "input", "cache_control"],
    tool_result: ["type", "tool_use_id", "content", "is_error", "cache_control"],
  };
  const type = String(block.type),
    allowed = keys[type];
  if (!allowed || Object.keys(block).some((key) => !allowed.includes(key))) return fail();
  if (type !== "text" && (type === "tool_result" ? role !== "user" : role !== "assistant"))
    return fail();
  if (type === "text" && typeof block.text !== "string") return fail();
  if (
    block.cache_control !== undefined &&
    !same(block.cache_control, { type: "ephemeral", ttl: "1h" }) &&
    !same(block.cache_control, { type: "ephemeral" })
  )
    return fail();
}
function appendTranscript(rows: Json[], role: string, blocks: Json[]): void {
  if (!blocks.length) return;
  const previous = rows.at(-1);
  if (previous?.role === role) (previous.content as Json[]).push(...blocks);
  else rows.push({ role, content: blocks });
}
function messageText(row: ChatPolicyBody["messages"][number]): Json[] {
  const parts =
    typeof row.content === "string"
      ? [row.content]
      : Array.isArray(row.content)
        ? row.content.map((part) => part.text)
        : [];
  return parts.filter(Boolean).map((text) => ({ type: "text", text }));
}
function wireTranscript(wire: Json): Json[] {
  const rows: Json[] = [];
  for (const message of wire.messages as Json[]) {
    const blocks = (message.content as Json[])
      .filter((block) => block.type !== "text" || block.text !== "")
      .map((block) => {
        const { cache_control: _cache, ...value } = block;
        return value.type === "tool_result"
          ? { ...value, is_error: value.is_error ?? false }
          : value;
      });
    appendTranscript(rows, String(message.role), blocks);
  }
  return rows;
}
function internalCacheId(sourceAttemptId: string): string {
  // Locator only. The DB's origin/account-bound digest is the authority, not this key.
  return "\0bounded-tool-source:" + sourceAttemptId;
}
function replayBlocks(prepared: PreparedToolContinuation) {
  const blocks = new Map<string, ClaudeSignedThinkingBlock[]>();
  for (const origin of prepared.replayOrigins) {
    if (!origin.requiresThinkingReplay) continue;
    const value = restoreClaudeThinkingBlocks({
      toolUseIds: [internalCacheId(origin.sourceAttemptId)],
      provider: prepared.binding.provider,
      model: prepared.binding.model,
    });
    if (!value) throw new Error("decision_tool_replay_unavailable");
    blocks.set(origin.sourceAttemptId, value);
  }
  return blocks;
}
function proofRequest(
  plan: AutomaticPlan,
  keyId: string,
  request: InspectedToolRequest
): ToolContinuationRequest {
  return {
    keyId,
    comboId: plan.comboId,
    history: request.history.map(({ assistantIndex: _index, ...proof }) => proof),
    completedCallIds: request.completedCallIds,
  };
}
export function applicationToolRequest(raw: unknown): InspectedToolRequest | null {
  const request = inspectToolRequest(raw);
  if (!request) return null;
  // The first continuation slice is the existing Hermes text SSE protocol.
  if ((request.body.tools?.length || request.current) && request.body.stream !== true) return null;
  return request;
}
export class ApplicationTools {
  readonly request: InspectedToolRequest;
  readonly continuation?: PreparedToolContinuation;
  private proof?: ToolContinuationRequest;
  private blocks = new Map<string, ClaudeSignedThinkingBlock[]>();
  private replay: Record<string, string> = {};
  private gemini?: ApplicationGeminiTools;
  constructor(
    private plan: AutomaticPlan,
    private keyId: string,
    request: InspectedToolRequest
  ) {
    this.request = request;
    if (request.current) {
      this.proof = proofRequest(plan, keyId, request);
      this.continuation = prepareToolContinuation(this.proof);
      if (this.continuation.replayOrigins.length !== request.history.length) fail();
      if (this.continuation.binding.provider === "agy") {
        this.gemini = new ApplicationGeminiTools(
          plan,
          keyId,
          request,
          this.continuation,
          this.proof
        );
        return;
      }
      this.blocks = replayBlocks(this.continuation);
      for (const [id, blocks] of this.blocks) this.replay[id] = canonicalToolJSON(blocks);
    }
  }
  claim(identity: AttemptIdentity): void {
    if (this.gemini) return this.gemini.claim(identity);
    if (!this.proof) return fail();
    claimToolContinuation(this.proof, identity, this.replay);
  }
  assertFresh(identity: AttemptIdentity): void {
    if (this.gemini) return this.gemini.assertFresh(identity);
    if (this.proof) assertToolContinuationClaim(this.proof, identity, this.replay);
  }
  private thinkingAt(index: number): ClaudeSignedThinkingBlock[] {
    const groupIndex = this.request.history.findIndex((group) => group.assistantIndex === index);
    if (groupIndex < 0) return [];
    const origin = this.continuation?.replayOrigins[groupIndex];
    if (!origin) return fail();
    const blocks = this.blocks.get(origin.sourceAttemptId);
    if (origin.requiresThinkingReplay && !blocks) return fail();
    return structuredClone(blocks ?? []);
  }
  restoreThinking(message: unknown, originalIndex: number): ClaudeSignedThinkingBlock[] {
    const expected = this.request.body.messages[originalIndex];
    if (
      !expected ||
      expected.role !== "assistant" ||
      !expected.tool_calls?.length ||
      !same(message, expected)
    )
      throw new Error("decision_tool_restore_message_mismatch");
    return this.thinkingAt(originalIndex);
  }
  attach(identity: AttemptIdentity, authority: string): ApplicationToolHooks {
    if (identity.provider === "agy") {
      this.gemini ??= new ApplicationGeminiTools(this.plan, this.keyId, this.request);
      return this.gemini.attach(identity, authority);
    }
    if (this.gemini) return fail();
    if (identity.provider !== "claude") return fail();
    const raw = new RawClaudeToolCollector({
      allowToolUse: this.request.body.tool_choice !== "none",
    });
    const client = new ClientOpenAIToolCollector(identity.model);
    const aliases = this.toolAliases();
    let rawVerified = false,
      published = false,
      terminalValidated = false;
    let clientProof: ClientToolResponseProof | null = null;
    let rawProof: RawToolResponseProof | null = null;
    return {
      beforeFetch: (wire) => {
        this.assertWire(wire, aliases);
        return this.request.body.messages;
      },
      restoreThinking: (message, index) => this.restoreThinking(message, index),
      preserveWireThinking: (message, messages, index) =>
        this.preserveWireThinking(message, messages, index, aliases),
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
        if (terminalValidated || !rawVerified) return fail();
        clientProof = client.finish();
        if (clientProof && status >= 400) return fail();
        if (Boolean(rawProof) !== Boolean(clientProof)) return fail();
        if (rawProof && clientProof)
          crossCheckToolCalls(rawProof, clientProof, (name) => aliases.get(name) ?? fail());
        terminalValidated = true;
      },
      commitClientComplete: () => {
        if (published || !rawVerified || !terminalValidated) return fail();
        this.commitResponse(identity, authority, rawProof, clientProof, aliases);
        published = true;
      },
    };
  }
  private commitResponse(
    identity: AttemptIdentity,
    authority: string,
    rawProof: RawToolResponseProof | null,
    proof: ClientToolResponseProof | null,
    aliases: Map<string, string>
  ): void {
    if (!proof) {
      if (rawProof) return fail();
      if (this.continuation) commitToolContinuationEnd(this.continuation.turnId, identity);
      else finishDecisionApplicationWithMetadata(identity, () => {});
      return;
    }
    if (!rawProof || !rawProof.thinkingBlocks.length) return fail();
    if (this.request.body.parallel_tool_calls === false && proof.calls.length > 1) return fail();
    crossCheckToolCalls(rawProof, proof, (name) => aliases.get(name) ?? fail());
    if (
      !storeClaudeThinkingBlocks({
        toolUseIds: [internalCacheId(identity.id)],
        blocks: rawProof.thinkingBlocks,
        provider: identity.provider,
        model: identity.model,
      })
    )
      return fail();
    commitToolContinuation(identity, {
      clientPrefixJSON: canonicalClientPrefix([
        ...this.request.body.messages,
        proof.assistant as ChatPolicyBody["messages"][number],
      ]),
      toolContractJSON: this.request.toolContractJSON,
      calls: proof.calls,
      thinkingBlocksJSON: canonicalToolJSON(rawProof.thinkingBlocks),
      expectedPolicy: this.plan.sourcePolicy,
      expectedAuthority: authority,
      ...(this.continuation ? { previousTurnId: this.continuation.turnId } : {}),
    });
  }
  private toolAliases(): Map<string, string> {
    return new Map(
      (this.request.body.tools ?? []).map((tool) => [tool.function.name, tool.function.name])
    );
  }
  private assertWire(wire: Json, aliases: Map<string, string>): void {
    assertWireStructure(wire);
    this.assertWireTools(wire, aliases);
    if (!same(wireTranscript(wire), this.expectedTranscript())) return fail();
    const expectedSystem = this.request.body.messages
      .filter((row) => ["system", "developer"].includes(row.role))
      .flatMap(messageText)
      .map((block) => block.text)
      .join("\n");
    const system =
      typeof wire.system === "string"
        ? wire.system
        : Array.isArray(wire.system)
          ? wire.system.map((block) => record(block).text).join("\n")
          : "";
    if (system !== expectedSystem) return fail();
  }
  private expectedTranscript(): Json[] {
    const rows: Json[] = [];
    const messages = this.request.body.messages;
    for (let index = 0; index < messages.length; index++) {
      const row = messages[index];
      if (["system", "developer"].includes(row.role)) continue;
      if (row.role === "tool") return fail();
      appendTranscript(rows, row.role, this.expectedBlocks(row, index));
      if (!row.tool_calls?.length) continue;
      const results = this.resultsAt(index);
      appendTranscript(rows, "user", results.blocks);
      index = results.next - 1;
    }
    return rows;
  }
  private expectedBlocks(row: ChatPolicyBody["messages"][number], index: number): Json[] {
    if (!row.tool_calls?.length) return messageText(row);
    return [
      ...this.thinkingAt(index),
      ...messageText(row),
      ...row.tool_calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      })),
    ];
  }
  private resultsAt(index: number): { next: number; blocks: Json[] } {
    const messages = this.request.body.messages,
      results = new Map<string, unknown>();
    let next = index + 1;
    while (messages[next]?.role === "tool") {
      const row = messages[next++];
      results.set(row.tool_call_id!, row.content);
    }
    const blocks = messages[index].tool_calls!.map((call) => {
      if (!results.has(call.id)) return fail();
      return {
        type: "tool_result",
        tool_use_id: call.id,
        content: results.get(call.id),
        is_error: false,
      };
    });
    if (blocks.length !== results.size) return fail();
    return { next, blocks };
  }
  private assertWireTools(wire: Json, aliases: Map<string, string>): void {
    const expected = this.request.body.tools ?? [];
    if (!Array.isArray(wire.tools) || wire.tools.length !== expected.length) return fail();
    wire.tools.forEach((raw, index) => {
      const actual = record(raw),
        declared = expected[index].function;
      if (actual.type !== "custom") return fail();
      if (
        aliases.get(String(actual.name)) !== declared.name ||
        actual.description !== (declared.description || "")
      )
        return fail();
      const schema =
        declared.parameters.type === "object" && !declared.parameters.properties
          ? { ...declared.parameters, properties: {} }
          : declared.parameters;
      if (
        !same(
          actual.input_schema,
          coerceSchemaNumericFields(normalizeClaudeToolInputSchema(schema))
        ) ||
        actual.strict !== (declared.strict === true ? true : undefined)
      )
        return fail();
      if (
        Object.keys(actual).some(
          (key) =>
            !["name", "description", "input_schema", "strict", "cache_control", "type"].includes(
              key
            )
        )
      )
        return fail();
    });
    const choice = this.request.body.tool_choice;
    const expectedChoice = choice === undefined ? undefined : { type: choice };
    const parallel = this.request.body.parallel_tool_calls === false && choice !== "none";
    const control = parallel
      ? { type: choice ?? "auto", disable_parallel_tool_use: true }
      : expectedChoice;
    if (!same(wire.tool_choice ?? null, control ?? null)) return fail();
  }
  private groupMatches(
    message: Json,
    row: ChatPolicyBody["messages"][number],
    aliases: Map<string, string>
  ): boolean {
    const blocks = message.content as Json[];
    const calls = blocks.filter((block) => block.type === "tool_use");
    if (calls.length !== row.tool_calls?.length) return false;
    return calls.every((block, index) => {
      const expected = row.tool_calls![index];
      return (
        block.id === expected.id &&
        aliases.get(String(block.name)) === expected.function.name &&
        same(block.input, JSON.parse(expected.function.arguments))
      );
    });
  }
  private preserveWireThinking(
    message: unknown,
    messages: readonly unknown[],
    index: number,
    aliases: Map<string, string>
  ): boolean {
    if (
      messages[index] !== message ||
      index < 0 ||
      index >= messages.length ||
      messages.length > 256
    )
      return fail();
    const actual = record(message);
    if (
      actual.role !== "assistant" ||
      !Array.isArray(actual.content) ||
      !actual.content.some((block) => record(block).type === "tool_use")
    )
      return false;
    const ordinal = messages
      .slice(0, index)
      .map(record)
      .filter(
        (row) =>
          row.role === "assistant" &&
          Array.isArray(row.content) &&
          row.content.some((block) => record(block).type === "tool_use")
      ).length;
    const expected = this.request.body.messages
      .map((row, originalIndex) => ({ row, originalIndex }))
      .filter(({ row }) => row.tool_calls?.length)[ordinal];
    if (!expected || !this.groupMatches(actual, expected.row, aliases))
      throw new Error("decision_tool_wire_occurrence_mismatch");
    const blocks = this.thinkingAt(expected.originalIndex);
    const actualBlocks = (actual.content as Json[]).filter((block) =>
      ["thinking", "redacted_thinking"].includes(String(block.type))
    );
    if (!same(actualBlocks, blocks)) throw new Error("decision_tool_wire_replay_mismatch");
    return true;
  }
}
