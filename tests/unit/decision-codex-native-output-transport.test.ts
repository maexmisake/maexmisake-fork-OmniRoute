import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  CodexExecutor,
  __setCodexWebSocketTransportForTesting,
} from "../../open-sse/executors/codex.ts";
import {
  NATIVE_DECISION_CODEX_ENDPOINT,
  NATIVE_DECISION_CODEX_USER_AGENT,
  assertNativeDecisionCodexCredentials,
  isNativeDecisionCodexPair,
  nativeDecisionCodexProjection,
  nativeDecisionCodexWireFacts,
} from "../../open-sse/executors/codex/nativeDecision.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import {
  withApplicationAttempt,
  type ApplicationAttempt,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import type { ChatPolicyBody } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { withReasoningRuleContext } from "../../open-sse/utils/reasoningRuleContext.ts";
import {
  getCliCompatProviders,
  setCliCompatProviders,
} from "../../open-sse/config/cliFingerprints.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

const originalFetch = globalThis.fetch;
const originalCompat = getCliCompatProviders();
const credentials = {
  accessToken: "synthetic-codex-native-token",
  connectionId: "synthetic-codex-account",
  refreshToken: "synthetic-unused-refresh",
  expiresAt: "2030-01-01T00:00:00.000Z",
  providerSpecificData: { workspaceId: "synthetic-workspace" },
};
let calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
let status = 200;
let guarded = 0;
let observed = 0;
let websocketCalls = 0;
function originalBody(model = "gpt-6-sol", effort = "max"): ChatPolicyBody {
  return {
    model,
    messages: [
      { role: "system", content: "Use synthetic examples." },
      { role: "user", content: "One synthetic step." },
      { role: "assistant", content: "A prior synthetic answer." },
      { role: "developer", content: "Retain this instruction." },
      { role: "user", content: "Continue the synthetic explanation." },
    ],
    reasoning_effort: effort as ChatPolicyBody["reasoning_effort"],
    max_completion_tokens: 64,
    stream: true,
  };
}
function translated(body = originalBody()) {
  return openaiToOpenAIResponsesRequest(body.model, body, true, credentials) as Record<
    string,
    unknown
  >;
}
function context(model = "gpt-6-sol", effort = "max", controller = new AbortController()) {
  const dispatch = {
    singleAttempt: true as const,
    reject(): never {
      throw new Error("synthetic strict rejection");
    },
    beforeFetch(details: { url: string; headers?: HeadersInit; body?: BodyInit | null }) {
      guarded++;
      assert.equal(details.url, NATIVE_DECISION_CODEX_ENDPOINT);
      nativeDecisionCodexWireFacts(
        JSON.parse(String(details.body)),
        new Headers(details.headers),
        credentials,
        originalBody(model, effort),
        effort
      );
    },
  };
  const attempt: ApplicationAttempt = {
    id: "synthetic-native-codex-attempt",
    keyId: "synthetic-key",
    provider: "codex",
    model,
    effort,
    connectionId: credentials.connectionId,
    executionContract: "codex-native-output-v1",
    nativeOutput: { contextOutputTokens: 64 },
    signal: controller.signal,
    dispatch,
    assertIdle() {},
    assertFresh() {
      controller.signal.throwIfAborted();
    },
    fence(value: unknown) {
      return value;
    },
    observe(send) {
      observed++;
      return send;
    },
  };
  return { attempt, dispatch, controller };
}
function execute(model = "gpt-6-sol", effort = "max", patch = {}) {
  const c = context(model, effort);
  return withApplicationAttempt(c.attempt, () =>
    new CodexExecutor().execute({
      model,
      body: translated(originalBody(model, effort)),
      stream: true,
      credentials,
      signal: c.controller.signal,
      validationDispatch: c.dispatch,
      ...patch,
    })
  );
}
beforeEach(() => {
  calls = [];
  status = 200;
  guarded = 0;
  observed = 0;
  websocketCalls = 0;
  setCliCompatProviders([]);
  __setCodexWebSocketTransportForTesting(async () => {
    websocketCalls++;
    throw new Error("unexpected websocket");
  });
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    if (status !== 200)
      return Response.json(
        {
          error: {
            code: "invalid_encrypted_content",
            message: "The encrypted content could not be verified.",
          },
        },
        { status }
      );
    return new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  setCliCompatProviders(originalCompat);
  __setCodexWebSocketTransportForTesting(undefined);
  resetDbInstance();
});

