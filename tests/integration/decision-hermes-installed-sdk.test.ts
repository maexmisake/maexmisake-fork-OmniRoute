import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { createCombo, updateCombo } from "../../src/lib/db/combos.ts";
import { readDecisionAttempts } from "../../src/lib/db/decisionAttempts.ts";
import { readToolContinuations } from "../../src/lib/db/decisionContinuations.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { clearClaudeThinkingStore } from "../../open-sse/services/claudeThinkingStore.ts";
import {
  BOUNDED_AGY_MODEL,
  BOUNDED_AGY_OPUS_MODEL,
  BOUNDED_AGY_STREAM_URL,
} from "../../open-sse/executors/antigravity/bounded.ts";
import { NATIVE_DECISION_CODEX_ENDPOINT } from "../../open-sse/executors/codex/nativeDecision.ts";
import { __clearCodexToolReplayForTests } from "../../src/lib/decisionPolicy/codexToolReplay.ts";
import { currentApplicationAttempt } from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import {
  createGeminiCorrelationNamespace,
  resolveGeminiClientCallId,
} from "../../src/lib/decisionPolicy/geminiToolIdentity.ts";

const PYTHON = process.env.OMNIROUTE_HERMES_SDK_PYTHON;
const AVAILABLE = !!PYTHON;
const MODEL = "synthetic-hermes-pinned";
const SELECTOR = "https://opencode.ai/inference/systemone/v1/systemone";
const EXECUTOR = "https://api.anthropic.com/v1/messages?beta=true";
const CONTROL_SCHEMA = {
  type: "object",
  properties: { item: { type: "string" } },
  required: ["item"],
  additionalProperties: false,
};
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
let POST: (request: Request) => Promise<Response>;
let key: Awaited<ReturnType<typeof createApiKey>>;
let comboId: string, selectorId: string, sonnetId: string, opusId: string, agyId: string;
let nativeTarget: "codex" | "agy" | null = null;
let nativeToolMode = false;
let nativeExecutionTools = false;
let nativeMalformedArguments = false;
let nativeLargeUsage = false;
let nativeToolTurns = 1;
let nativeParallelCalls = false;
let nativeParallelMismatch = false;
let nativeModel = "gpt-6-sol";
let codexId: string;
let delegated = false;
let widePool = false;
let agy = false,
  agyParallel = false,
  agyRefuse = false;
let agyIdMode = "explicit",
  agyOriginId = "";
let configuredReasoningText = false;
let configuredSchema: Record<string, unknown> | undefined;
let checkConfiguredStrict = false,
  configuredStrict: boolean | undefined;
const controlTraces: Array<Record<string, unknown>> = [];
let effort = "high",
  decisions = 0,
  executions = 0;
let unexpected = 0;
let denial = 0,
  missingCost = false,
  zeroCost = false,
  missingReplay = false;
