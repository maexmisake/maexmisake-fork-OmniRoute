import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
const { createProviderConnection, updateProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const { getComboByName, updateCombo } = await import("../../src/lib/db/combos.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
const originalFetch = globalThis.fetch;
let baseUrl = "";
let observations: Array<{ model: string; effort: string }> = [];
let beforeReply: (() => Promise<void>) | undefined;
let truncateStream = false;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  observations.push({ model: body.model, effort: body.reasoning_effort });
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
        chunk({}, "stop", { prompt_tokens: 8, completion_tokens: 4, cost: 0.002 }) +
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
      usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.002 },
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
async function fixture() {
  observations = [];
  beforeReply = undefined;
  truncateStream = false;
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
test("ordinary sessions preserve the exact pair until an explicit task boundary clears stability", async () => {
  const f = await fixture();
  const first = await POST(f.request());
  const text = await first.text();
  assert.equal(first.status, 200, text);
  const session = first.headers.get("x-omniroute-routing-session");
  assert.match(session ?? "", /^[a-f0-9-]{36}$/);
  const coding = { messages: [{ role: "user", content: "Write a function that sorts numbers" }] };
  const second = await POST(f.request(session!, true, coding));
  await second.text();
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-omniroute-selection-mode"), "session-pin");
  const third = await POST(f.request(session!, true, coding));
  await third.text();
  assert.equal(third.status, 200);
  assert.deepEqual(observations, [
    { model: "gpt-5.4", effort: "medium" },
    { model: "gpt-5.4", effort: "medium" },
    { model: "gpt-5.4-mini", effort: "high" },
  ]);
});
test("explicit effort conflict rejects without dispatch and does not strand a known-unstarted session", async () => {
  const f = await fixture();
  const first = await POST(f.request());
  await first.text();
  assert.equal(first.status, 200);
  const session = first.headers.get("x-omniroute-routing-session")!;
  const conflict = await POST(f.request(session, false, { reasoning_effort: "high" }));
  await conflict.text();
  assert.equal(conflict.status, 409);
  assert.equal(observations.length, 1);
  const follow = await POST(f.request(session));
  await follow.text();
  assert.equal(follow.status, 200);
  assert.equal(observations.length, 2);
});
test("a routing session locator never authorizes a different authenticated key", async () => {
  const f = await fixture();
  const first = await POST(f.request());
  await first.text();
  assert.equal(first.status, 200);
  const other = await createApiKey("synthetic-other-session-key", "synthetic");
  const denied = await POST(
    f.request(first.headers.get("x-omniroute-routing-session")!, false, {}, other.key)
  );
  await denied.text();
  assert.equal(denied.status, 409);
  assert.equal(observations.length, 1);
});
test("an unavailable session pin is never silently replaced by another model", async () => {
  const f = await fixture();
  const first = await POST(f.request());
  await first.text();
  assert.equal(first.status, 200);
  await updateProviderConnection(f.connections.light, { isActive: false });
  const denied = await POST(f.request(first.headers.get("x-omniroute-routing-session")!));
  await denied.text();
  assert.equal(denied.status, 409);
  assert.equal(observations.length, 1);
  const fresh = await POST(f.request());
  await fresh.text();
  assert.equal(fresh.status, 200);
  assert.deepEqual(observations.at(-1), { model: "gpt-5.4-mini", effort: "high" });
});
test("a selected credential changed in flight cannot become the session's new account authority", async () => {
  const f = await fixture();
  beforeReply = async () => {
    await updateProviderConnection(f.connections.light, {
      apiKey: "synthetic-replacement-account",
    });
  };
  const response = await POST(f.request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(response.headers.has("x-omniroute-routing-session"), false);
  assert.equal(observations.length, 1);
  const row = getDbInstance()
    .prepare("SELECT state FROM decision_routing_sessions WHERE api_key_id=?")
    .get(f.key.id) as { state: string };
  assert.equal(row.state, "unknown");
});
test("a credential changed after session claim cannot be adopted by a later dispatch snapshot", async () => {
  const { claimRoutingSession, attachRoutingSession, releaseRoutingSession } =
    await import("../../src/lib/db/decisionSessions.ts");
  const f = await fixture(),
    first = await POST(f.request());
  await first.text();
  const combo = (await getComboByName(f.name))!;
  const limits = (
    combo.config as {
      decisionPolicy: {
        sessions: {
          idleTtlMs: number;
          maxTurns: number;
          minStableTurns: number;
          maxActiveSessions: number;
        };
      };
    }
  ).decisionPolicy.sessions;
  const policy = JSON.stringify((combo.config as { decisionPolicy: unknown }).decisionPolicy);
  const claim = claimRoutingSession({
    locator: first.headers.get("x-omniroute-routing-session")!,
    keyId: f.key.id,
    comboId: String(combo.id),
    policy,
    limits,
    timeoutMs: 3000,
  });
  await updateProviderConnection(f.connections.light, {
    apiKey: "synthetic-post-claim-account-change",
  });
  assert.throws(
    () =>
      attachRoutingSession(claim, {
        id: randomUUID(),
        keyId: f.key.id,
        comboId: String(combo.id),
        candidateId: "light",
        provider: "openai",
        model: "gpt-5.4",
        connectionId: f.connections.light,
        effort: "medium",
      }),
    /decision_session_rejected/
  );
  releaseRoutingSession(claim);
  assert.equal(observations.length, 1);
});
test("a live claim remains within the active-session limit even after its idle TTL", async () => {
  const f = await fixture();
  const combo = (await getComboByName(f.name))!;
  const config = structuredClone(combo.config) as {
    decisionPolicy: { sessions: { maxActiveSessions: number; idleTtlMs: number } };
  };
  config.decisionPolicy.sessions.maxActiveSessions = 1;
  config.decisionPolicy.sessions.idleTtlMs = 1000;
  await updateCombo(String(combo.id), { config });
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  beforeReply = async () => {
    entered();
    await wait;
  };
  const pending = POST(f.request());
  await seen;
  getDbInstance()
    .prepare("UPDATE decision_routing_sessions SET expires_at=? WHERE api_key_id=?")
    .run(Date.now() - 1, f.key.id);
  try {
    const denied = await POST(f.request());
    await denied.text();
    assert.equal(denied.status, 409);
    assert.equal(observations.length, 1);
  } finally {
    release();
  }
  const completed = await pending;
  await completed.text();
  assert.equal(completed.status, 200);
});
test("simultaneous use of one session is claimed exclusively and the completed owner can continue", async () => {
  const f = await fixture();
  const first = await POST(f.request());
  await first.text();
  const id = first.headers.get("x-omniroute-routing-session")!;
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  beforeReply = async () => {
    entered();
    await wait;
  };
  const pending = POST(f.request(id));
  await seen;
  try {
    const denied = await POST(f.request(id));
    await denied.text();
    assert.equal(denied.status, 409);
    assert.equal(observations.length, 2);
  } finally {
    release();
  }
  const completed = await pending;
  await completed.text();
  assert.equal(completed.status, 200);
  beforeReply = undefined;
  const next = await POST(f.request(id));
  await next.text();
  assert.equal(next.status, 200);
});
test("successful streaming commits the pin before its final completion is delivered", async () => {
  const f = await fixture();
  const response = await POST(
    f.request("new", false, { stream: true, stream_options: { include_usage: true } })
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /\[DONE\]/);
  const id = response.headers.get("x-omniroute-routing-session")!;
  const row = getDbInstance()
    .prepare("SELECT state,turns FROM decision_routing_sessions WHERE id=?")
    .get(id) as { state: string; turns: number };
  assert.equal(row.state, "idle");
  assert.equal(row.turns, 1);
  const next = await POST(f.request(id));
  await next.text();
  assert.equal(next.status, 200);
});
test("truncated provider streams never publish a reusable successful session", async () => {
  const f = await fixture();
  truncateStream = true;
  const response = await POST(f.request("new", false, { stream: true }));
  await assert.rejects(response.text());
  const row = getDbInstance()
    .prepare("SELECT state,turns FROM decision_routing_sessions WHERE api_key_id=?")
    .get(f.key.id) as { state: string; turns: number };
  assert.equal(row.state, "unknown");
  assert.equal(row.turns, 0);
});
test("session binding survives database reopen without retaining task text", async () => {
  const f = await fixture();
  const first = await POST(f.request());
  await first.text();
  const id = first.headers.get("x-omniroute-routing-session")!;
  resetDbInstance();
  const next = await POST(f.request(id));
  await next.text();
  assert.equal(next.status, 200);
  const row = getDbInstance()
    .prepare("SELECT binding_json FROM decision_routing_sessions WHERE id=?")
    .get(id) as { binding_json: string };
  assert.ok(!row.binding_json.includes("Explain a loop"));
});
test("expired sessions and malformed locators reject before provider dispatch", async () => {
  const f = await fixture();
  const first = await POST(f.request());
  await first.text();
  const id = first.headers.get("x-omniroute-routing-session")!;
  getDbInstance()
    .prepare("UPDATE decision_routing_sessions SET expires_at=? WHERE id=?")
    .run(Date.now() - 1, id);
  for (const locator of [id, "not-a-server-session", "new,new"]) {
    const response = await POST(f.request(locator));
    await response.text();
    assert.equal(response.status, 409);
  }
  assert.equal(observations.length, 1);
});
test("a complete raw response cannot certify a truncated or identity-changed client stream", async () => {
  const { createApplicationStream } =
    await import("../../src/lib/decisionPolicy/applicationStream.ts");
  const { reserveDecisionAttempt, startDecisionAttempt } =
    await import("../../src/lib/db/decisionAttempts.ts");
  for (const kind of ["missing-finish", "missing-done", "wrong-model"]) {
    const f = await fixture(),
      combo = (await getComboByName(f.name))!;
    const identity = {
      id: randomUUID(),
      keyId: f.key.id,
      comboId: String(combo.id),
      candidateId: "light",
      provider: "openai",
      model: "gpt-5.4",
      connectionId: f.connections.light,
      effort: "medium",
      requestedModel: f.name,
    };
    reserveDecisionAttempt(identity);
    startDecisionAttempt(identity);
    const stream = createApplicationStream(identity, new AbortController().signal);
    const frame = (model: string, finish: boolean) =>
      `data: ${JSON.stringify({
        id: "synthetic-client-proof",
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta: finish ? {} : { content: "Synthetic" },
            finish_reason: finish ? "stop" : null,
          },
        ],
        ...(finish ? { usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.002 } } : {}),
      })}\n\n`;
    const raw = frame(identity.model, false) + frame(identity.model, true) + "data: [DONE]\n\n";
    await stream
      .observe(new Response(raw, { headers: { "content-type": "text/event-stream" } }))
      .text();
    let committed = 0;
    stream.onClientCompletion(
      () => {
        committed++;
      },
      () => {}
    );
    const client =
      kind === "missing-finish"
        ? frame(identity.model, false) + "data: [DONE]\n\n"
        : kind === "missing-done"
          ? frame(identity.model, false) + frame(identity.model, true)
          : frame("wrong-synthetic-model", false) +
            frame("wrong-synthetic-model", true) +
            "data: [DONE]\n\n";
    const response = stream.wrap(
      new Response(client, { headers: { "content-type": "text/event-stream" } })
    );
    await assert.rejects(response.text());
    assert.equal(committed, 0, kind);
  }
});

test("a credential rotated during executor loading cannot dispatch the earlier snapshot", async () => {
  const f = await fixture();
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const { registerLazyExecutor } = await import("../../open-sse/executors/registry.ts");
  const { getCachedRawProviderConnections } = await import("../../src/lib/db/readCache.ts");
  const executor = await getExecutor("openai");
  await getCachedRawProviderConnections({ provider: "openai", isActive: true });
  let rotated = false;
  registerLazyExecutor("openai", async () => {
    // Model a second worker updating the shared file without invalidating this worker's cache.
    getDbInstance()
      .prepare("UPDATE provider_connections SET api_key=? WHERE id=?")
      .run("synthetic-other-worker-rotation", f.connections.light);
    rotated = true;
    return executor;
  });
  try {
    const response = await POST(f.request());
    await response.text();
    assert.equal(rotated, true);
    assert.equal(response.status, 409);
    assert.equal(observations.length, 0);
  } finally {
    registerLazyExecutor("openai", async () => executor);
  }
});