for (const [model, efforts] of Object.entries({
  "gpt-6-luna": ["max"],
  "gpt-5.6-sol": ["medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["medium", "high", "xhigh", "max"],
}))
  for (const effort of efforts)
    test(`native Codex exact ${model}/${effort}: one guarded dispatch without a token ceiling`, async () => {
      const result = await execute(model, effort);
      assert.equal(result.response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(guarded, 1);
      assert.equal(observed, 1);
      assert.equal(websocketCalls, 0);
      const [call] = calls;
      assert.equal(call.body.model, model);
      assert.deepEqual(call.body.reasoning, { effort, summary: "auto" });
      assert.equal(call.body.max_tokens, undefined);
      assert.equal(call.body.max_output_tokens, undefined);
      assert.equal(call.body.max_completion_tokens, undefined);
      assert.equal(call.headers.get("user-agent"), NATIVE_DECISION_CODEX_USER_AGENT);
      assert.equal(
        call.headers.get("chatgpt-account-id"),
        credentials.providerSpecificData.workspaceId
      );
      assert.equal(call.headers.has("originator"), false);
      assert.equal(call.headers.has("version"), false);
    });
for (const code of [400, 401, 403, 429, 503])
  test(`native Codex ${code} returns first response without replay/refresh/rotation`, async () => {
    status = code;
    assert.equal((await execute()).response.status, code);
    assert.equal(calls.length, 1);
    assert.equal(guarded, 1);
    assert.equal(observed, 1);
    assert.equal(websocketCalls, 0);
  });
test("native Codex private mode cannot be activated by a strict observer alone", async () => {
  await assert.rejects(
    new CodexExecutor().execute({
      model: "gpt-6-sol",
      stream: true,
      body: translated(),
      credentials,
      validationDispatch: context().dispatch,
    }),
    /decision_codex_contract_unsupported/
  );
  assert.equal(calls.length, 0);
});
test("native Codex rejects aliases and unsupported original effort pairs", () => {
  assert.equal(isNativeDecisionCodexPair("gpt-6-luna", "high"), false);
  assert.equal(isNativeDecisionCodexPair("gpt-6-sol-max", "max"), false);
  assert.equal(isNativeDecisionCodexPair("gpt-6-sol", "ultra"), false);
  assert.equal(isNativeDecisionCodexPair("__proto__", "max"), false);
});
test("native Codex rejects expired/unknown expiry, endpoint, identity and transport overrides", async () => {
  const variants = [
    { ...credentials, expiresAt: "" },
    { ...credentials, expiresAt: "2020-01-01T00:00:00Z" },
    { ...credentials, apiKey: "synthetic-unexpected-key" },
    { ...credentials, requestEndpointPath: "/responses/compact" },
    {
      ...credentials,
      providerSpecificData: { ...credentials.providerSpecificData, codexTransport: "websocket" },
    },
    {
      ...credentials,
      providerSpecificData: { ...credentials.providerSpecificData, codexUseAppServer: true },
    },
    {
      ...credentials,
      providerSpecificData: {
        ...credentials.providerSpecificData,
        baseUrl: "https://example.invalid",
      },
    },
    { ...credentials, providerSpecificData: { workspaceId: "invalid\naccount" } },
    withReasoningRuleContext(credentials, {
      id: "synthetic-force",
      effortMode: "force",
      targetEffort: "medium",
    }),
  ];
  for (const variant of variants) {
    assert.throws(
      () => assertNativeDecisionCodexCredentials(variant),
      /decision_codex_contract_unsupported/
    );
    await assert.rejects(
      execute("gpt-6-sol", "max", { credentials: variant }),
      /decision_codex_contract_unsupported/
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(websocketCalls, 0);
});
test("native Codex rejects changed planning caps, injected controls, tools and transcript mutations", () => {
  const { attempt } = context();
  withApplicationAttempt(attempt, () => {
    const initial = translated();
    const mutations = [
      { ...initial, max_output_tokens: 65 },
      { ...initial, temperature: 1 },
      { ...initial, tools: [] },
      { ...initial, previous_response_id: "synthetic-id" },
      { ...initial, reasoning: { effort: "high" } },
      { ...initial, model: "gpt-6-luna" },
    ];
    for (const bad of mutations)
      assert.throws(() => nativeDecisionCodexProjection("gpt-6-sol", bad, credentials));
    const wire = nativeDecisionCodexProjection("gpt-6-sol", initial, credentials);
    const headers = new CodexExecutor().buildHeaders(credentials, true, null, "gpt-6-sol");
    assert.throws(() =>
      nativeDecisionCodexWireFacts(
        { ...wire, max_output_tokens: 64 },
        new Headers(headers),
        credentials,
        originalBody(),
        "max"
      )
    );
    assert.throws(() =>
      nativeDecisionCodexWireFacts(
        { ...wire, instructions: "Changed synthetic instruction" },
        new Headers(headers),
        credentials,
        originalBody(),
        "max"
      )
    );
    const changed = structuredClone(wire);
    (changed.input as Array<{ content: Array<{ text: string }> }>)[0].content[0].text =
      "Changed synthetic user text";
    assert.throws(() =>
      nativeDecisionCodexWireFacts(
        changed,
        new Headers(headers),
        credentials,
        originalBody(),
        "max"
      )
    );
    assert.throws(() =>
      nativeDecisionCodexWireFacts(
        wire,
        new Headers({ ...headers, "User-Agent": "codex_cli_rs/1.0" }),
        credentials,
        originalBody(),
        "max"
      )
    );
  });
  assert.equal(calls.length, 0);
});
test("native Codex cancelled input and changed connection stop before dispatch", async () => {
  const c = context();
  c.controller.abort();
  await assert.rejects(
    withApplicationAttempt(c.attempt, () =>
      new CodexExecutor().execute({
        model: "gpt-6-sol",
        body: translated(),
        stream: true,
        credentials,
        signal: c.controller.signal,
        validationDispatch: c.dispatch,
      })
    )
  );
  await assert.rejects(
    execute("gpt-6-sol", "max", {
      credentials: { ...credentials, connectionId: "synthetic-other-account" },
    })
  );
  assert.equal(calls.length, 0);
});
test("native Codex direct hooks cannot fall into legacy identity or endpoint behavior", () => {
  const { attempt } = context();
  withApplicationAttempt(attempt, () => {
    const executor = new CodexExecutor();
    assert.throws(() => executor.buildHeaders(credentials));
    assert.throws(() => executor.buildHeaders(credentials, false, null, "gpt-6-sol"));
    assert.throws(() => executor.buildUrl("gpt-6-sol", true, 0, null));
    const wire = nativeDecisionCodexProjection("gpt-6-sol", translated(), credentials);
    const headers = executor.buildHeaders(
      credentials,
      true,
      { "user-agent": "synthetic-borrowed-client" },
      "gpt-6-sol"
    );
    assert.equal(new Headers(headers).get("user-agent"), NATIVE_DECISION_CODEX_USER_AGENT);
    assert.throws(() =>
      nativeDecisionCodexWireFacts(
        wire,
        { ...headers, "x-api-key": "synthetic-extra-auth" },
        credentials,
        originalBody(),
        "max"
      )
    );
  });
  assert.equal(calls.length, 0);
});
test("native Codex rejects changed request-local catalog effort and CLI identity configuration", async () => {
  const metadata = {
    model: "gpt-6-sol",
    supportedThinkingEfforts: ["medium", "max"],
    resolvedThinkingEffort: "max",
    requestedThinkingEffort: "max",
  };
  await execute("gpt-6-sol", "max", {
    credentials: {
      ...credentials,
      providerSpecificData: {
        ...credentials.providerSpecificData,
        _omnirouteCodexThinking: metadata,
      },
    },
  });
  assert.equal(calls.length, 1);
  await assert.rejects(
    execute("gpt-6-sol", "max", {
      credentials: {
        ...credentials,
        providerSpecificData: {
          ...credentials.providerSpecificData,
          _omnirouteCodexThinking: { ...metadata, requestedThinkingEffort: "medium" },
        },
      },
    })
  );
  setCliCompatProviders(["codex"]);
  await assert.rejects(execute());
  assert.equal(calls.length, 1);
});
test("native Codex cancellation at the last dispatch fence produces no physical call", async () => {
  const c = context();
  c.attempt.dispatch.beforeFetch = () => c.controller.abort();
  await assert.rejects(
    withApplicationAttempt(c.attempt, () =>
      new CodexExecutor().execute({
        model: "gpt-6-sol",
        body: translated(),
        stream: true,
        credentials,
        signal: c.controller.signal,
        validationDispatch: c.dispatch,
      })
    )
  );
  assert.equal(calls.length, 0);
});
test("native Codex accepts an inert database-managed fingerprint seed without transmitting it", async () => {
  const seed = "00000000-0000-4000-8000-000000000099";
  await execute("gpt-6-sol", "max", {
    credentials: {
      ...credentials,
      providerSpecificData: { ...credentials.providerSpecificData, codexFingerprintSeed: seed },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0].body).includes(seed), false);
  assert.equal(JSON.stringify([...calls[0].headers]).includes(seed), false);
  assert.equal(calls[0].headers.get("user-agent"), NATIVE_DECISION_CODEX_USER_AGENT);
  assert.equal(calls[0].headers.has("originator"), false);
  assert.equal(calls[0].headers.has("session_id"), false);
  assert.equal(calls[0].headers.has("version"), false);
  for (const bad of ["", "a".repeat(1000), "bad\nseed", null]) {
    assert.throws(() =>
      assertNativeDecisionCodexCredentials({
        ...credentials,
        providerSpecificData: { ...credentials.providerSpecificData, codexFingerprintSeed: bad },
      })
    );
  }
});
test("native Codex restores only absent non-persistent store after the shared protocol sanitizer", () => {
  const { attempt } = context();
  withApplicationAttempt(attempt, () => {
    const body = translated();
    delete body.store;
    const wire = nativeDecisionCodexProjection("gpt-6-sol", body, credentials);
    assert.equal(wire.store, false);
    const headers = new CodexExecutor().buildHeaders(credentials, true, null, "gpt-6-sol");
    assert.deepEqual(
      nativeDecisionCodexWireFacts(wire, headers, credentials, originalBody(), "max").messages,
      originalBody().messages
    );
    assert.throws(() =>
      nativeDecisionCodexProjection("gpt-6-sol", { ...body, store: true }, credentials)
    );
    assert.throws(() =>
      nativeDecisionCodexProjection("gpt-6-sol", { ...body, store: null }, credentials)
    );
  });
  assert.equal(calls.length, 0);
});