const wires: Array<Record<string, unknown>> = [];
function source(caseName: string) {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesPinned/build_request.py", import.meta.url)
      ),
    ],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-sdk-builder-home` },
      input: JSON.stringify({ case: caseName }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 200000,
    }
  );
  assert.equal(result.status, 0, "Pinned original source builder must complete");
  const capture = JSON.parse(result.stdout);
  assert.equal(capture.sdkWireCaptured, false);
  assert.equal(capture.fullHermesExecuted, false);
  return capture;
}
function candidate(family: string, value: string) {
  return {
    id: `${family}-${value}`,
    provider: "claude",
    model: `claude-${family}-5-5`,
    endpointKind: "direct",
    evidence: "Synthetic installed-SDK contract fixture, not live capability/quality evidence",
    capabilities: {
      text: true,
      images: false,
      tools: true,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: { mode: "set", value, supported: [value], evidence: "Synthetic explicit pair" },
  };
}
function config(wide = false) {
  const levels = wide ? ["medium", "high", "xhigh", "max"] : ["medium", "high"];
  const ids = levels.flatMap((value) => [`opus-${value}`, `sonnet-${value}`]);
  return {
    decisionPolicy: {
      enabled: true,
      applicationMode: nativeToolMode ? "provider-native-output-v1" : "bounded-v1",
      ...(nativeToolMode
        ? { nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64 } }
        : {}),
      selection: {
        mode: "native",
        provider: "opencode-zen",
        model: "jev-1.13-free",
        connectionId: selectorId,
        timeoutMs: 1000,
      },
      connections: Object.fromEntries(
        ids.map((id) => [id, id.startsWith("opus") ? opusId : sonnetId])
      ),
      policy: {
        version: 1,
        candidates: levels.flatMap((value) => [
          candidate("opus", value),
          candidate("sonnet", value),
        ]),
        taskOrder: { explanation: ids, reasoning: ids, tools: ids, continuation: ids },
        unknownQuota: "allow",
        decisionFailure: "stop",
        maxDecisionAttempts: 1,
        maxExecutionAttempts: 1,
        timeoutMs: 5000,
      },
    },
  };
}
// Source fragments + locked SDK + real handler only; not full Hermes or live-provider proof.
async function configureNativeText(
  provider: "codex" | "agy",
  options: { tools?: boolean; model?: string; effort?: string } = {}
) {
  nativeTarget = provider;
  nativeExecutionTools = options.tools === true;
  nativeModel = options.model ?? (provider === "codex" ? "gpt-6-sol" : BOUNDED_AGY_OPUS_MODEL);
  effort = options.effort ?? "high";
  const target = {
    ...candidate("sonnet", "high"),
    id: `${provider}-native-${effort}`,
    provider,
    model: nativeModel,
    capabilities: { ...candidate("sonnet", effort).capabilities, tools: nativeExecutionTools },
    effort: {
      mode: provider === "agy" || nativeModel === "gpt-6-luna" ? "fixed" : "set",
      value: effort,
      supported: [effort],
      evidence: "Synthetic original-pool declared effort; not live availability",
    },
  };
  const base = config();
  await updateCombo(comboId, {
    config: {
      decisionPolicy: {
        ...base.decisionPolicy,
        applicationMode: "provider-native-output-v1",
        nativeOutput: { acknowledgeNoTokenCeiling: true, contextOutputTokens: 64 },
        connections: {
          [target.id]: provider === "codex" ? codexId : agyId,
          [`sonnet-${effort}`]: sonnetId,
        },
        policy: {
          ...base.decisionPolicy.policy,
          candidates: [target, candidate("sonnet", effort)],
          taskOrder: {
            explanation: [target.id, `sonnet-${effort}`],
            tools: [target.id, `sonnet-${effort}`],
            continuation: [target.id, `sonnet-${effort}`],
          },
        },
      },
    },
  });
}
function nativeCodexToolResponse(model: string) {
  const reasoning = {
    type: "reasoning",
    id: `rs_sdk_native_${executions}`,
    summary: [],
    encrypted_content: `synthetic-sdk-native-encrypted-reasoning-${executions}`,
  };
  const call = {
    type: "function_call",
    id: `fc_sdk_native_${executions}`,
    call_id: executions === 1 ? "fixture-call-one" : "fixture-call-two",
    name: "synthetic_tool",
    arguments: '{"item":"synthetic lamp"}',
    status: "completed",
  };
  const calls = [
    call,
    ...(nativeParallelCalls
      ? [
          {
            ...call,
            id: "fc_sdk_native_parallel",
            call_id: "fixture-call-two",
            arguments: '{"item":"synthetic switch"}',
          },
        ]
      : []),
  ];
  const base = {
    id: "synthetic-sdk-native-tool-response",
    object: "response",
    model,
    status: "in_progress",
    output: [],
  };
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response: base },
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
  ];
  for (const [index, item] of calls.entries())
    events.push(
      {
        type: "response.output_item.added",
        output_index: index + 1,
        item: { ...item, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: index + 1,
        item_id: item.id,
        delta: item.arguments,
      }
    );
  // Valid parallel completions arrive out of order. Identity remains tied to
  // original output_index/item_id, while terminal.output is canonical order.
  for (const [index, item] of [...calls.entries()].reverse())
    events.push(
      {
        type: "response.function_call_arguments.done",
        output_index: index + 1,
        item_id: item.id,
        arguments: item.arguments,
      },
      {
        type: "response.output_item.done",
        output_index: nativeParallelMismatch && index === 1 ? 1 : index + 1,
        item: item,
      }
    );
  events.push({
    type: "response.completed",
    response: {
      ...base,
      status: "completed",
      end_turn: false,
      output: [
        reasoning,
        ...calls.map((item, index) =>
          nativeMalformedArguments && index === 0
            ? { ...item, arguments: '{"item":"different"}' }
            : item
        ),
      ],
      usage: {
        input_tokens: 8,
        output_tokens: nativeLargeUsage ? 96 : 4,
        total_tokens: nativeLargeUsage ? 104 : 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: nativeLargeUsage ? 32 : 2 },
      },
    },
  });
  return new Response(
    events.map((row) => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}
function nativeCodexResponse(model: string) {
  const id = "synthetic-sdk-native-response";
  const item = {
    id: "synthetic-sdk-native-message",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Synthetic SDK OK", annotations: [] }],
  };
  const base = { id, object: "response", model, status: "in_progress", output: [] };
  const events = [
    { type: "response.created", response: base },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: "Synthetic SDK OK",
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      text: "Synthetic SDK OK",
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: item.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...base,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 8,
          output_tokens: nativeLargeUsage ? 96 : 4,
          total_tokens: nativeLargeUsage ? 104 : 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: nativeLargeUsage ? 32 : 2 },
          cost: 123,
        },
      },
    },
  ];
  return new Response(
    events.map((row) => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    }
  );
}
async function configureAgy(parallel: boolean, sole = false) {
  agy = true;
  agyParallel = parallel;
  const value = config();
  value.decisionPolicy.connections = sole
    ? { "agy-high": agyId }
    : { "agy-high": agyId, "sonnet-high": sonnetId };
  value.decisionPolicy.policy.candidates = [
    { ...candidate("sonnet", "high"), id: "agy-high", provider: "agy", model: BOUNDED_AGY_MODEL },
    ...(sole ? [] : [candidate("sonnet", "high")]),
  ];
  const ids = sole ? ["agy-high"] : ["agy-high", "sonnet-high"];
  value.decisionPolicy.policy.taskOrder = {
    explanation: ids,
    reasoning: ids,
    tools: ids,
    continuation: ids,
  };
  await updateCombo(comboId, { config: value });
}
function agyParts(): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [
    {
      functionCall: {
        id: "fixture-call-one",
        name: "synthetic_tool",
        args: { item: "synthetic lamp" },
      },
      thoughtSignature: "synthetic-sdk-agy-opaque-signature",
    },
    ...(agyParallel
      ? [
          {
            functionCall: {
              id: "fixture-call-two",
              name: "synthetic_tool",
              args: { item: "synthetic switch" },
            },
          },
        ]
      : []),
  ];
  for (const [ordinal, part] of parts.entries()) {
    if (agyIdMode === "absent" || (agyIdMode === "mixed" && ordinal === 1))
      delete (part.functionCall as Record<string, unknown>).id;
  }
  return parts;
}
function agyResponse() {
  const parts = agyRefuse
    ? [{ text: "Synthetic safety refusal" }]
    : executions === 1 && !configuredReasoningText
      ? agyParts()
      : [{ text: "Synthetic SDK OK" }];
  return new Response(
    `data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts }, finishReason: agyRefuse ? "SAFETY" : "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 6 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  );
}
function event(type: string, data: Record<string, unknown> = {}) {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}
function upstream(model: string, stream: boolean, tools: boolean) {
  const usage = {
    input_tokens: 8,
    output_tokens: 6,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...(missingCost ? {} : { cost: zeroCost ? 0 : 0.003 }),
  };
  if (!stream)
    return Response.json({
      id: "synthetic-sdk-json",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Synthetic SDK OK" }],
      stop_reason: "end_turn",
      usage,
    });
  const chunks = [
    event("message_start", {
      message: {
        id: "synthetic-sdk-stream",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { ...usage, output_tokens: 0 },
      },
    }),
  ];
  if (tools) {
    chunks.push(
      event("content_block_start", {
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "Synthetic signed reasoning" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "signature_delta", signature: "synthetic-sdk-account-signature" },
      }),
      event("content_block_stop", { index: 0 })
    );
    for (const [offset, id] of ["fixture-call-one", "fixture-call-two"].entries())
      chunks.push(
        event("content_block_start", {
          index: offset + 1,
          content_block: { type: "tool_use", id, name: "synthetic_tool", input: {} },
        }),
        event("content_block_delta", {
          index: offset + 1,
          delta: { type: "input_json_delta", partial_json: '{"item":"synthetic lamp"}' },
        }),
        event("content_block_stop", { index: offset + 1 })
      );
  } else
    chunks.push(
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "Synthetic SDK OK" },
      }),
      event("content_block_stop", { index: 0 })
    );
  chunks.push(
    event("message_delta", {
      delta: { stop_reason: tools ? "tool_use" : "end_turn", stop_sequence: null },
      usage,
    }),
    event("message_stop")
  );
  return new Response(
    new ReadableStream(
      {
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      },
      { highWaterMark: 0 }
    ),
    { headers: { "content-type": "text/event-stream" } }
  );
}
before(async () => {
  // Direct closed Responses contracts reuse only the application/provider fixtures below.
  // Actual SDK tests retain their explicit AVAILABLE skip; this never configures or runs an SDK.
  if (AVAILABLE)
    assert.equal(existsSync(PYTHON!), true, "The explicitly configured SDK executable must exist");
  process.env.REQUIRE_API_KEY = "true";
  process.env.APP_LOG_TO_FILE = "false";
  await import("../../open-sse/utils/proxyFetch.ts");
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      init.method !== "POST" ||
      ![
        SELECTOR,
        EXECUTOR,
        ...(agy || nativeTarget === "agy" ? [BOUNDED_AGY_STREAM_URL] : []),
        ...(nativeTarget === "codex" ? [NATIVE_DECISION_CODEX_ENDPOINT] : []),
      ].includes(url)
    ) {
      unexpected++;
      throw new Error("Closed SDK provider fixture rejected route");
    }
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    if (url === SELECTOR) {
      decisions++;
      assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-selector");
      const ids = Object.keys(body.questions.route.criteria);
      assert.deepEqual(
        ids.sort(),
        (nativeTarget
          ? [`${nativeTarget}-native-${effort}`, `sonnet-${effort}`]
          : agy
            ? ["agy-high", "sonnet-high"]
            : delegated
              ? (widePool ? ["medium", "high", "xhigh", "max"] : ["medium", "high"]).flatMap(
                  (value) => [`opus-${value}`, `sonnet-${value}`]
                )
              : [`opus-${effort}`, `sonnet-${effort}`]
        ).sort()
      );
      const text = JSON.stringify(body);
      assert.ok(!text.includes("synthetic lamp"));
      assert.ok(!text.includes('"item"'));
      const selected = nativeTarget
        ? `${nativeTarget}-native-${effort}`
        : agy
          ? "agy-high"
          : `sonnet-${effort}`;
      return Response.json({
        model: "jev-1.13-free",
        answers: {
          route: {
            type: "choice",
            choice: selected,
            probabilities: Object.fromEntries(
              ids.map((id) => [id, id === selected ? 0.8 : (1 - 0.8) / (ids.length - 1)])
            ),
            confidence: (0.8 - 1 / ids.length) / (1 - 1 / ids.length),
          },
        },
        usage: { input_tokens: 7, output_tokens: 1, cost: 0 },
      });
    }
    executions++;
    wires.push(body);
    if (nativeTarget) {
      const attempt = currentApplicationAttempt();
      assert.equal(attempt?.connectionId, nativeTarget === "codex" ? codexId : agyId);
      assert.equal(attempt?.effort, effort);
      for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
        assert.equal(body[field], undefined);
      if (denial)
        return Response.json(
          {
            error: { message: "Synthetic native SDK access denied" },
            usage: { cost: 123, prompt_tokens: 8, completion_tokens: 4 },
          },
          { status: denial, headers: denial === 429 ? { "retry-after": "17" } : {} }
        );
      if (nativeTarget === "codex") {
        assert.equal(url, NATIVE_DECISION_CODEX_ENDPOINT);
        assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-codex-oauth");
        assert.equal(headers.get("chatgpt-account-id"), "synthetic-sdk-workspace");
        assert.equal(body.model, nativeModel);
        assert.equal(body.reasoning.effort, effort);
        return nativeExecutionTools && executions <= nativeToolTurns
          ? nativeCodexToolResponse(body.model)
          : nativeCodexResponse(body.model);
      }
      assert.equal(url, BOUNDED_AGY_STREAM_URL);
      assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-agy-oauth");
      assert.equal(body.model, BOUNDED_AGY_OPUS_MODEL);
      assert.equal(body.project, "synthetic-sdk-agy-project");
      assert.deepEqual(body.request.generationConfig, { topK: 40, topP: 1 });
      return new Response(
        `data: ${JSON.stringify({
          response: {
            candidates: [
              {
                index: 0,
                content: {
                  role: "model",
                  parts:
                    nativeExecutionTools && executions === 1
                      ? [
                          {
                            functionCall: {
                              id: "fixture-call-one",
                              name: "synthetic_tool",
                              args: { item: "synthetic lamp" },
                            },
                          },
                        ]
                      : [{ text: "Synthetic SDK OK" }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: nativeLargeUsage ? 96 : 3,
              thoughtsTokenCount: nativeLargeUsage ? 32 : 1,
              totalTokenCount: nativeLargeUsage ? 130 : 6,
            },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      );
    }
    if (url === BOUNDED_AGY_STREAM_URL) {
      if (
        !(body.request.contents as Array<{ parts: Array<Record<string, unknown>> }>).some((row) =>
          row.parts.some((part) => part.functionResponse)
        )
      )
        agyOriginId = currentApplicationAttempt()?.id ?? "";
      assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-agy-oauth");
      assert.equal(headers.get("user-agent"), "OmniRoute-Antigravity/1.0");
      assert.equal(body.model, BOUNDED_AGY_MODEL);
      assert.equal(body.project, "synthetic-sdk-agy-project");
      assert.equal(body.request.generationConfig.maxOutputTokens, 64);
      assert.equal(body.request.generationConfig.thinkingConfig.thinkingLevel, "high");
      if (configuredReasoningText) {
        assert.equal(body.request.tools, undefined);
      } else {
        const declaration = body.request.tools[0].functionDeclarations[0];
        assert.equal(declaration.name, "synthetic_tool");
        const expectedSchema = configuredSchema ?? { type: "object", properties: {} };
        assert.deepEqual(declaration.parametersJsonSchema, expectedSchema);
        assert.equal(
          Object.hasOwn(declaration.parametersJsonSchema, "additionalProperties"),
          Object.hasOwn(expectedSchema, "additionalProperties")
        );
      }
      return agyResponse();
    }
    assert.equal(headers.get("authorization"), "Bearer synthetic-sdk-sonnet-oauth");
    assert.equal(body.model, "claude-sonnet-5-5");
    assert.equal(body.output_config.effort, effort);
    assert.equal(body.max_tokens, 64);
    if (checkConfiguredStrict) {
      for (const tool of body.tools)
        assert.equal(tool.strict, configuredStrict === true ? true : undefined);
    }
    if (denial)
      return Response.json(
        { error: { message: "Synthetic terminal denial" } },
        { status: denial, headers: denial === 429 ? { "retry-after": "17" } : {} }
      );
    return upstream(body.model, body.stream, Array.isArray(body.tools) && executions === 1);
  };
  const closed = globalThis.fetch;
  ({ POST } = await import("../../src/app/api/v1/chat/completions/route.ts"));
  assert.equal(globalThis.fetch, closed);
  await updateSettings({
    memoryEnabled: false,
    semanticCacheEnabled: false,
    compressionEnabled: false,
    autoWebSearchEnabled: false,
    webSearchEnabled: false,
    streamDefaultMode: "json",
  });
  selectorId = String(
    (
      await createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "synthetic-sdk-free-selector",
        apiKey: "synthetic-sdk-selector",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { systemOneTier: "free" },
      })
    ).id
  );
  agyId = String(
    (
      await createProviderConnection({
        provider: "agy",
        authType: "oauth",
        name: "synthetic-sdk-agy",
        accessToken: "synthetic-sdk-agy-oauth",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: { projectId: "synthetic-sdk-agy-project" },
      })
    ).id
  );
  codexId = String(
    (
      await createProviderConnection({
        provider: "codex",
        authType: "oauth",
        name: "synthetic-sdk-codex",
        accessToken: "synthetic-sdk-codex-oauth",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: { workspaceId: "synthetic-sdk-workspace" },
      })
    ).id
  );
  comboId = String(
    (
      await createCombo({
        name: MODEL,
        models: ["claude/claude-opus-5-5"],
        strategy: "priority",
        config: {},
      })
    ).id
  );
});
beforeEach(async () => {
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  nativeToolMode = false;
  key = await createApiKey("synthetic-sdk-client-" + randomUUID(), "synthetic");
  for (const family of ["opus", "sonnet"]) {
    const row = await createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name: `synthetic-sdk-${family}-${randomUUID()}`,
      accessToken: `synthetic-sdk-${family}-oauth`,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    if (family === "opus") opusId = String(row.id);
    else sonnetId = String(row.id);
  }
  // Each synthetic account owns its failure state; an earlier deliberate 401
  // must not contaminate a later independent native-provider contract case.
  for (const provider of ["codex", "agy"] as const) {
    const connection = await createProviderConnection({
      provider,
      authType: "oauth",
      name: `synthetic-sdk-${provider}-${randomUUID()}`,
      accessToken: `synthetic-sdk-${provider}-oauth`,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData:
        provider === "codex"
          ? { workspaceId: "synthetic-sdk-workspace" }
          : { projectId: "synthetic-sdk-agy-project" },
    });
    if (provider === "codex") codexId = String(connection.id);
    else agyId = String(connection.id);
  }
  await updateCombo(comboId, { config: config() });
  nativeTarget = null;
  nativeExecutionTools = false;
  nativeMalformedArguments = false;
  nativeLargeUsage = false;
  nativeToolTurns = 1;
  nativeParallelCalls = false;
  nativeParallelMismatch = false;
  nativeModel = "gpt-6-sol";
  agy = false;
  agyParallel = false;
  agyRefuse = false;
  agyIdMode = "explicit";
  agyOriginId = "";
  configuredReasoningText = false;
  configuredSchema = undefined;
  checkConfiguredStrict = false;
  configuredStrict = undefined;
  effort = "high";
  delegated = false;
  widePool = false;
  decisions = 0;
  executions = 0;
  denial = 0;
  missingCost = false;
  zeroCost = false;
  missingReplay = false;
  wires.length = 0;
  clearClaudeThinkingStore();
});
after(async () => {
  if (process.env.DECISION_HERMES_CONTROLS_TRACE_FILE)
    writeFileSync(
      process.env.DECISION_HERMES_CONTROLS_TRACE_FILE,
      JSON.stringify(controlTraces, null, 2) + "\n"
    );
  globalThis.fetch = originalFetch;
  const { __resetRateLimitManagerForTests } =
    await import("../../open-sse/services/rateLimitManager.ts");
  await __resetRateLimitManagerForTests();
  resetDbInstance();
  assert.equal(unexpected, 0);
});
type Message = {
  kind: string;
  id?: number;
  body?: string;
  headers?: Record<string, string>;
  data?: string;
  method?: string;
  url?: string;
  [key: string]: unknown;
};
async function sdk(capture: ReturnType<typeof source>, mode: string) {
  const child = spawn(
    PYTHON!,
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesSDK/sdk_stdio_client.py", import.meta.url)
      ),
    ],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-sdk-home` },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const readers = new Map<number, ReadableStreamDefaultReader<Uint8Array>>();
  const requests: Record<string, unknown>[] = [];
  const observations: Record<string, unknown>[] = [];
  const nativeClientText = new Map<number, string>();
  let result: Message | undefined,
    failure: unknown,
    stderrBytes = 0;
  const send = (row: unknown) => child.stdin.write(JSON.stringify(row) + "\n");
  let stdoutBuffer = Buffer.alloc(0);
  let pending = Promise.resolve();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) child.kill();
  });
  const timer = setTimeout(() => child.kill(), 30000);
  const handleLine = (line: string) => {
    pending = pending
      .then(async () => {
        assert.ok(line.length <= 1500000);
        const row = JSON.parse(line) as Message;
        if (row.kind === "result") {
          result = row;
          return;
        }
        const id = Number(row.id);
        assert.ok(id >= 1 && id <= 2);
        if (row.kind === "request") {
          assert.equal(row.method, "POST");
          assert.equal(row.url, "https://hermes.fixture.invalid/v1/chat/completions");
          assert.ok(Object.keys(row.headers ?? {}).length <= 32);
          assert.equal(row.headers?.authorization, `Bearer ${key.key}`);
          assert.match(row.headers?.["user-agent"] ?? "", /^OpenAI\/Python 2\.54\.0/);
          const bytes = Buffer.from(row.body!, "base64");
          assert.ok(bytes.length <= 262144);
          const body = JSON.parse(bytes.toString());
          requests.push(body);
          assert.equal(body.model, MODEL);
          assert.ok(!Object.hasOwn(body, "timeout"));
          if (missingReplay && id === 2) {
            if (nativeTarget === "codex") __clearCodexToolReplayForTests();
            else clearClaudeThinkingStore();
          }
          const response = await POST(
            new Request("https://hermes.fixture.invalid/api/v1/chat/completions", {
              method: "POST",
              headers: row.headers,
              body: bytes,
            })
          );
          observations.push({
            status: response.status,
            outputPolicy: response.headers.get("x-omniroute-output-policy"),
            outputLimitEnforced: response.headers.get("x-omniroute-output-limit-enforced"),
            reason: response.headers.get("x-omniroute-decision-reason"),
            keys: Object.keys(body),
            tools: body.tools,
            reasoning: body.reasoning_effort,
          });
          readers.set(id, response.body!.getReader());
          send({
            kind: "headers",
            id,
            status: response.status,
            headers: Object.fromEntries(response.headers),
          });
          return;
        }
        const reader = readers.get(id);
        assert.ok(reader);
        if (row.kind === "close") {
          await reader.cancel().catch(() => {});
          send({ kind: "closed", id });
          return;
        }
        assert.equal(row.kind, "pull");
        try {
          const value = await reader.read();
          if (!value.done && nativeTarget === "codex" && nativeExecutionTools) {
            const text = (nativeClientText.get(id) ?? "") + new TextDecoder().decode(value.value);
            assert.ok(text.length <= 1048576);
            assert.equal(text.includes("synthetic-sdk-native-encrypted-reasoning"), false);
            nativeClientText.set(id, text);
          }
          send(
            value.done
              ? { kind: "end", id }
              : { kind: "chunk", id, data: Buffer.from(value.value).toString("base64") }
          );
        } catch {
          send({ kind: "stream_error", id });
        }
      })
      .catch((error) => {
        failure = error;
        child.kill();
      });
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBuffer.length + chunk.length > 1500000) {
      failure = new Error("SDK fixture stdout exceeded line boundary");
      child.kill();
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    let newline: number;
    while ((newline = stdoutBuffer.indexOf(10)) >= 0) {
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          stdoutBuffer.subarray(0, newline)
        );
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        handleLine(line);
      } catch {
        failure = new Error("SDK fixture stdout encoding rejected");
        child.kill();
        return;
      }
    }
  });
  send({ key: key.key, kwargs: capture.capturedKwargs, driverFlags: capture.driverFlags, mode });
  try {
    const status = await closed;
    await pending;
    if (failure) throw failure;
    assert.equal(stdoutBuffer.length, 0, "SDK result lines must terminate");
    assert.ok(result, "SDK must return a bounded result");
    assert.equal(status, result.ok ? 0 : 2);
    return { result, requests, observations };
  } finally {
    clearTimeout(timer);
    for (const reader of readers.values()) void reader.cancel().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}
