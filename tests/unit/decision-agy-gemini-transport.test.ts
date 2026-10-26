import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import {
  withApplicationAttempt,
  type ApplicationAttempt,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import { clearAntigravityVersionCaches } from "../../open-sse/services/antigravityVersion.ts";
import {
  getCliCompatProviders,
  setCliCompatProviders,
} from "../../open-sse/config/cliFingerprints.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

const model = "gemini-3.8-flash-high";
const endpoint =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const originalFetch = globalThis.fetch;
const originalCompat = getCliCompatProviders();
const credentials = {
  accessToken: "synthetic-agy-token",
  connectionId: "synthetic-agy-account",
  projectId: "synthetic-agy-project",
  expiresAt: "2030-01-01T00:00:00.000Z",
  providerSpecificData: {},
};
let calls: Array<{ url: string; options?: RequestInit }> = [];
let status = 200;
let observed = 0;
let guarded = 0;
function body() {
  return openaiToAntigravityRequest(
    model,
    {
      model,
      messages: [{ role: "user", content: "Synthetic text only." }],
      reasoning_effort: "high",
      max_tokens: 16,
      stream: true,
    },
    true,
    credentials
  );
}
function response() {
  return new Response(
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"thoughtsTokenCount":0,"totalTokenCount":3}}}\n\n',
    {
      status,
      headers: { "content-type": "text/event-stream" },
    }
  );
}
function context(controller = new AbortController()) {
  const dispatch = {
    singleAttempt: true as const,
    reject(): never {
      throw new Error("synthetic strict rejection");
    },
    beforeFetch(details: { url: string; headers?: HeadersInit; body?: BodyInit | null }) {
      guarded++;
      assert.equal(details.url, endpoint);
      assert.equal(new Headers(details.headers).get("user-agent"), "OmniRoute-Antigravity/1.0");
      const wire = JSON.parse(String(details.body));
      assert.equal(wire.model, model);
      assert.equal(wire.project, credentials.projectId);
      assert.equal(wire.request.generationConfig.maxOutputTokens, 16);
      assert.equal(wire.request.generationConfig.thinkingConfig.thinkingLevel, "high");
      assert.equal(wire.userAgent, undefined);
      assert.equal(wire.requestType, undefined);
    },
  };
  const attempt = {
    id: "synthetic-attempt",
    keyId: "synthetic-key",
    provider: "agy",
    model,
    effort: "high",
    connectionId: credentials.connectionId,
    executionContract: "agy-gemini-high-v1",
    signal: controller.signal,
    dispatch,
    assertIdle() {},
    assertFresh() {
      controller.signal.throwIfAborted();
    },
    fence(value: unknown) {
      return value;
    },
    observe(send: Promise<Response>) {
      observed++;
      return send;
    },
  } as ApplicationAttempt;
  return { attempt, dispatch, controller };
}
beforeEach(() => {
  calls = [];
  status = 200;
  observed = 0;
  guarded = 0;
  clearAntigravityVersionCaches();
  setCliCompatProviders([]);
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    calls.push({ url, options });
    if (!url.includes("streamGenerateContent")) return Response.json({ name: "v1.3.4" });
    return response();
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  setCliCompatProviders(originalCompat);
  resetDbInstance();
});

