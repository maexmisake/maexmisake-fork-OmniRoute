import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-responses-tests-only-key";
const { createProviderConnection, updateProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { createApiKey, updateApiKeyPermissions } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { getComboByName, updateCombo } = await import("../../src/lib/db/combos.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { POST } = await import("../../src/app/api/v1/responses/route.ts");
const originalFetch = globalThis.fetch;
let baseUrl = "";
let observations: Array<{ model: string; effort: string; messages: unknown }> = [];
let beforeReply: (() => Promise<void>) | undefined;
let truncateStream = false;
let unknownCost = false,
  lengthLimited = false;
let invalidCost = false;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  observations.push({ model: body.model, effort: body.reasoning_effort, messages: body.messages });
  await beforeReply?.();
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      `data: ${JSON.stringify({
        id: "synthetic-session-stream",
        object: "chat.completion.chunk",
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
    response.end(
      chunk({ role: "assistant", content: "Synthetic session stream" }, null) +
        chunk({}, lengthLimited ? "length" : "stop", {
          prompt_tokens: 8,
          completion_tokens: 4,
          ...(unknownCost ? {} : { cost: 0.002 }),
        }) +
        (truncateStream ? "" : "data: [DONE]\n\n")
    );
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: `synthetic-session-result-${observations.length}`,
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Synthetic session result" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        ...(unknownCost ? {} : { cost: invalidCost ? "unverified" : 0.002 }),
      },
    })
  );
});
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(new URL(url).hostname, "127.0.0.1");
    return proxyFetch(url, init);
  };
  await updateSettings({
    semanticCacheEnabled: false,
    memoryEnabled: false,
    compressionEnabled: false,
    streamDefaultMode: "json",
    globalFallbackModel: null,
  });
});
after(async () => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  resetDbInstance();
});
async function fixture(history = false) {
  observations = [];
  beforeReply = undefined;
  truncateStream = false;
  unknownCost = false;
  lengthLimited = false;
  invalidCost = false;
  resetAllCircuitBreakers();
  const key = await createApiKey("synthetic-session-client", "synthetic");
  const connections: Record<string, string> = {};
  for (const id of ["light", "deep"]) {
    const row = await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: `synthetic-session-${id}`,
      apiKey: `synthetic-session-${id}`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { baseUrl },
    });
    assert.ok(row);
    connections[id] = String(row.id);
  }
  const name = `synthetic-session-${key.id}`;
  await createCombo({
    name,
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        connections,
        ...(history
          ? {
              responses: {
                history: "encrypted-opt-in-v1",
                acknowledgeTranscriptStorage: true,
                ttlMs: 60000,
                maxStoredResponses: 8,
              },
            }
          : {}),
        sessions: {
          mode: "task-boundary",
          idleTtlMs: 60000,
          maxTurns: 20,
          minStableTurns: 2,
          maxActiveSessions: 4,
        },
        policy: {
          version: 1,
          candidates: ["light", "deep"].map((id, index) => ({
            id,
            provider: "openai",
            model: index ? "gpt-5.4-mini" : "gpt-5.4",
            endpointKind: "direct",
            evidence: "Synthetic session fixture, not quality evidence",
            capabilities: {
              text: true,
              images: false,
              tools: false,
              reasoning: true,
              contextTokens: 100000,
            },
            effort: {
              mode: "set",
              value: index ? "high" : "medium",
              supported: [index ? "high" : "medium"],
              evidence: "Synthetic effort contract",
            },
          })),
          taskOrder: { explanation: ["light", "deep"], complex_code: ["deep", "light"] },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: 0,
          maxExecutionAttempts: 1,
          timeoutMs: 3000,
        },
      },
    },
  });
  const request = (
    session = "new",
    boundary = false,
    body: Record<string, unknown> = {},
    token = key.key
  ) =>
    new Request("http://application.invalid/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-omniroute-routing-session": session,
        ...(boundary ? { "x-omniroute-task-boundary": "new-task" } : {}),
      },
      body: JSON.stringify({
        model: name,
        messages: [{ role: "user", content: "Explain a loop" }],
        max_completion_tokens: 64,
        stream: false,
        ...body,
      }),
    });
  return { key, connections, request, name };
}
test("Responses string input preserves explicit effort and output reservation through the application", async () => {
  const f = await fixture();
  const response = await POST(
    new Request("http://application.invalid/api/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${f.key.key}` },
      body: JSON.stringify({
        model: f.name,
        input: "Explain a loop",
        max_output_tokens: 64,
        reasoning: { effort: "medium" },
        stream: false,
        store: false,
      }),
    })
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.output[0].content[0].text, "Synthetic session result");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].effort, "medium");
  assert.deepEqual(observations[0].messages, [{ role: "user", content: "Explain a loop" }]);
  assert.equal(body.usage.input_tokens, 8);
  assert.equal(body.usage.output_tokens, 4);
  assert.equal(body.usage.cost, 0.002);
});