const options = {
  skip: AVAILABLE ? false : "Exact external SDK venv is not configured; no SDK execution",
  timeout: 40000,
};
for (const provider of ["claude", "agy"] as const) {
  test(
    `installed SDK native-output original omitted-cap-tools ${provider} High continues without reselection`,
    options,
    async () => {
      nativeToolMode = true;
      if (provider === "agy") await configureAgy(false);
      else await updateCombo(comboId, { config: config() });
      const capture = source("omitted-cap-tools");
      const originalKwargs = structuredClone(capture.capturedKwargs);
      assert.equal(capture.capturedKwargs.max_tokens, undefined);
      assert.equal(capture.capturedKwargs.tools[0].function.name, "synthetic_tool");
      assert.equal(capture.driverFlags.stream, true);
      const { result, requests, observations } = await sdk(capture, "tool-loop");
      assert.equal(result.ok, true, JSON.stringify({ error: result.errorClass, observations }));
      assert.deepEqual(capture.capturedKwargs, originalKwargs);
      assert.equal(result.fullHermesExecuted, false);
      assert.equal(result.actualToolsRun, false);
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.reasoning_effort, "high");
        assert.equal(request.max_tokens, undefined);
        assert.equal(request.max_completion_tokens, undefined);
      }
      assert.equal(decisions, 1);
      assert.equal(executions, 2);
      const receipts = readDecisionAttempts(key.id);
      assert.equal(receipts.length, 3);
      for (const receipt of receipts.filter((row) => row.lane === "execution")) {
        assert.equal(receipt.provider, provider);
        assert.equal(receipt.model, provider === "agy" ? BOUNDED_AGY_MODEL : "claude-sonnet-5-5");
        assert.equal(receipt.effort, "high");
        assert.equal(receipt.connection_id, provider === "agy" ? agyId : sonnetId);
        assert.equal(receipt.application_status, 200);
      }
      assert.equal(readToolContinuations(key.id, comboId).length, 1);
      assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
    }
  );
}
const nativeToolPairs = [
  ["codex", "gpt-6-luna", "max"],
  ...["gpt-5.6-sol", "gpt-6-sol"].flatMap((model) =>
    ["medium", "high", "xhigh", "max"].map((level) => ["codex", model, level])
  ),
  ["agy", BOUNDED_AGY_OPUS_MODEL, "high"],
] as const;
for (const [provider, model, level] of [
  ...nativeToolPairs,
  ["agy", BOUNDED_AGY_MODEL, "high"] as const,
]) {
  test(`direct Responses native-output ${provider} ${model} ${level} tools roundtrip without SDK execution`, async () => {
    assert.ok(provider === "codex" || provider === "agy");
    if (model === BOUNDED_AGY_MODEL) {
      nativeToolMode = true;
      configuredSchema = CONTROL_SCHEMA;
      await configureAgy(false);
    } else await configureNativeText(provider, { tools: true, model, effort: level });
    const { POST: responsesPOST } = await import("../../src/app/api/v1/responses/route.ts");
    const input = [{ role: "user", content: "Explain a synthetic lamp" }];
    const send = (items: unknown[]) =>
      responsesPOST(
        new Request("http://synthetic.invalid/api/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
          body: JSON.stringify({
            model: MODEL,
            input: items,
            tools: [{ type: "function", name: "synthetic_tool", parameters: CONTROL_SCHEMA }],
            tool_choice: "auto",
            parallel_tool_calls: true,
            reasoning: { effort: level },
            stream: true,
            store: false,
          }),
        })
      );
    const initial = await send(input);
    const text = await initial.text();
    assert.equal(initial.status, 200, text);
    const events = text
      .split(/\n\n/)
      .filter((frame) => frame.includes("data: "))
      .map((frame) => JSON.parse(frame.split("data: ")[1]));
    const first = events.at(-1);
    assert.equal(first.type, "response.completed");
    const calls = first.response.output.filter(
      (item: { type: string }) => item.type === "function_call"
    );
    assert.ok(calls.length > 0);
    const continued = await send([
      ...input,
      ...first.response.output,
      ...calls.map((call: { call_id: string }) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: '{"answer":"synthetic result"}',
      })),
    ]);
    const finalText = await continued.text();
    assert.equal(continued.status, 200, finalText);
    assert.match(finalText, /Synthetic SDK OK/);
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
    for (const row of readDecisionAttempts(key.id).filter((row) => row.lane === "execution")) {
      assert.equal(row.provider, provider);
      assert.equal(row.model, model);
      assert.equal(row.effort, level);
      assert.equal(row.connection_id, provider === "codex" ? codexId : agyId);
      assert.equal(row.application_status, 200);
      assert.equal(row.cost_usd, null);
    }
  });
}
for (const [provider, model, level] of nativeToolPairs) {
  test(
    `installed SDK native-output original ${provider} ${model} ${level} tool loop preserves private replay`,
    options,
    async () => {
      assert.ok(provider === "codex" || provider === "agy");
      await configureNativeText(provider, { tools: true, model, effort: level });
      const capture = source(level === "high" ? "omitted-cap-tools" : `omitted-cap-tools-${level}`);
      const originalKwargs = structuredClone(capture.capturedKwargs);
      const { result, requests, observations } = await sdk(capture, "tool-loop");
      assert.equal(result.ok, true, JSON.stringify({ error: result.errorClass, observations }));
      assert.deepEqual(capture.capturedKwargs, originalKwargs);
      assert.equal(result.fullHermesExecuted, false);
      assert.equal(result.actualToolsRun, false);
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.reasoning_effort, level);
        for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
          assert.equal(request[field], undefined);
      }
      assert.equal(decisions, 1);
      assert.equal(executions, 2);
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.length, 3);
      for (const row of rows.filter((item) => item.lane === "execution")) {
        assert.equal(row.provider, provider);
        assert.equal(row.model, model);
        assert.equal(row.effort, level);
        assert.equal(row.connection_id, provider === "codex" ? codexId : agyId);
        assert.equal(row.cost_usd, null);
        assert.equal(row.application_status, 200);
      }
      if (provider === "codex") {
        assert.ok(JSON.stringify(wires[1]).includes("synthetic-sdk-native-encrypted-reasoning"));
        assert.equal(
          JSON.stringify(requests).includes("synthetic-sdk-native-encrypted-reasoning"),
          false
        );
        assert.ok(
          (wires[1].input as Array<Record<string, unknown>>).some(
            (item) => item.type === "function_call_output" && item.call_id === "fixture-call-one"
          )
        );
      } else {
        assert.equal(JSON.stringify(wires[1]).includes("thoughtSignature"), false);
        assert.equal(wires[1].request.generationConfig.maxOutputTokens, undefined);
      }
      assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
    }
  );
}
test(
  "installed SDK native-output Codex preserves explicit parallel false and rejects disobeying multi-call output",
  options,
  async () => {
    await configureNativeText("codex", { tools: true });
    nativeParallelCalls = true;
    const capture = source("omitted-cap-tools-no-parallel");
    assert.equal(capture.capturedKwargs.parallel_tool_calls, false);
    const { result, requests } = await sdk(capture, "tool-loop");
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].parallel_tool_calls, false);
    assert.equal(wires[0].parallel_tool_calls, false);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.deepEqual(readToolContinuations(key.id, comboId), []);
  }
);
for (const mismatch of [false, true]) {
  test(
    `installed SDK native-output Codex parallel out-of-order completions ${mismatch ? "reject mismatched identity" : "preserve both calls and reversed results"}`,
    options,
    async () => {
      await configureNativeText("codex", { tools: true });
      nativeParallelCalls = true;
      nativeParallelMismatch = mismatch;
      const capture = source("omitted-cap-tools-parallel");
      assert.equal(capture.capturedKwargs.parallel_tool_calls, true);
      const { result, requests, observations } = await sdk(capture, "tool-loop");
      assert.equal(
        result.ok,
        !mismatch,
        JSON.stringify({ error: result.errorClass, observations })
      );
      assert.equal(decisions, 1);
      assert.equal(executions, mismatch ? 1 : 2);
      assert.equal(requests.length, mismatch ? 1 : 2);
      if (mismatch) {
        assert.deepEqual(readToolContinuations(key.id, comboId), []);
        return;
      }
      assert.equal((result.summaries as Array<Record<string, unknown>>)[0].callCount, 2);
      assert.equal(wires[0].parallel_tool_calls, true);
      const input = wires[1].input as Array<Record<string, unknown>>;
      assert.deepEqual(
        input.filter((item) => item.type === "function_call_output").map((item) => item.call_id),
        ["fixture-call-two", "fixture-call-one"]
      );
      assert.deepEqual(
        input
          .filter((item) => item.type === "function_call")
          .map((item) => JSON.parse(String(item.arguments)).item),
        ["synthetic lamp", "synthetic switch"]
      );
      assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
    }
  );
}
test(
  "native-output Codex third actual-handler turn retains two SDK-established origin groups without reselection",
  options,
  async () => {
    await configureNativeText("codex", { tools: true });
    nativeToolTurns = 2;
    const { result, requests, observations } = await sdk(source("omitted-cap-tools"), "tool-loop");
    assert.equal(result.ok, true, JSON.stringify({ error: result.errorClass, observations }));
    assert.equal(requests.length, 2);
    const summary = (result.summaries as Array<Record<string, unknown>>)[1];
    const calls = summary.calls as Array<{ id: string; name: string; arguments: string }>;
    assert.equal(calls.length, 1);
    // This third request is an explicit synthetic handler fixture, constructed
    // from actual SDK call values; the bounded SDK driver itself still runs twice.
    const thirdBody = {
      ...requests[1],
      messages: [
        ...(requests[1].messages as unknown[]),
        {
          role: "assistant",
          content: summary.content,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        },
        ...calls.map((call) => ({
          role: "tool",
          tool_call_id: call.id,
          content: "Synthetic second result",
        })),
      ],
    };
    const response = await POST(
      new Request("https://hermes.fixture.invalid/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
        body: JSON.stringify(thirdBody),
      })
    );
    assert.equal(response.status, 200, response.headers.get("x-omniroute-decision-reason") ?? "");
    const text = await response.text();
    assert.match(text, /Synthetic SDK OK/);
    assert.equal(text.includes("synthetic-sdk-native-encrypted-reasoning"), false);
    assert.equal(decisions, 1);
    assert.equal(executions, 3);
    const input = wires[2].input as Array<Record<string, unknown>>;
    assert.deepEqual(
      input.filter((item) => item.type === "function_call_output").map((item) => item.call_id),
      ["fixture-call-one", "fixture-call-two"]
    );
    assert.ok(JSON.stringify(input).includes("synthetic-sdk-native-encrypted-reasoning-1"));
    assert.ok(JSON.stringify(input).includes("synthetic-sdk-native-encrypted-reasoning-2"));
    const pins = readToolContinuations(key.id, comboId);
    assert.equal(pins.length, 2);
    assert.ok(pins.every((pin) => pin.state === "consumed"));
    const executionsRows = readDecisionAttempts(key.id).filter((row) => row.lane === "execution");
    assert.equal(executionsRows.length, 3);
    assert.ok(
      executionsRows.every(
        (row) =>
          row.connection_id === codexId &&
          row.effort === "high" &&
          row.model === "gpt-6-sol" &&
          row.cost_usd === null
      )
    );
  }
);
for (const provider of ["codex", "agy"] as const) {
  test(
    `installed SDK native-output ${provider} tools account usage beyond planning allowance without claiming a ceiling`,
    options,
    async () => {
      await configureNativeText(provider, { tools: true });
      nativeLargeUsage = true;
      const { result, observations } = await sdk(source("omitted-cap-tools"), "tool-loop");
      assert.equal(result.ok, true, JSON.stringify({ error: result.errorClass, observations }));
      assert.equal(decisions, 1);
      assert.equal(executions, 2);
      for (const row of readDecisionAttempts(key.id).filter((item) => item.lane === "execution")) {
        assert.equal(row.output_tokens, provider === "agy" ? 128 : 96);
        assert.equal(row.reasoning_tokens, 32);
        assert.equal(row.cost_usd, null);
      }
      for (const observed of observations) {
        assert.equal(observed.outputPolicy, "provider-native");
        assert.equal(observed.outputLimitEnforced, "false");
      }
    }
  );
}
for (const provider of ["codex", "agy"] as const) {
  for (const status of [401, 403, 429]) {
    test(
      `installed SDK native-output ${provider} tools HTTP${status} is terminal with unknown usage and no pin`,
      options,
      async () => {
        await configureNativeText(provider, { tools: true });
        denial = status;
        const { result, requests } = await sdk(source("omitted-cap-tools"), "tool-loop");
        assert.equal(result.ok, false);
        assert.equal(requests.length, 1);
        assert.equal(decisions, 1);
        assert.equal(executions, 1);
        assert.deepEqual(readToolContinuations(key.id, comboId), []);
        const execution = readDecisionAttempts(key.id).find((row) => row.lane === "execution")!;
        assert.equal(execution.http_status, status);
        assert.equal(execution.input_tokens, null);
        assert.equal(execution.output_tokens, null);
        assert.equal(execution.cost_usd, null);
      }
    );
  }
}
test(
  "installed SDK native-output Codex tools fail closed after private replay loss",
  options,
  async () => {
    await configureNativeText("codex", { tools: true });
    missingReplay = true;
    const { result, requests, observations } = await sdk(source("omitted-cap-tools"), "tool-loop");
    assert.equal(result.ok, false);
    assert.equal(requests.length, 2);
    assert.equal(observations[1].status, 409);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId)[0].state, "issued");
  }
);
test(
  "installed SDK native-output Codex tools reject changed terminal arguments without authority",
  options,
  async () => {
    await configureNativeText("codex", { tools: true });
    nativeMalformedArguments = true;
    const { result, requests } = await sdk(source("omitted-cap-tools"), "tool-loop");
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.deepEqual(readToolContinuations(key.id, comboId), []);
  }
);
test(
  "installed SDK native-output Codex cancellation cannot issue continuation authority",
  options,
  async () => {
    await configureNativeText("codex", { tools: true });
    const { result, requests } = await sdk(source("omitted-cap-tools"), "cancel");
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.deepEqual(readToolContinuations(key.id, comboId), []);
  }
);
for (const provider of ["codex", "agy"] as const) {
  test(
    `installed SDK native-output omitted-cap source reaches original ${provider} High once`,
    options,
    async () => {
      await configureNativeText(provider);
      const capture = source("omitted-cap");
      const originalKwargs = structuredClone(capture.capturedKwargs);
      for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
        assert.equal(capture.capturedKwargs[field], undefined);
      // The unchanged original builder omits streaming; this driver choice is declared separately.
      capture.driverFlags = { stream: true, stream_options: { include_usage: true } };
      const { result, requests, observations } = await sdk(capture, "stream");
      assert.equal(result.ok, true, JSON.stringify({ error: result.errorClass, observations }));
      assert.deepEqual(capture.capturedKwargs, originalKwargs);
      assert.equal(result.fullHermesExecuted, false);
      assert.equal(result.actualToolsRun, false);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].reasoning_effort, "high");
      assert.deepEqual(requests[0].messages, originalKwargs.messages);
      for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
        assert.equal(requests[0][field], undefined);
      assert.equal(
        (result.summaries as Array<Record<string, unknown>>)[0].content,
        "Synthetic SDK OK"
      );
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.length, 2);
      const execution = rows.find((row) => row.lane === "execution")!;
      const decision = rows.find((row) => row.lane === "decision")!;
      assert.equal(execution.provider, provider);
      assert.equal(execution.model, provider === "codex" ? "gpt-6-sol" : BOUNDED_AGY_OPUS_MODEL);
      assert.equal(execution.effort, "high");
      assert.equal(execution.connection_id, provider === "codex" ? codexId : agyId);
      assert.equal(execution.application_status, 200);
      assert.equal(
        execution.cost_usd,
        null,
        "Undocumented native receipt is unknown, not zero or foreign cost"
      );
      assert.equal(decision.cost_usd, 0, "Explicit synthetic decision zero remains separate");
      assert.equal(observations[0].status, 200);
    }
  );
  test(
    `installed SDK native-output original ${provider} High rejects explicit caller cap before stages`,
    options,
    async () => {
      await configureNativeText(provider);
      const capture = source("explicit-high");
      assert.equal(capture.capturedKwargs.max_tokens, 64);
      capture.driverFlags = { stream: true, stream_options: { include_usage: true } };
      const { result, requests, observations } = await sdk(capture, "stream");
      assert.equal(result.ok, false);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].max_tokens, 64);
      assert.equal(observations[0].status, 409);
      assert.equal(decisions, 0);
      assert.equal(executions, 0);
      assert.deepEqual(readDecisionAttempts(key.id), []);
    }
  );
}
for (const [caseName, value] of [
  ["explicit-medium", "medium"],
  ["explicit-high", "high"],
])
  test(
    `installed SDK serializes original ${caseName} kwargs and parses actual-handler JSON`,
    options,
    async () => {
      effort = value;
      const { result, requests, observations } = await sdk(source(caseName), "json");
      assert.equal(
        result.ok,
        true,
        JSON.stringify({
          error: result.errorClass,
          status: result.status,
          observations: typeof observations === "undefined" ? null : observations,
        })
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].reasoning_effort, value);
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
      assert.equal(
        (result.summaries as Array<Record<string, unknown>>)[0].content,
        "Synthetic SDK OK"
      );
      assert.equal(result.fullHermesExecuted, false);
    }
  );