test("existing Gemini High formatter retains the literal slug, High level and small requested cap", () => {
  const wire = body();
  assert.equal(wire.model, model);
  assert.equal(wire.request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(wire.request.generationConfig.maxOutputTokens, 16);
  assert.equal(wire.request.generationConfig.thinkingConfig.thinkingBudget, undefined);
  assert.equal(calls.length, 0);
});
test("bounded formatter omits borrowed client identity while retaining exact model, High and cap", async () => {
  const { attempt } = context();
  const wire = await withApplicationAttempt(attempt, () =>
    new AntigravityExecutor().transformRequest(model, body(), true, credentials)
  );
  assert.ok(!(wire instanceof Response));
  assert.equal(wire.model, model);
  assert.equal(wire.userAgent, undefined);
  assert.equal(wire.requestType, undefined);
  assert.equal(wire.requestId, undefined);
  assert.equal(wire.request.sessionId, undefined);
  assert.equal(wire.request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(wire.request.generationConfig.maxOutputTokens, 16);
  assert.equal(calls.length, 0);
});
test("ordinary formatter and headers retain their existing legacy client conventions", async () => {
  const executor = new AntigravityExecutor();
  const wire = await executor.transformRequest(model, body(), true, credentials);
  assert.ok(!(wire instanceof Response));
  assert.equal(wire.userAgent, "antigravity");
  assert.equal(wire.requestType, "agent");
  assert.equal(typeof wire.requestId, "string");
  assert.match(executor.buildHeaders(credentials)["User-Agent"], /^antigravity\/ide\//);
  assert.equal(calls.length, 0);
});
test("bounded PSD-only stored project uses the same exact guarded target", async () => {
  const { attempt, dispatch } = context();
  const creds = {
    ...credentials,
    projectId: undefined,
    providerSpecificData: { projectId: credentials.projectId },
  };
  const result = await withApplicationAttempt(attempt, () =>
    new AntigravityExecutor().execute({
      model,
      body: body(),
      stream: true,
      credentials: creds,
      signal: attempt.signal,
      validationDispatch: dispatch,
    })
  );
  assert.equal(result.response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(guarded, 1);
  assert.equal(observed, 1);
  await result.response.body?.cancel();
});
for (const code of [200, 401, 403, 404, 429, 503])
  test(`bounded ${code} response uses one guarded BaseExecutor send without ancillary calls`, async () => {
    status = code;
    const { attempt, dispatch } = context();
    const result = await withApplicationAttempt(attempt, () =>
      new AntigravityExecutor().execute({
        model,
        body: body(),
        stream: true,
        credentials,
        signal: attempt.signal,
        validationDispatch: dispatch,
      })
    );
    assert.equal(result.response.status, code);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, endpoint);
    assert.equal(guarded, 1);
    assert.equal(observed, 1);
    await result.response.body?.cancel();
  });
for (const change of [
  "project",
  "token",
  "expiry",
  "apikey",
  "metadata",
  "model",
  "effort",
  "account",
  "observer",
  "abort",
  "fingerprint",
  "marker",
  "nonstream",
  "project-conflict",
  "empty-project-fallback",
  "wire-project",
  "cap-overflow",
  "wire-level",
  "credits",
])
  test(`bounded unsupported ${change} rejects before every fetch`, async () => {
    const { attempt, dispatch, controller } = context();
    const creds = structuredClone(credentials) as typeof credentials & { apiKey?: string };
    const wire = body();
    let target = model;
    if (change === "project") creds.projectId = "";
    if (change === "token") creds.accessToken = "";
    if (change === "expiry") creds.expiresAt = new Date(Date.now() + 1000).toISOString();
    if (change === "apikey") creds.apiKey = "synthetic-api-key";
    if (change === "metadata")
      creds.providerSpecificData = { baseUrl: "https://synthetic.invalid" };
    if (change === "model") target = "claude-opus-4-6-thinking";
    if (change === "effort") attempt.effort = "medium";
    if (change === "account") creds.connectionId = "synthetic-other-account";
    if (change === "abort") controller.abort();
    if (change === "fingerprint") setCliCompatProviders(["antigravity"]);
    if (change === "marker") attempt.executionContract = undefined;
    if (change === "project-conflict")
      creds.providerSpecificData = { projectId: "synthetic-other-project" };
    if (change === "empty-project-fallback") {
      creds.projectId = "";
      creds.providerSpecificData = { projectId: credentials.projectId };
    }
    if (change === "wire-project") wire.project = "synthetic-other-project";
    if (change === "cap-overflow") wire.request.generationConfig.maxOutputTokens = 65537;
    if (change === "wire-level") wire.request.generationConfig.thinkingConfig.thinkingLevel = "low";
    if (change === "credits") wire.enabledCreditTypes = ["GOOGLE_ONE_AI"];
    await assert.rejects(
      withApplicationAttempt(attempt, () =>
        new AntigravityExecutor().execute({
          model: target,
          body: wire,
          stream: change !== "nonstream",
          credentials: creds,
          signal: attempt.signal,
          validationDispatch: change === "observer" ? undefined : dispatch,
        })
      )
    );
    assert.equal(calls.length, 0);
    assert.equal(guarded, 0);
    assert.equal(observed, 0);
  });