test("Responses text items and instructions preserve full message history", async () => {
  const f = await fixture();
  const response = await POST(
    new Request("http://application.invalid/api/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${f.key.key}` },
      body: JSON.stringify({
        model: f.name,
        instructions: "Explain clearly",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Earlier question" }] },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Earlier answer", annotations: [] }],
          },
          { role: "user", content: "Explain a loop" },
        ],
        max_output_tokens: 64,
        stream: false,
        store: false,
      }),
    })
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(observations[0].messages, [
    { role: "system", content: "Explain clearly" },
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Explain a loop" },
  ]);
});

test("Responses streaming publishes completed output only after actual completion proof", async () => {
  const f = await fixture();
  const send = () =>
    POST(
      new Request("http://application.invalid/api/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${f.key.key}` },
        body: JSON.stringify({
          model: f.name,
          input: "Explain a loop",
          max_output_tokens: 64,
          stream: true,
          store: false,
        }),
      })
    );
  const response = await send();
  assert.equal(response.status, 200, await response.clone().text());
  const frames = (await response.text())
    .split(/\n\n/)
    .filter((x) => x.includes("data: "))
    .map((frame) => JSON.parse(frame.split("data: ")[1]));
  assert.equal(frames[0].type, "response.created");
  assert.ok(
    frames.some(
      (frame) =>
        frame.type === "response.output_text.delta" && frame.delta === "Synthetic session stream"
    )
  );
  const final = frames.at(-1);
  assert.equal(final.type, "response.completed");
  assert.equal(final.response.output[0].content[0].text, "Synthetic session stream");
  assert.equal(final.response.usage.cost, 0.002);
  assert.match(final.response.id, /^resp_[a-f0-9-]+$/);
  truncateStream = true;
  const incomplete = await send();
  let text = "";
  try {
    text = await incomplete.text();
  } catch {
    /* Stream rejection is expected. */
  }
  assert.equal(text.includes('"type":"response.completed"'), false);
});

test("owned previous_response_id restores string deltas and retains the exact origin pair", async () => {
  const f = await fixture(true);
  const send = (body: Record<string, unknown>, key = f.key.key) =>
    POST(
      new Request("http://application.invalid/api/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: f.name,
          max_output_tokens: 64,
          stream: false,
          store: true,
          ...body,
        }),
      })
    );
  const first = await send({ input: "Explain a loop", instructions: "First turn instruction" });
  const origin = await first.json();
  assert.equal(first.status, 200, JSON.stringify(origin));
  assert.equal(origin.store, true);
  const continued = await send({
    previous_response_id: origin.id,
    input: "Refactor a database transaction safely",
  });
  const next = await continued.json();
  assert.equal(continued.status, 200, JSON.stringify(next));
  assert.notEqual(next.id, origin.id);
  assert.equal(continued.headers.get("x-omniroute-selection-mode"), "session-pin");
  assert.equal(observations.length, 2);
  assert.equal(observations[1].model, observations[0].model);
  assert.equal(observations[1].effort, "medium");
  assert.deepEqual(observations[1].messages, [
    { role: "user", content: "Explain a loop" },
    { role: "assistant", content: "Synthetic session result" },
    { role: "user", content: "Refactor a database transaction safely" },
  ]);
  const foreign = await createApiKey("synthetic-foreign-responses", "synthetic");
  const rejected = await send(
    { previous_response_id: origin.id, input: "Explain another loop" },
    foreign.key
  );
  await rejected.text();
  assert.equal(rejected.status, 409);
  assert.equal(observations.length, 2);
});