test(
  "installed SDK parses actual-handler SSE and closes normally on its terminal",
  options,
  async () => {
    const { result, requests } = await sdk(source("default-stream"), "stream");
    assert.equal(result.ok, true);
    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(
      readDecisionAttempts(key.id).filter((row) => row.lane === "execution")[0].application_status,
      200
    );
  }
);
test(
  "actual SDK assembles tools, original constructors build results, and next SDK POST stays pinned",
  options,
  async () => {
    const { result, requests } = await sdk(source("stream-tools"), "tool-loop");
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
    const summaries = result.summaries as Array<Record<string, unknown>>;
    assert.equal(summaries[0].callCount, 2);
    assert.equal(summaries[1].content, "Synthetic SDK OK");
    assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
    assert.ok(JSON.stringify(wires[1]).includes("synthetic-sdk-account-signature"));
    const rows = readDecisionAttempts(key.id).filter((row) => row.lane === "execution");
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.connection_id, sonnetId);
      assert.equal(row.application_status, 200);
      assert.equal(row.cost_usd, 0.003);
    }
  }
);
for (const status of [401, 429])
  test(
    `actual SDK receives terminal ${status} without SDK retry or provider fallback`,
    options,
    async () => {
      denial = status;
      const { result, requests } = await sdk(source("default-stream"), "stream");
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(requests.length, 1);
      assert.equal(decisions, 1);
      assert.equal(executions, 1);
      assert.equal(readToolContinuations(key.id, comboId).length, 0);
    }
  );
