import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  applicationAgyNativeOutputRequest,
  applicationAgyProvider,
  applicationAgyWireFacts,
  isApplicationAgyPair,
} from "../../src/lib/decisionPolicy/applicationGemini.ts";
import {
  AGY_OPUS_NATIVE_OUTPUT_CONTRACT,
  BOUNDED_AGY_OPUS_MODEL,
  assertBoundedAgyInput,
} from "../../open-sse/executors/antigravity/bounded.ts";
import {
  withApplicationAttempt,
  type ApplicationAttempt,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import type { Candidate } from "../../open-sse/services/decisionPolicy/contract.ts";
import type { ChatPolicyBody } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import { ensureThinkingConfig } from "../../open-sse/services/thinkingBudget.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

const model = BOUNDED_AGY_OPUS_MODEL;
const connection = {
  id: "synthetic-opus-account",
  provider: "agy",
  isActive: true,
  authType: "oauth",
  accessToken: "synthetic-opus-access-token",
  tokenExpiresAt: "2030-01-01T00:00:00.000Z",
  projectId: "synthetic-opus-project",
  providerSpecificData: {},
};
const candidate: Candidate = {
  id: "historical_01",
  provider: "agy",
  model,
  endpointKind: "direct",
  evidence: "Synthetic declaration of the original exact slot; not live compatibility proof",
  capabilities: { text: true, tools: false, images: false, reasoning: true, contextTokens: 100000 },
  effort: {
    mode: "fixed",
    value: "high",
    supported: ["high"],
    evidence: "Historical fixed-profile label, not an adjustable vendor tier",
  },
};
const credentials = applicationAgyProvider(candidate, connection, true).credentials;
const original: ChatPolicyBody = {
  model: `agy/${model}`,
  messages: [
    { role: "system", content: "Synthetic user system" },
    { role: "user", content: "First synthetic turn" },
    { role: "assistant", content: "Prior synthetic reply" },
    { role: "user", content: "Second synthetic turn" },
  ],
  stream: true,
  // This is the private canonical planning allowance, not an accepted caller cap.
  max_completion_tokens: 16,
  reasoning_effort: "high",
};
const executor = new AntigravityExecutor();
function attempt(change: Partial<ApplicationAttempt> = {}): ApplicationAttempt {
  return {
    id: "synthetic-opus-attempt",
    keyId: "synthetic-key",
    provider: "agy",
    model,
    effort: "high",
    connectionId: connection.id,
    executionContract: AGY_OPUS_NATIVE_OUTPUT_CONTRACT,
    nativeOutput: { contextOutputTokens: 16 },
    signal: new AbortController().signal,
    dispatch: {
      singleAttempt: true,
      beforeFetch() {},
      reject() {
        throw new Error("fixture");
      },
    },
    assertIdle() {},
    assertFresh() {},
    fence(value: unknown) {
      return value;
    },
    observe(send: Promise<Response>) {
      return send;
    },
    ...change,
  } as ApplicationAttempt;
}
function translated(body = original) {
  return openaiToAntigravityRequest(model, body, true, credentials);
}
after(() => resetDbInstance());

test("full registered translation preserves fixed-native mode without suffix-based thinking synthesis", () => {
  const source = { ...structuredClone(original), model };
  const wire = withApplicationAttempt(attempt(), () =>
    translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, model, source, true, credentials, "agy")
  );
  assert.deepEqual(wire.request.generationConfig, { topK: 40, topP: 1 });
  assert.equal(wire.request.generationConfig.maxOutputTokens, undefined);
  assert.equal(wire.request.generationConfig.thinkingConfig, undefined);
  assert.equal((source as Record<string, unknown>).thinking, undefined);
});
test("ordinary thinking suffix synthesis remains intact outside the exact private contract", () => {
  const source = { model, messages: [{ role: "user", content: "Synthetic text" }] };
  const ordinary = ensureThinkingConfig(source) as Record<string, unknown>;
  assert.equal((ordinary.thinking as Record<string, unknown>).type, "enabled");
  assert.equal(typeof (ordinary.thinking as Record<string, unknown>).budget_tokens, "number");
  for (const change of [
    { executionContract: undefined },
    { provider: "antigravity" },
    { model: "gemini-3.8-flash-high" },
    { effort: "medium" },
    { nativeOutput: undefined },
  ]) {
    const result = withApplicationAttempt(attempt(change), () => ensureThinkingConfig(source));
    assert.deepEqual(result, ordinary);
  }
});
test("full registered translation still rejects an explicit or late-injected thinking carrier", () => {
  for (const thinking of [false, { type: "enabled", budget_tokens: 32000 }]) {
    assert.throws(() =>
      withApplicationAttempt(attempt(), () =>
        translateRequest(
          FORMATS.OPENAI,
          FORMATS.ANTIGRAVITY,
          model,
          { ...original, model, thinking },
          true,
          credentials,
          "agy"
        )
      )
    );
  }
});