function responsesRequest(
  f: { name: string; key: { key: string } },
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return POST(
    new Request("http://application.invalid/api/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${f.key.key}`,
        ...headers,
      },
      body: JSON.stringify({
        model: f.name,
        input: "Explain a loop",
        max_output_tokens: 64,
        stream: false,
        store: true,
        ...body,
      }),
    })
  );
}
test("Responses retention is disabled by default and no-log clients reject before dispatch", async () => {
  const disabled = await fixture();
  const first = await responsesRequest(disabled);
  await first.text();
  assert.equal(first.status, 409);
  assert.equal(observations.length, 0);
  const f = await fixture(true);
  await updateApiKeyPermissions(f.key.id, { noLog: true });
  const denied = await responsesRequest(f);
  await denied.text();
  assert.equal(denied.status, 409);
  assert.equal(observations.length, 0);
});
test("Responses retention needs existing encryption and rechecks its availability at publication", async () => {
  const f = await fixture(true);
  delete process.env.STORAGE_ENCRYPTION_KEY;
  try {
    const response = await responsesRequest(f);
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(observations.length, 0);
  } finally {
    process.env.STORAGE_ENCRYPTION_KEY = "synthetic-responses-tests-only-key";
  }
  beforeReply = async () => {
    delete process.env.STORAGE_ENCRYPTION_KEY;
  };
  try {
    const response = await responsesRequest(f);
    await response.text();
    assert.equal(response.status, 409);
    assert.equal(observations.length, 1);
    assert.equal(
      (
        getDbInstance()
          .prepare(
            "SELECT COUNT(*) AS n FROM decision_response_histories WHERE api_key_id=? AND state='ready'"
          )
          .get(f.key.id) as { n: number }
      ).n,
      0
    );
  } finally {
    process.env.STORAGE_ENCRYPTION_KEY = "synthetic-responses-tests-only-key";
  }
});
test("Responses concurrent continuations serialize on the originating session", async () => {
  const f = await fixture(true),
    first = await responsesRequest(f),
    origin = await first.json();
  assert.equal(first.status, 200);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
  beforeReply = async () => {
    entered();
    await gate;
  };
  const pending = responsesRequest(f, {
    previous_response_id: origin.id,
    input: "Explain a second loop",
  });
  await arrived;
  try {
    const competing = await responsesRequest(f, {
      previous_response_id: origin.id,
      input: "Explain a competing loop",
    });
    await competing.text();
    assert.equal(competing.status, 409);
    assert.equal(observations.length, 2);
  } finally {
    release();
  }
  const completed = await pending;
  await completed.text();
  assert.equal(completed.status, 200);
  assert.equal(observations.length, 2);
});
test("Responses histories are encrypted and capacity is reserved before another physical request", async () => {
  const f = await fixture(true),
    combo = (await getComboByName(f.name))!;
  const config = structuredClone(combo.config) as {
    decisionPolicy: { responses: { maxStoredResponses: number } };
  };
  config.decisionPolicy.responses.maxStoredResponses = 1;
  await updateCombo(String(combo.id), { config });
  const response = await responsesRequest(f);
  const first = await response.json();
  assert.equal(response.status, 200, JSON.stringify(first));
  const row = getDbInstance()
    .prepare("SELECT state,history_ciphertext FROM decision_response_histories WHERE id=?")
    .get(first.id) as { state: string; history_ciphertext: string };
  assert.equal(row.state, "ready");
  assert.ok(row.history_ciphertext.startsWith("enc:v1:"));
  assert.equal(row.history_ciphertext.includes("Explain a loop"), false);
  const full = await responsesRequest(f, { previous_response_id: first.id });
  await full.text();
  assert.equal(full.status, 409);
  assert.equal(observations.length, 1);
});
test("Responses no-log changes in flight cannot publish transcript authority", async () => {
  const f = await fixture(true);
  beforeReply = async () => {
    await updateApiKeyPermissions(f.key.id, { noLog: true });
  };
  const response = await responsesRequest(f);
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(observations.length, 1);
  const rows = getDbInstance()
    .prepare("SELECT state,history_ciphertext FROM decision_response_histories WHERE api_key_id=?")
    .all(f.key.id) as Array<{ state: string; history_ciphertext: unknown }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "unknown");
  assert.equal(rows[0].history_ciphertext, null);
});
test("Responses continuation rejects credential changes and conflicting client session headers", async () => {
  const f = await fixture(true);
  const response = await responsesRequest(f);
  const origin = await response.json();
  assert.equal(response.status, 200);
  const conflictingHeaders: Array<Record<string, string>> = [
    { "x-omniroute-routing-session": "new" },
    {
      "x-omniroute-routing-session": response.headers.get("x-omniroute-routing-session")!,
      "x-omniroute-task-boundary": "new-task",
    },
  ];
  for (const headers of conflictingHeaders) {
    const conflict = await responsesRequest(f, { previous_response_id: origin.id }, headers);
    await conflict.text();
    assert.equal(conflict.status, 409);
    assert.equal(observations.length, 1);
  }
  await updateProviderConnection(f.connections.light, { apiKey: "synthetic-rotated-responses" });
  const changed = await responsesRequest(f, { previous_response_id: origin.id });
  await changed.text();
  assert.equal(changed.status, 409);
  assert.equal(observations.length, 1);
});
test("Responses store false resumes but never persists its new turn; explicit old-ID branching is a new request", async () => {
  const f = await fixture(true);
  const first = await responsesRequest(f);
  const origin = await first.json();
  assert.equal(first.status, 200);
  const continued = await responsesRequest(f, {
    previous_response_id: origin.id,
    store: false,
    input: "Explain a second loop",
  });
  const child = await continued.json();
  assert.equal(continued.status, 200);
  assert.equal(child.store, false);
  assert.equal(
    getDbInstance().prepare("SELECT id FROM decision_response_histories WHERE id=?").get(child.id),
    undefined
  );
  const missing = await responsesRequest(f, { previous_response_id: child.id });
  await missing.text();
  assert.equal(missing.status, 409);
  assert.equal(observations.length, 2);
  const branch = await responsesRequest(f, {
    previous_response_id: origin.id,
    input: "Explain a third loop",
  });
  await branch.text();
  assert.equal(branch.status, 200);
  assert.equal(observations.length, 3);
});
test("Responses assembled history bounds reject before execution rather than dropping the prefix", async () => {
  const f = await fixture(true);
  const first = await responsesRequest(f);
  const origin = await first.json();
  assert.equal(first.status, 200);
  const large = await responsesRequest(f, {
    previous_response_id: origin.id,
    input: "x".repeat(262144),
  });
  await large.text();
  assert.equal(large.status, 409);
  assert.equal(observations.length, 1);
});
test("Responses storage reserves the assistant message slot before dispatch", async () => {
  const f = await fixture(true);
  const response = await responsesRequest(f, {
    input: Array.from({ length: 128 }, () => ({ role: "user", content: "Synthetic message" })),
  });
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(observations.length, 0);
});
test("Responses streaming history publishes the emitted opaque ID and incomplete output stays unusable", async () => {
  const f = await fixture(true);
  const initial = await responsesRequest(f, { stream: true });
  const frames = (await initial.text())
    .split(/\n\n/)
    .filter((frame) => frame.includes("data: "))
    .map((frame) => JSON.parse(frame.split("data: ")[1]));
  const origin = frames.at(-1).response;
  assert.equal(frames.at(-1).type, "response.completed");
  const resumed = await responsesRequest(f, {
    previous_response_id: origin.id,
    input: "Explain another loop",
  });
  await resumed.text();
  assert.equal(resumed.status, 200);
  assert.deepEqual(observations[1].messages, [
    { role: "user", content: "Explain a loop" },
    { role: "assistant", content: "Synthetic session stream" },
    { role: "user", content: "Explain another loop" },
  ]);
  const g = await fixture(true);
  lengthLimited = true;
  const limited = await responsesRequest(g, { stream: true });
  const events = (await limited.text())
    .split(/\n\n/)
    .filter((frame) => frame.includes("data: "))
    .map((frame) => JSON.parse(frame.split("data: ")[1]));
  assert.equal(events.at(-1).type, "response.incomplete");
  const rejected = await responsesRequest(g, { previous_response_id: events.at(-1).response.id });
  await rejected.text();
  assert.equal(rejected.status, 409);
  assert.equal(observations.length, 1);
});
test("Responses unknown usage costs remain null for JSON and streaming", async () => {
  const f = await fixture();
  unknownCost = true;
  const json = await responsesRequest(f, { store: false });
  const body = await json.json();
  assert.equal(json.status, 200);
  assert.equal(body.usage.cost, null);
  const stream = await responsesRequest(f, { store: false, stream: true });
  const frames = (await stream.text())
    .split(/\n\n/)
    .filter((frame) => frame.includes("data: "))
    .map((frame) => JSON.parse(frame.split("data: ")[1]));
  assert.equal(frames.at(-1).response.usage.cost, null);
});