test(
  "SDK cancellation closes the actual handler before tool completion without a pin",
  options,
  async () => {
    const { result } = await sdk(source("stream-tools"), "cancel");
    assert.equal(result.ok, true);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    assert.equal(
      readDecisionAttempts(key.id).filter((row) => row.lane === "execution")[0].application_status,
      499
    );
  }
);
test(
  "SDK-built continuation cannot replace missing signed replay with the public ID cache",
  options,
  async () => {
    missingReplay = true;
    const { result, requests } = await sdk(source("stream-tools"), "tool-loop");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(requests.length, 2);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  }
);
for (const zero of [false, true])
  test(`actual SDK usage retains ${zero ? "genuine zero" : "unknown"} cost`, options, async () => {
    missingCost = !zero;
    zeroCost = zero;
    const { result } = await sdk(source("default-stream"), "stream");
    assert.equal(result.ok, true);
    const summary = (result.summaries as Array<{ usage: Record<string, unknown> }>)[0];
    assert.equal(summary.usage.cost, zero ? 0 : null);
    assert.equal(
      readDecisionAttempts(key.id).filter((row) => row.lane === "execution")[0].cost_usd,
      zero ? 0 : null
    );
  });

function effortSource(caseName: string, tools: boolean) {
  const run = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      fileURLToPath(
        new URL("../fixtures/decisionPolicy/hermesEffort/build_request.py", import.meta.url)
      ),
    ],
    {
      env: { PATH: process.env.PATH!, HOME: `${process.env.DATA_DIR}/empty-effort-sdk-home` },
      input: JSON.stringify({ case: caseName, tools }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 200000,
    }
  );
  assert.equal(run.status, 0, "Approved profile source fixture must complete");
  const capture = JSON.parse(run.stdout);
  assert.equal(capture.ok, true);
  assert.equal(capture.clientBaseURL, "https://hermes.fixture.invalid/v1");
  assert.equal(capture.fullHermesExecuted, false);
  assert.equal(capture.sdkWireCaptured, false);
  return capture;
}
test(
  "installed SDK preserves opt-in delegated effort omission through both tool requests",
  options,
  async () => {
    delegated = true;
    effort = "high";
    const capture = effortSource("delegated-unset", true);
    assert.equal(Object.hasOwn(capture.capturedKwargs, "reasoning_effort"), false);
    const { result, requests } = await sdk(capture, "tool-loop");
    assert.equal(
      result.ok,
      true,
      JSON.stringify({ error: result.errorClass, status: result.status })
    );
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(Object.hasOwn(request, "reasoning_effort"), false);
    assert.equal(decisions, 1);
    assert.equal(executions, 2);
    for (const row of readDecisionAttempts(key.id).filter((row) => row.lane === "execution")) {
      assert.equal(row.effort, "high");
      assert.equal(row.connection_id, sonnetId);
      assert.equal(row.application_status, 200);
    }
  }
);
for (const value of ["medium", "high"])
  test(`installed SDK retains explicit ${value} in the opt-in relay profile`, options, async () => {
    effort = value;
    const { result, requests } = await sdk(effortSource(`explicit-${value}`, false), "stream");
    assert.equal(result.ok, true);
    assert.equal(requests[0].reasoning_effort, value);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
  });
