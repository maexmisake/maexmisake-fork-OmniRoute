import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { runStreamingResponse } from "../../open-sse/handlers/chatCore/streamingResponse.ts";
import {
  withApplicationAttempt,
  type ApplicationAttempt,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

after(() => resetDbInstance());
for (const status of [401, 403, 429])
  test(`bounded streaming error ${status} returns before legacy refresh/recovery callbacks`, async () => {
    let physicalAttempts = 0,
      executorRefresh = 0,
      callbackRefresh = 0,
      ordinarySideEffects = 0;
    const legacy = () => {
      ordinarySideEffects++;
    };
    const deps = {
      provider: "claude",
      model: "claude-sonnet-5-5",
      currentModel: "claude-sonnet-5-5",
      effectiveModel: "claude-sonnet-5-5",
      sourceFormat: "openai",
      targetFormat: "claude",
      stream: true,
      upstreamStream: true,
      body: { messages: [{ role: "user", content: "Synthetic component request" }] },
      translatedBody: { model: "claude-sonnet-5-5", messages: [] },
      triedModels: new Set<string>(),
      credentials: {},
      connectionId: "synthetic-component-connection",
      getCurrentConnectionId: () => "synthetic-component-connection",
      assertManagedLeaseFence: () => {},
      syncExecuteTranslatedBody: () => {},
      handleCredentialsRefreshed: legacy,
      executor: {
        refreshCredentials: async () => {
          executorRefresh++;
          return null;
        },
      },
      executeRefreshCredentials: async () => {
        callbackRefresh++;
        return null;
      },
      applyProviderFailureClassification: legacy,
      persistAttemptLogs: legacy,
      persistFailureUsage: legacy,
      reportSignatureFailure: legacy,
      providerRequestCapture: { latest: () => undefined },
      executeProviderRequest: async () => {
        physicalAttempts++;
        return {
          response: Response.json(
            { error: { message: "Synthetic terminal error", type: "synthetic_error" } },
            { status, headers: status === 429 ? { "retry-after": "17" } : {} }
          ),
          url: "http://synthetic.invalid",
          headers: {},
          transformedBody: { model: "claude-sonnet-5-5" },
        };
      },
    };
    // A component context cannot reserve/authorize a real provider dispatch.
    // These counters cover callback entry that the real handler's strict fence blocks independently.
    const outcome = await withApplicationAttempt({} as ApplicationAttempt, () =>
      runStreamingResponse(deps)
    );
    assert.equal(outcome.response.status, status);
    assert.equal(outcome.response.response.status, status);
    assert.match(outcome.response.response.headers.get("content-type") ?? "", /application\/json/);
    if (status === 429) assert.equal(outcome.response.response.headers.get("retry-after"), "17");
    const body = await outcome.response.response.json();
    assert.equal(typeof body.error.message, "string");
    assert.equal(physicalAttempts, 1);
    assert.equal(executorRefresh, 0);
    assert.equal(callbackRefresh, 0);
    assert.equal(ordinarySideEffects, 0);
  });