test("Responses JSON usage projects settled counts and never repeats an invalid upstream cost", async () => {
  const f = await fixture();
  invalidCost = true;
  const response = await responsesRequest(f, { store: false });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.usage.cost, null);
  assert.equal(body.usage.total_tokens, 12);
});
for (const store of [false, true])
  test(`Responses owned admission revalidates cached source expiry with store=${store}`, async () => {
    const f = await fixture(true),
      first = await responsesRequest(f),
      origin = await first.json();
    assert.equal(first.status, 200);
    const combo = (await getComboByName(f.name))!;
    const config = (
      combo.config as {
        decisionPolicy: import("../../src/shared/decisionPolicy/configuration.ts").DecisionPolicyEditorValue;
      }
    ).decisionPolicy;
    const policy = JSON.stringify(config);
    const { prepareResponsesRouting, reserveApplicationResponse } =
      await import("../../src/lib/decisionPolicy/applicationResponsesRouting.ts");
    const { claimRoutingSession, releaseRoutingSession } =
      await import("../../src/lib/db/decisionSessions.ts");
    const body = {
      model: f.name,
      input: "Explain another loop",
      max_output_tokens: 64,
      stream: false,
      store,
      previous_response_id: origin.id,
    };
    const prepared = prepareResponsesRouting({
      client: body,
      working: body,
      keyId: f.key.id,
      comboId: String(combo.id),
      policy,
      config,
      echo: false,
    });
    getDbInstance()
      .prepare("UPDATE decision_response_histories SET expires_at=0 WHERE id=?")
      .run(origin.id);
    const claim = claimRoutingSession({
      locator: prepared.sessionInput!.locator,
      keyId: f.key.id,
      comboId: String(combo.id),
      policy,
      limits: config.sessions!,
      timeoutMs: 3000,
    });
    try {
      assert.throws(
        () => reserveApplicationResponse(prepared.state, claim, policy, config.responses, 3000),
        /decision_responses_history_rejected/
      );
    } finally {
      releaseRoutingSession(claim);
    }
    assert.equal(observations.length, 1);
  });