for (const value of ["xhigh", "max"])
  for (const omit of [false, true])
    test(
      `installed SDK ${omit ? "delegates omitted effort to" : "preserves explicit"} original Claude ${value} across the pinned tool loop`,
      options,
      async () => {
        widePool = true;
        delegated = omit;
        effort = value;
        missingCost = omit && value === "max";
        await updateCombo(comboId, { config: config(true) });
        const capture = effortSource(omit ? "delegated-unset" : `explicit-${value}`, true);
        assert.equal(Object.hasOwn(capture.capturedKwargs, "reasoning_effort"), !omit);
        assert.equal(capture.capturedKwargs.reasoning_effort, omit ? undefined : value);
        const { result, requests, observations } = await sdk(capture, "tool-loop");
        assert.equal(
          result.ok,
          true,
          JSON.stringify({ error: result.errorClass, observations, decisions, executions })
        );
        assert.equal(requests.length, 2);
        assert.equal(observations.length, 2);
        for (const request of requests) {
          assert.equal(Object.hasOwn(request, "reasoning_effort"), !omit);
          assert.equal(request.reasoning_effort, omit ? undefined : value);
          assert.equal(request.reasoning, undefined);
          assert.equal(request.max_tokens, 64);
        }
        for (const observation of observations) assert.equal(observation.status, 200);
        assert.equal(
          decisions,
          1,
          "only the initial request selects among the eligible original pairs"
        );
        assert.equal(executions, 2);
        assert.equal(wires.length, 2);
        for (const wire of wires) {
          assert.equal(wire.model, "claude-sonnet-5-5");
          assert.equal((wire.output_config as { effort: string }).effort, value);
          assert.equal(wire.max_tokens, 64);
          assert.equal(Object.hasOwn(wire, "temperature"), false);
        }
        const summaries = result.summaries as Array<{ callCount: number; content: string }>;
        assert.equal(summaries[0].callCount, 2);
        assert.equal(summaries[1].callCount, 0);
        assert.equal(summaries[1].content, "Synthetic SDK OK");
        const rows = readDecisionAttempts(key.id);
        const decision = rows.filter((row) => row.lane === "decision");
        const execution = rows.filter((row) => row.lane === "execution");
        assert.equal(rows.length, 3);
        assert.equal(decision.length, 1);
        assert.equal(decision[0].cost_usd, 0);
        assert.equal(execution.length, 2);
        for (const row of execution) {
          assert.equal(row.provider, "claude");
          assert.equal(row.model, "claude-sonnet-5-5");
          assert.equal(row.connection_id, sonnetId);
          assert.equal(row.effort, value);
          assert.equal(row.application_status, 200);
          assert.equal(row.state, "completed");
          assert.equal(row.cost_usd, missingCost ? null : 0.003);
        }
        assert.equal(readToolContinuations(key.id, comboId).length, 1);
        assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
        assert.equal(result.fullHermesExecuted, false);
        controlTraces.push({
          control: "original-claude-wide-effort",
          effort: value,
          requestEffort: omit ? "omitted" : "explicit",
          decisions,
          executions,
          handlerStatuses: observations.map((row) => row.status),
          journal: rows.map((row) => ({
            lane: row.lane,
            provider: row.provider,
            model: row.model,
            effort: row.effort,
            state: row.state,
            applicationStatus: row.application_status,
            costUsd: row.cost_usd,
          })),
        });
      }
    );
