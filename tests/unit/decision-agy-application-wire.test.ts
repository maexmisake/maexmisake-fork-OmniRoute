import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationProviderIdentity,
  withApplicationAttempt,
  type ApplicationAttempt,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import {
  applicationAgyWireFacts,
  supportsApplicationAgyRequest,
} from "../../src/lib/decisionPolicy/applicationGemini.ts";
import type { ChatPolicyBody } from "../../open-sse/services/decisionPolicy/requestFacts.ts";
import { ANTIGRAVITY_DEFAULT_SYSTEM } from "../../open-sse/config/constants.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { createValidationDispatchFence } from "../../src/lib/modelValidation/dispatchFence.ts";

const model = "gemini-3.8-flash-high";
const prepared = {
  provider: "agy",
  model,
  effort: "high",
  executionContract: "agy-gemini-high-v1",
} as ApplicationAttempt;
const body: ChatPolicyBody = {
  model: "synthetic-opt-in-combo",
  messages: [{ role: "user", content: "Synthetic text only" }],
  stream: true,
  max_completion_tokens: 16,
};

test("ordinary resolver identity stays unchanged without trusted application context", () => {
  assert.equal(
    applicationProviderIdentity("antigravity", model, `agy/${model}`, null),
    "antigravity"
  );
});
test("only exact trusted AGY High context restores its logical credential namespace", () => {
  assert.equal(
    withApplicationAttempt(prepared, () =>
      applicationProviderIdentity("antigravity", model, `agy/${model}`, null)
    ),
    "agy"
  );
});
for (const mutation of [
  { executionContract: undefined },
  { executionContract: "untrusted" },
  { provider: "antigravity" },
  { provider: "claude" },
  { model: "gemini-3.8-flash" },
  { effort: "medium" },
]) {
  test(`different private context cannot restore AGY namespace: ${JSON.stringify(mutation)}`, () => {
    const attempt = { ...prepared, ...mutation } as ApplicationAttempt;
    assert.equal(
      withApplicationAttempt(attempt, () =>
        applicationProviderIdentity("antigravity", model, `agy/${model}`, null)
      ),
      "antigravity"
    );
  });
}
for (const [provider, resolved, requested, combo] of [
  ["claude", model, `agy/${model}`, null],
  ["antigravity", "gemini-3.8-flash", `agy/${model}`, null],
  ["antigravity", model, `antigravity/${model}`, null],
  ["antigravity", model, model, null],
  ["antigravity", model, `agy/${model}`, "synthetic-combo"],
] as const) {
  test(`nonexact resolver inputs preserve ordinary provider ${provider}/${String(resolved)}/${requested}/${combo}`, () => {
    assert.equal(
      withApplicationAttempt(prepared, () =>
        applicationProviderIdentity(provider, resolved, requested, combo)
      ),
      provider
    );
  });
}
test("nonempty text transcript is eligible for bounded AGY streaming", () => {
  assert.equal(supportsApplicationAgyRequest(body), true);
});
test("null final user content cannot become an offered execution pair", () => {
  assert.equal(
    supportsApplicationAgyRequest({ ...body, messages: [{ role: "user", content: null }] }),
    false
  );
});
const credentials = { projectId: "synthetic-project", connectionId: "synthetic-account" };
function headers() {
  return new Headers({
    "user-agent": "OmniRoute-Antigravity/1.0",
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: "Bearer synthetic-fixture-token",
  });
}
function wire() {
  return {
    model,
    project: credentials.projectId,
    request: {
      contents: [{ role: "user", parts: [{ text: "Synthetic text only" }] }],
      systemInstruction: { role: "system", parts: [{ text: ANTIGRAVITY_DEFAULT_SYSTEM }] },
      generationConfig: {
        maxOutputTokens: 16,
        thinkingConfig: { thinkingLevel: "high" },
        topK: 40,
        topP: 1,
      },
    },
  };
}
test("final wire preserves exact High model, project, text, cap and known sampler defaults", () => {
  assert.deepEqual(
    applicationAgyWireFacts(wire(), headers(), credentials, body, 16),
    body.messages
  );
});
test("system text is relocated to the first user content without changing default system", () => {
  const original: ChatPolicyBody = {
    ...body,
    messages: [{ role: "system", content: "Synthetic user system" }, ...body.messages],
  };
  const final = wire();
  final.request.contents[0].parts.unshift({ text: "Synthetic user system" });
  assert.deepEqual(
    applicationAgyWireFacts(final, headers(), credentials, original, 16),
    original.messages
  );
});
type MutableWire = {
  model: string;
  project: string;
  userAgent?: string;
  request: {
    sessionId?: string;
    tools?: unknown[];
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    systemInstruction: { parts: Array<{ text: string }> };
    generationConfig: {
      maxOutputTokens?: number;
      thinkingConfig: { thinkingLevel: string; thinkingBudget?: number };
      topP: number;
      temperature?: number;
    };
  };
};
const mutations: Array<[string, (value: MutableWire) => void]> = [
  [
    "base model alias",
    (value) => {
      value.model = "gemini-3.8-flash";
    },
  ],
  [
    "other project",
    (value) => {
      value.project = "synthetic-other-project";
    },
  ],
  [
    "borrowed outer identity",
    (value) => {
      value.userAgent = "another-client";
    },
  ],
  [
    "session identity",
    (value) => {
      value.request.sessionId = "synthetic-session";
    },
  ],
  [
    "unknown request control",
    (value) => {
      value.request.tools = [];
    },
  ],
  [
    "extra contents",
    (value) => {
      value.request.contents.push({ role: "user", parts: [{ text: "extra" }] });
    },
  ],
  [
    "changed text",
    (value) => {
      value.request.contents[0].parts[0].text = "changed";
    },
  ],
  [
    "changed default system",
    (value) => {
      value.request.systemInstruction.parts[0].text = "changed";
    },
  ],
  [
    "raised output cap",
    (value) => {
      value.request.generationConfig.maxOutputTokens = 17;
    },
  ],
  [
    "omitted output cap",
    (value) => {
      delete value.request.generationConfig.maxOutputTokens;
    },
  ],
  [
    "different thinking level",
    (value) => {
      value.request.generationConfig.thinkingConfig.thinkingLevel = "low";
    },
  ],
  [
    "unproven thinking budget",
    (value) => {
      value.request.generationConfig.thinkingConfig.thinkingBudget = 100;
    },
  ],
  [
    "changed sampler",
    (value) => {
      value.request.generationConfig.topP = 0.5;
    },
  ],
  [
    "unknown sampler",
    (value) => {
      value.request.generationConfig.temperature = 0.2;
    },
  ],
];
for (const [label, mutate] of mutations) {
  test(`serialized final wire rejects ${label} before dispatch`, () => {
    const value = wire();
    mutate(value);
    assert.throws(
      () => applicationAgyWireFacts(value, headers(), credentials, body, 16),
      /^Error: decision_agy_final_request_unsupported$/
    );
  });
}
for (const [name, value] of [
  ["user-agent", "another-client"],
  ["content-type", "text/plain"],
  ["accept", "application/json"],
  ["x-goog-api-key", "synthetic-extra-credential"],
] as const) {
  test(`final wire rejects unsupported header ${name}`, () => {
    const actual = headers();
    actual.set(name, value);
    assert.throws(() => applicationAgyWireFacts(wire(), actual, credentials, body, 16));
  });
}
for (const change of [
  { stream: false },
  { max_completion_tokens: 65537 },
  { messages: [{ role: "user", content: "" }] },
  { messages: [{ role: "user", content: [] }] },
  { messages: [{ role: "user", content: [{ type: "text", text: "" }] }] },
  { messages: [{ role: "user", content: [{ type: "text", text: "x", hidden: true }] }] },
  {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "synthetic" } }] }],
  },
  { messages: [{ role: "user", content: "x", name: "synthetic" }] },
  { messages: [{ role: "user", content: "x", tool_call_id: "synthetic" }] },
  {
    messages: [
      { role: "assistant", content: "unpaired" },
      { role: "user", content: "x" },
    ],
  },
  { messages: [{ role: "assistant", content: "unfinished" }] },
  { tools: [{ type: "function", function: { name: "synthetic", parameters: {} } }] },
] as const) {
  test(`unsupported request shape is not offered: ${JSON.stringify(change)}`, () => {
    assert.equal(supportsApplicationAgyRequest({ ...body, ...change } as ChatPolicyBody), false);
  });
}
test("ordinary model-validation fence still rejects Antigravity without private capability", () => {
  const executor = new AntigravityExecutor();
  const fence = createValidationDispatchFence({
    provider: "antigravity",
    modelId: model,
    connectionId: "synthetic-account",
    signal: new AbortController().signal,
    assertFresh() {},
    expectedExecutor: executor,
  });
  assert.throws(() => fence.wrap(executor), /does not support strict model validation/);
});
for (const [provider, modelId] of [
  ["antigravity", model],
  ["agy", "gemini-3.8-flash"],
]) {
  test(`private dispatch flag cannot widen provider/model ${provider}/${modelId}`, () => {
    const executor = new AntigravityExecutor();
    const fence = createValidationDispatchFence({
      provider,
      modelId,
      connectionId: "synthetic-account",
      signal: new AbortController().signal,
      assertFresh() {},
      expectedExecutor: executor,
      allowNativeAgyGemini: true,
    });
    assert.throws(() => fence.wrap(executor), /could not be verified/);
  });
}