test("original fixed High Opus requires explicit provider-native-output admission", () => {
  assert.equal(isApplicationAgyPair(candidate), false);
  assert.equal(isApplicationAgyPair(candidate, true), true);
  assert.throws(() => applicationAgyProvider(candidate, connection));
  assert.equal(
    applicationAgyProvider(candidate, connection, true).executionContract,
    AGY_OPUS_NATIVE_OUTPUT_CONTRACT
  );
});
for (const mutation of [
  { provider: "antigravity" },
  { model: "claude-opus-5-5" },
  { effort: { ...candidate.effort, mode: "set" as const } },
  { effort: { ...candidate.effort, value: "medium" as const } },
]) {
  test(`native output opt-in cannot widen the original fixed pair: ${JSON.stringify(mutation)}`, () => {
    assert.equal(isApplicationAgyPair({ ...candidate, ...mutation }, true), false);
  });
}
test("early private formatter preserves exact transcript and sends no cap or effort carrier", async () => {
  const source = structuredClone(original);
  const wire = await withApplicationAttempt(attempt(), async () => {
    const native = translated();
    assert.deepEqual(native.request.generationConfig, { topK: 40, topP: 1 });
    return executor.transformRequest(model, native, true, credentials);
  });
  assert.ok(!(wire instanceof Response));
  assert.equal(wire.model, model);
  assert.equal(wire.project, connection.projectId);
  assert.equal(wire.request.contents.length, 3);
  assert.deepEqual(wire.request.contents[0], {
    role: "user",
    parts: [{ text: "Synthetic user system" }, { text: "First synthetic turn" }],
  });
  assert.deepEqual(original, source);
  assert.deepEqual(
    applicationAgyWireFacts(
      wire,
      withApplicationAttempt(
        attempt(),
        () => new Headers(executor.buildHeaders(credentials, true, undefined, model))
      ),
      credentials,
      original,
      16,
      undefined,
      AGY_OPUS_NATIVE_OUTPUT_CONTRACT
    ),
    original.messages
  );
});
for (const key of [
  "max_tokens",
  "max_output_tokens",
  "thinking",
  "reasoning",
  "temperature",
  "tools",
]) {
  test(`early private formatter rejects late caller control ${key}`, () => {
    assert.throws(() =>
      withApplicationAttempt(attempt(), () => translated({ ...original, [key]: 16 }))
    );
  });
}
for (const change of [
  { max_completion_tokens: 17 },
  { reasoning_effort: "medium" },
  { stream: false },
  { messages: [{ role: "assistant", content: "unfinished" }] },
]) {
  test(`early private formatter rejects planning or transcript mutation ${JSON.stringify(change)}`, () => {
    assert.throws(() =>
      withApplicationAttempt(attempt(), () =>
        translated({ ...original, ...change } as ChatPolicyBody)
      )
    );
  });
}
type MutableOpusWire = {
  model: string;
  project: string;
  userAgent?: string;
  request: {
    generationConfig: Record<string, unknown>;
    sessionId?: string;
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  };
};
const wireMutations: Array<[string, (wire: MutableOpusWire) => void]> = [
  [
    "output cap",
    (wire) => {
      wire.request.generationConfig.maxOutputTokens = 16;
    },
  ],
  [
    "thinking level",
    (wire) => {
      wire.request.generationConfig.thinkingConfig = { thinkingLevel: "high" };
    },
  ],
  [
    "borrowed identity",
    (wire) => {
      wire.userAgent = "synthetic-other-client";
    },
  ],
  [
    "session",
    (wire) => {
      wire.request.sessionId = "synthetic-session";
    },
  ],
  [
    "project",
    (wire) => {
      wire.project = "synthetic-other-project";
    },
  ],
  [
    "model",
    (wire) => {
      wire.model = "claude-opus-5-5";
    },
  ],
  [
    "text",
    (wire) => {
      wire.request.contents[0].parts[0].text = "changed";
    },
  ],
];
for (const [label, mutate] of wireMutations) {
  test(`native projection/final fence rejects injected ${label}`, async () => {
    const wire = withApplicationAttempt(attempt(), () => translated());
    mutate(wire);
    const headers = withApplicationAttempt(
      attempt(),
      () => new Headers(executor.buildHeaders(credentials, true, undefined, model))
    );
    assert.throws(() =>
      applicationAgyWireFacts(
        wire,
        headers,
        credentials,
        original,
        16,
        undefined,
        AGY_OPUS_NATIVE_OUTPUT_CONTRACT
      )
    );
    if (label !== "text")
      await assert.rejects(() =>
        withApplicationAttempt(attempt(), () =>
          executor.transformRequest(model, wire, true, credentials)
        )
      );
  });
}
for (const change of [
  { provider: "antigravity" },
  { model: "gemini-3.8-flash-high" },
  { effort: "medium" },
  { connectionId: "synthetic-other-account" },
  { nativeOutput: undefined },
]) {
  test(`private Opus context mismatch rejects before ordinary transport: ${JSON.stringify(change)}`, () => {
    const context = attempt(change);
    assert.throws(() =>
      withApplicationAttempt(context, () =>
        assertBoundedAgyInput({
          model,
          body: original,
          stream: true,
          credentials,
          signal: context.signal,
          validationDispatch: context.dispatch,
        })
      )
    );
  });
}
test("cancellation prevents fixed-slot formatting and unsupported tools cannot enter", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() =>
    withApplicationAttempt(attempt({ signal: controller.signal }), () => translated())
  );
  assert.throws(() =>
    withApplicationAttempt(attempt({ tools: {} as ApplicationAttempt["tools"] }), () =>
      translated()
    )
  );
  assert.throws(() => applicationAgyNativeOutputRequest(model, original, true, credentials));
});
for (const status of [200, 401, 403, 404, 429, 503]) {
  test(`private fixed slot ${status} uses one exact mock send and no ancillary request`, async () => {
    const savedFetch = globalThis.fetch;
    let calls = 0;
    let checked = 0;
    let observed = 0;
    const expectedUrl =
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
    const context = attempt();
    context.dispatch = {
      ...context.dispatch,
      beforeFetch(details) {
        checked++;
        assert.equal(details.url, expectedUrl);
        const headers = new Headers(details.headers);
        applicationAgyWireFacts(
          JSON.parse(String(details.body)),
          headers,
          credentials,
          original,
          16,
          undefined,
          AGY_OPUS_NATIVE_OUTPUT_CONTRACT
        );
      },
    };
    context.observe = (send) => {
      observed++;
      return send;
    };
    globalThis.fetch = async (input) => {
      calls++;
      assert.equal(String(input), expectedUrl);
      return new Response("synthetic response", { status });
    };
    try {
      const result = await withApplicationAttempt(context, () =>
        executor.execute({
          model,
          body: translated(),
          stream: true,
          credentials,
          signal: context.signal,
          validationDispatch: context.dispatch,
        })
      );
      assert.equal(result.response.status, status);
      assert.deepEqual({ calls, checked, observed }, { calls: 1, checked: 1, observed: 1 });
      await result.response.body?.cancel();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
}