for (const caseName of ["explicit-off", "recovery-off"])
  test(`installed SDK does not turn ${caseName} into enabled thinking`, options, async () => {
    const capture = effortSource(caseName, false);
    assert.equal(capture.capturedKwargs.reasoning_effort, "none");
    const { result, requests } = await sdk(capture, "stream");
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(requests[0].reasoning_effort, "none");
    assert.equal(decisions, 0);
    assert.equal(executions, 0);
  });

// Opaque signatures exercise structural replay only, not provider cryptography.
for (const count of [1, 2])
  test(
    `installed SDK completes ${count} native AGY calls through original Hermes result constructors`,
    options,
    async () => {
      await configureAgy(count === 2);
      const { result, requests, observations } = await sdk(source("stream-tools"), "tool-loop");
      assert.equal(
        result.ok,
        true,
        JSON.stringify({
          error: result.errorClass,
          status: result.status,
          observations,
          decisions,
          executions,
        })
      );
      assert.equal(requests.length, 2);
      assert.equal(decisions, 1);
      assert.equal(executions, 2);
      for (const request of requests) assert.equal(request.reasoning_effort, "high");
      const summaries = result.summaries as Array<Record<string, unknown>>;
      assert.equal(summaries[0].callCount, count);
      assert.equal(summaries[1].content, "Synthetic SDK OK");
      const native = wires[1].request as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      const parts = native.contents.flatMap((row) => row.parts);
      assert.deepEqual(
        parts.filter((part) => part.functionCall),
        agyParts()
      );
      assert.deepEqual(
        parts.filter((part) => part.functionResponse),
        agyParts().map((part) => {
          const call = part.functionCall as { id: string; name: string };
          return {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { output: "Synthetic result" },
            },
          };
        })
      );
      assert.ok(
        parts.findIndex((part) => part.functionResponse) >
          parts.findLastIndex((part) => part.functionCall)
      );
      assert.ok(!JSON.stringify(wires[1]).includes("skip_thought_signature_validator"));
      assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.filter((row) => row.lane === "decision").length, 1);
      assert.equal(rows.find((row) => row.lane === "decision")?.cost_usd, 0);
      const executionRows = rows.filter((row) => row.lane === "execution");
      assert.equal(executionRows.length, 2);
      for (const row of executionRows) {
        assert.equal(row.connection_id, agyId);
        assert.equal(row.provider, "agy");
        assert.equal(row.model, BOUNDED_AGY_MODEL);
        assert.equal(row.effort, "high");
        assert.equal(row.application_status, 200);
        assert.equal(row.cost_usd, null);
      }
      assert.equal(result.fullHermesExecuted, false);
    }
  );
test(
  "installed SDK receives native AGY no-call refusal without continuation or retry",
  options,
  async () => {
    await configureAgy(true);
    agyRefuse = true;
    const { result, requests, observations } = await sdk(source("stream-tools"), "stream");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "ContentFilterFinishReasonError");
    assert.equal(result.status, null);
    assert.equal(observations[0].status, 200);
    assert.equal(requests.length, 1);
    assert.equal(decisions, 1);
    assert.equal(executions, 1);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
    const row = readDecisionAttempts(key.id).find((item) => item.lane === "execution")!;
    assert.equal(row.http_status, 200);
    assert.equal(row.application_status, 422);
    assert.equal(row.input_tokens, 2);
    assert.equal(row.output_tokens, 4);
    assert.equal(row.reasoning_tokens, 1);
    assert.equal(row.cost_usd, null);
  }
);

for (const [mode, count] of [
  ["absent", 1],
  ["mixed", 2],
] as const)
  test(
    `installed SDK ${mode} native ID ${count}-call group keeps generated IDs client-only`,
    options,
    async () => {
      await configureAgy(count === 2);
      agyIdMode = mode;
      const { result, requests, observations } = await sdk(source("stream-tools"), "tool-loop");
      assert.equal(
        result.ok,
        true,
        JSON.stringify({
          error: result.errorClass,
          status: result.status,
          observations,
          decisions,
          executions,
        })
      );
      assert.equal(requests.length, 2);
      assert.equal(decisions, 1);
      assert.equal(executions, 2);
      const summaries = result.summaries as Array<{
        calls: Array<{ id: string }>;
        callCount: number;
        content: string;
      }>;
      const namespace = createGeminiCorrelationNamespace(agyOriginId);
      assert.deepEqual(
        summaries[0].calls.map((call) => call.id),
        agyParts().map((part, ordinal) => {
          const native = part.functionCall as Record<string, unknown>;
          return resolveGeminiClientCallId(
            Object.hasOwn(native, "id") ? (native.id as string) : null,
            namespace,
            ordinal
          );
        })
      );
      assert.equal(new Set(summaries[0].calls.map((call) => call.id)).size, count);
      assert.equal(summaries[1].content, "Synthetic SDK OK");
      const wire = wires[1].request as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      const parts = wire.contents.flatMap((row) => row.parts);
      assert.deepEqual(
        parts.filter((part) => part.functionCall),
        agyParts()
      );
      assert.deepEqual(
        parts.filter((part) => part.functionResponse),
        agyParts().map((part) => {
          const call = part.functionCall as Record<string, unknown>;
          return {
            functionResponse: {
              ...(Object.hasOwn(call, "id") ? { id: call.id } : {}),
              name: call.name,
              response: { output: "Synthetic result" },
            },
          };
        })
      );
      assert.ok(!JSON.stringify(wires[1]).includes("skip_thought_signature_validator"));
      assert.equal(readToolContinuations(key.id, comboId)[0].state, "consumed");
      const rows = readDecisionAttempts(key.id);
      assert.equal(rows.filter((row) => row.lane === "decision").length, 1);
      assert.equal(rows.find((row) => row.lane === "decision")?.cost_usd, 0);
      const executionsRows = rows.filter((row) => row.lane === "execution");
      assert.equal(executionsRows.length, 2);
      for (const row of executionsRows) {
        assert.equal(row.connection_id, agyId);
        assert.equal(row.model, BOUNDED_AGY_MODEL);
        assert.equal(row.effort, "high");
        assert.equal(row.application_status, 200);
        assert.equal(row.cost_usd, null);
      }
      assert.equal(result.fullHermesExecuted, false);
    }
  );

const configuredControls = [
  ["temperature", "configured-temperature", 0.7],
  ["top_p", "configured-top-p", 0.9],
  ["strict-absent", "configured-strict-absent", undefined],
  ["strict-false", "configured-strict-false", false],
  ["strict-true", "configured-strict-true", true],
] as const;
for (const provider of ["claude", "agy"] as const)
  test(
    `configured Hermes nested enabled High reaches SDK and ${provider} text contract`,
    options,
    async () => {
      const capture = source("configured-reasoning-high");
      assert.equal(capture.capturedKwargs.reasoning_effort, "high");
      assert.deepEqual(capture.capturedKwargs.extra_body, {
        reasoning: { enabled: true, effort: "high" },
      });
      for (const name of [
        "_build_chat_completions_kwargs",
        "_build_kwargs_from_profile",
        "_base_kwargs",
      ])
        assert.ok(
          capture.executedSourceFunctions.some((entry: string) => entry.endsWith(":" + name))
        );
      if (provider === "agy") {
        configuredReasoningText = true;
        await configureAgy(false, true);
      }
      const { result, requests, observations } = await sdk(capture, "stream");
      const rows = readDecisionAttempts(key.id);
      controlTraces.push({
        provider,
        control: "configured-nested-enabled-high",
        handlerStatus: observations[0]?.status ?? null,
        decisions,
        executions,
        journal: rows.map((row) => ({
          lane: row.lane,
          provider: row.provider,
          state: row.state,
          httpStatus: row.http_status,
          applicationStatus: row.application_status,
          costUsd: row.cost_usd,
        })),
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].reasoning_effort, "high");
      assert.deepEqual(requests[0].reasoning, { enabled: true, effort: "high" });
      assert.equal(requests[0].max_tokens, 64);
      assert.equal(requests[0].stream, true);
      assert.deepEqual(requests[0].stream_options, { include_usage: true });
      assert.equal(observations.length, 1);
      assert.equal(
        observations[0].status,
        200,
        JSON.stringify({ result, observations, decisions, executions })
      );
      assert.equal(result.ok, true);
      assert.equal((result.summaries as Array<{ content: string }>)[0].content, "Synthetic SDK OK");
      assert.equal(decisions, provider === "agy" ? 0 : 1);
      assert.equal(executions, 1);
      assert.equal(rows.length, provider === "agy" ? 1 : 2);
      const execution = rows.filter((row) => row.lane === "execution");
      assert.equal(execution.length, 1);
      assert.equal(execution[0].provider, provider);
      assert.equal(
        execution[0].model,
        provider === "agy" ? BOUNDED_AGY_MODEL : "claude-sonnet-5-5"
      );
      assert.equal(execution[0].connection_id, provider === "agy" ? agyId : sonnetId);
      assert.equal(execution[0].effort, "high");
      assert.equal(execution[0].application_status, 200);
      assert.equal(execution[0].cost_usd, provider === "agy" ? null : 0.003);
      assert.equal(
        rows.find((row) => row.lane === "decision")?.cost_usd,
        provider === "agy" ? undefined : 0
      );
      assert.equal(readToolContinuations(key.id, comboId).length, 0);
      assert.equal(result.fullHermesExecuted, false);
    }
  );
test(
  "configured Hermes conflicting nested effort reaches SDK then rejects before any provider attempt",
  options,
  async () => {
    const capture = source("configured-reasoning-conflict");
    assert.equal(capture.capturedKwargs.reasoning_effort, "high");
    assert.deepEqual(capture.capturedKwargs.extra_body, {
      reasoning: { enabled: true, effort: "medium" },
    });
    const { result, requests, observations } = await sdk(capture, "stream");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning_effort, "high");
    assert.deepEqual(requests[0].reasoning, { enabled: true, effort: "medium" });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 409);
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(decisions, 0);
    assert.equal(executions, 0);
    assert.equal(readDecisionAttempts(key.id).length, 0);
    assert.equal(readToolContinuations(key.id, comboId).length, 0);
  }
);
for (const provider of ["claude", "agy"] as const)
  for (const [control, fixtureCase, configuredValue] of configuredControls)
    test(`configured Hermes ${control} reaches SDK and ${provider} contract`, options, async () => {
      const capture = source(fixtureCase);
      for (const name of [
        "_build_chat_completions_kwargs",
        "_build_kwargs_from_profile",
        "_base_kwargs",
      ])
        assert.ok(
          capture.executedSourceFunctions.some((entry: string) => entry.endsWith(":" + name))
        );
      const sampling = control === "temperature" || control === "top_p";
      const originalFunction = capture.capturedKwargs.tools[0].function;
      assert.deepEqual(originalFunction.parameters, CONTROL_SCHEMA);
      assert.equal(originalFunction.strict, sampling ? undefined : configuredValue);
      assert.equal(
        Object.hasOwn(originalFunction, "strict"),
        !sampling && configuredValue !== undefined
      );
      for (const field of ["temperature", "top_p"])
        assert.equal(
          capture.capturedKwargs[field],
          field === control ? configuredValue : undefined
        );
      if (provider === "agy") await configureAgy(true, true);
      configuredSchema = structuredClone(CONTROL_SCHEMA);
      checkConfiguredStrict = !sampling;
      configuredStrict = typeof configuredValue === "boolean" ? configuredValue : undefined;
      const { result, requests, observations } = await sdk(capture, "stream");
      const rows = readDecisionAttempts(key.id);
      controlTraces.push({
        provider,
        control,
        configuredValue: configuredValue ?? "absent",
        handlerStatus: observations[0]?.status ?? null,
        sdkErrorClass: result.errorClass ?? null,
        decisions,
        executions,
        journal: rows.map((row) => ({
          lane: row.lane,
          provider: row.provider,
          state: row.state,
          httpStatus: row.http_status,
          applicationStatus: row.application_status,
          costUsd: row.cost_usd,
        })),
      });
      assert.equal(requests.length, 1, "the actual SDK must reach the handler once");
      const wireFunction = (requests[0].tools as Array<{ function: Record<string, unknown> }>)[0]
        .function;
      assert.deepEqual(
        wireFunction,
        originalFunction,
        "SDK serialization preserves configured tool fields"
      );
      for (const field of ["temperature", "top_p"])
        assert.equal(requests[0][field], field === control ? configuredValue : undefined);
      const rejected = sampling || (provider === "agy" && configuredValue !== undefined);
      assert.equal(observations.length, 1);
      assert.equal(
        observations[0].status,
        rejected ? 409 : 200,
        JSON.stringify({ result, observations, decisions, executions })
      );
      if (rejected) {
        assert.equal(result.ok, false);
        assert.equal(result.status, 409);
        assert.equal(decisions, 0);
        assert.equal(executions, 0);
        assert.equal(rows.length, 0, "unsupported controls cannot reserve any provider attempt");
        assert.equal(readToolContinuations(key.id, comboId).length, 0);
      } else {
        assert.equal(result.ok, true);
        const summary = (
          result.summaries as Array<{ callCount: number; calls: Array<{ arguments: string }> }>
        )[0];
        assert.equal(summary.callCount, 2);
        assert.equal(summary.calls.length, 2);
        for (const call of summary.calls) {
          const argumentsValue = JSON.parse(call.arguments);
          assert.deepEqual(Object.keys(argumentsValue), ["item"]);
          assert.equal(
            typeof argumentsValue.item,
            "string",
            "mock final arguments satisfy the configured strict schema"
          );
        }
        assert.equal(decisions, provider === "agy" ? 0 : 1);
        assert.equal(executions, 1);
        assert.equal(
          rows.filter((row) => row.lane === "decision").length,
          provider === "agy" ? 0 : 1
        );
        const execution = rows.filter((row) => row.lane === "execution");
        assert.equal(execution.length, 1);
        assert.equal(execution[0].provider, provider);
        assert.equal(execution[0].application_status, 200);
        assert.equal(execution[0].cost_usd, provider === "agy" ? null : 0.003);
      }
    });
