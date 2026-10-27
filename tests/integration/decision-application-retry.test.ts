import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

process.env.REQUIRE_API_KEY = "true";
process.env.APP_LOG_TO_FILE = "false";
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
const { createCombo } = await import("../../src/lib/db/combos.ts");
const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { readDecisionAttempts } = await import("../../src/lib/db/decisionAttempts.ts");
const { proxyFetch } = await import("../../open-sse/utils/proxyFetch.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
const originalFetch = globalThis.fetch;
let baseUrl = "";
let hits: string[] = [];
let failure = { status: 429, code: "insufficient_quota", scope: "account" };
let retryAfter: string | null = null;
let mode: "json" | "reset" = "json";
let beforePrimaryReply: (() => Promise<void>) | undefined;
let decisions = 0;
let failureUsage: Record<string, unknown> | undefined;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  hits.push(body.model);
  assert.ok(
    ["Bearer synthetic-retry-primary", "Bearer synthetic-retry-backup"].includes(
      String(request.headers.authorization)
    )
  );
  if (request.headers.authorization === "Bearer synthetic-retry-primary") {
    if (mode === "reset") {
      request.socket.destroy();
      return;
    }
    await beforePrimaryReply?.();
    response.writeHead(failure.status, {
      "content-type": "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    });
    response.end(
      JSON.stringify({
        error: { code: failure.code, scope: failure.scope },
        ...(failureUsage ? { usage: failureUsage } : {}),
      })
    );
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "synthetic-retry-result",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Synthetic result" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.002 },
      })
    );
  }
});
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://api.typesafe.ai/v1/systemone") {
      decisions++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "jev-1.14.0");
      const ids = Object.keys(body.questions.route.criteria);
      assert.deepEqual(ids, ["primary", "backup"]);
      return Response.json({
        model: body.model,
        answers: {
          route: {
            type: "choice",
            choice: "primary",
            confidence: 1,
            probabilities: { primary: 1, backup: 0 },
          },
        },
      });
    }
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
async function fixture(enabled = true, native = false, samePair = false, sessions = false) {
  resetAllCircuitBreakers();
  hits = [];
  failure = { status: 429, code: "insufficient_quota", scope: "account" };
  retryAfter = null;
  mode = "json";
  beforePrimaryReply = undefined;
  decisions = 0;
  failureUsage = undefined;
  const key = await createApiKey("synthetic-retry-client", "synthetic");
  const connections: Record<string, string> = {};
  for (const id of ["primary", "backup"]) {
    const connection = await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: `synthetic-retry-${id}`,
      apiKey: `synthetic-retry-${id}`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { baseUrl },
    });
    assert.ok(connection);
    connections[id] = String(connection.id);
  }
  const name = `synthetic-retry-${key.id}`;
  const selector = native
    ? await createProviderConnection({
        provider: "typesafe",
        authType: "apikey",
        name: "synthetic-retry-selector",
        apiKey: "synthetic-retry-selector",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      })
    : null;
  if (native) assert.ok(selector);
  await createCombo({
    name,
    models: ["openai/gpt-5.4"],
    strategy: "priority",
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        ...(sessions
          ? {
              sessions: {
                mode: "task-boundary",
                idleTtlMs: 60000,
                maxTurns: 8,
                minStableTurns: 2,
                maxActiveSessions: 4,
              },
            }
          : {}),
        ...(selector
          ? {
              selection: {
                mode: "native",
                provider: "typesafe",
                model: "jev-1.14.0",
                connectionId: String(selector.id),
                timeoutMs: 2000,
                maxCandidates: 2,
              },
            }
          : {}),
        connections,
        ...(enabled
          ? {
              retry: {
                transitions: [{ from: "primary", to: "backup", scopes: ["account-quota"] }],
              },
            }
          : {}),
        policy: {
          version: 1,
          candidates: ["primary", "backup"].map((id, index) => ({
            id,
            provider: "openai",
            model: index && !samePair ? "gpt-5.4-mini" : "gpt-5.4",
            endpointKind: "direct",
            evidence: "Synthetic fixture, not quality evidence",
            capabilities: {
              text: true,
              images: false,
              tools: false,
              reasoning: true,
              contextTokens: 100000,
            },
            effort: {
              mode: "set",
              value: "medium",
              supported: ["medium"],
              evidence: "Synthetic wire contract",
            },
          })),
          taskOrder: { explanation: ["primary", "backup"] },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: native ? 1 : 0,
          maxExecutionAttempts: enabled ? 2 : 1,
          timeoutMs: 3000,
        },
      },
    },
  });
  const request = (signal?: AbortSignal, headers: Record<string, string> = {}) =>
    new Request("http://application.invalid/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.key}`,
        ...headers,
      },
      body: JSON.stringify({
        model: name,
        messages: [{ role: "user", content: "Explain a loop" }],
        max_completion_tokens: 32,
        stream: false,
      }),
    });
  return { key, request, connections };
}
test("configured account-quota rejection reaches exact eligible backup with separate unknown charge", async () => {
  const f = await fixture();
  const response = await POST(f.request());
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(hits, ["gpt-5.4", "gpt-5.4-mini"]);
  const rows = readDecisionAttempts(f.key.id);
  assert.equal(rows.length, 2);
  const primary = rows.find((row) => row.candidate_id === "primary")!;
  const backup = rows.find((row) => row.candidate_id === "backup")!;
  assert.equal(primary.http_status, 429);
  assert.equal(primary.cost_usd, null);
  assert.equal(backup.parent_attempt_id, primary.id);
  assert.equal(backup.request_id, primary.request_id);
  assert.equal(backup.http_status, 200);
  assert.equal(
    rows.reduce((n, row) => n + Number(row.logical_counted), 0),
    1
  );
  assert.equal(response.headers.get("x-omniroute-routing-cost-status"), "unknown");
  assert.equal(response.headers.get("x-omniroute-decision-candidate"), "backup");
});

for (const field of ["completion_tokens_details", "output_tokens_details"]) {
  test(`nested ${field} generation prevents actual backup and retains first unknown charge`, async () => {
    const f = await fixture();
    failureUsage = { completion_tokens: 0, [field]: { reasoning_tokens: 7 } };
    const response = await POST(f.request());
    await response.text();
    assert.equal(response.status, 429);
    assert.deepEqual(hits, ["gpt-5.4"]);
    const rows = readDecisionAttempts(f.key.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].candidate_id, "primary");
    assert.equal(rows[0].reasoning_tokens, 7);
    assert.equal(rows[0].cost_usd, null);
    assert.equal(rows[0].http_status, 429);
  });
}

test("new owned session pins the completed retry backup and resumes without reselection", async () => {
  const f = await fixture(true, true, false, true);
  const first = await POST(f.request(undefined, { "x-omniroute-routing-session": "new" }));
  assert.equal(first.status, 200, await first.text());
  const id = first.headers.get("x-omniroute-routing-session");
  assert.match(id ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(first.headers.get("x-omniroute-decision-candidate"), "backup");
  assert.equal(decisions, 1);
  assert.deepEqual(hits, ["gpt-5.4", "gpt-5.4-mini"]);
  const resumed = await POST(f.request(undefined, { "x-omniroute-routing-session": id! }));
  assert.equal(resumed.status, 200, await resumed.text());
  assert.equal(resumed.headers.get("x-omniroute-routing-session"), id);
  assert.equal(resumed.headers.get("x-omniroute-decision-candidate"), "backup");
  assert.equal(decisions, 1);
  assert.deepEqual(hits, ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-mini"]);
  const execution = readDecisionAttempts(f.key.id).filter((row) => row.lane === "execution");
  assert.equal(execution.length, 3);
  assert.equal(execution[0].cost_usd, null);
  assert.equal(execution[1].connection_id, f.connections.backup);
  assert.equal(execution[2].connection_id, f.connections.backup);
});
test("one native Choice can hand over through two configured executions without another decision", async () => {
  const f = await fixture(true, true);
  const response = await POST(f.request());
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    JSON.stringify({
      text,
      reason: response.headers.get("x-omniroute-decision-reason"),
      hits,
      decisions,
    })
  );
  assert.equal(decisions, 1);
  assert.deepEqual(hits, ["gpt-5.4", "gpt-5.4-mini"]);
  const rows = readDecisionAttempts(f.key.id);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.lane === "decision").length, 1);
  assert.equal(new Set(rows.map((row) => row.request_id)).size, 1);
  assert.equal(
    rows.reduce((n, row) => n + Number(row.logical_counted), 0),
    1
  );
  assert.equal(response.headers.get("x-omniroute-selection-mode"), "native");
  assert.equal(response.headers.get("x-omniroute-decision-candidate"), "backup");
  assert.equal(response.headers.get("x-omniroute-routing-cost-status"), "unknown");
});
test("default lane does not retry a completed quota rejection", async () => {
  const f = await fixture(false);
  const response = await POST(f.request());
  await response.text();
  assert.equal(response.status, 429, response.headers.get("x-omniroute-decision-reason") ?? "");
  assert.deepEqual(hits, ["gpt-5.4"]);
  assert.equal(readDecisionAttempts(f.key.id).length, 1);
});
test("account-quota permission never rotates accounts for a provider-global error", async () => {
  const f = await fixture();
  failure.scope = "provider";
  const response = await POST(f.request());
  await response.text();
  assert.equal(response.status, 429, response.headers.get("x-omniroute-decision-reason") ?? "");
  assert.deepEqual(hits, ["gpt-5.4"]);
});
test("upstream Retry-After beyond remaining deadline cannot dispatch a backup", async () => {
  const f = await fixture();
  retryAfter = "60";
  const response = await POST(f.request());
  await response.text();
  assert.equal(response.status, 429, response.headers.get("x-omniroute-decision-reason") ?? "");
  assert.deepEqual(hits, ["gpt-5.4"]);
});
test("a socket reset after the physical send stays unknown and never replays", async () => {
  const f = await fixture();
  mode = "reset";
  const response = await POST(f.request());
  await response.text();
  assert.ok(response.status >= 400);
  assert.deepEqual(hits, ["gpt-5.4"]);
  const rows = readDecisionAttempts(f.key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "unknown");
  assert.equal(rows[0].cost_usd, null);
});
test("a backup disabled after primary rejection is not dispatched", async () => {
  const f = await fixture();
  beforePrimaryReply = () =>
    updateProviderConnection(f.connections.backup, { isActive: false }).then(() => {});
  const response = await POST(f.request());
  await response.text();
  assert.equal(response.status, 429);
  assert.deepEqual(hits, ["gpt-5.4"]);
  assert.equal(readDecisionAttempts(f.key.id).length, 1);
});
test("caller cancellation interrupts Retry-After wait without dispatching a backup", async () => {
  const f = await fixture();
  retryAfter = "1";
  const controller = new AbortController();
  const pending = POST(f.request(controller.signal));
  for (let n = 0; n < 50 && readDecisionAttempts(f.key.id)[0]?.http_status !== 429; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    readDecisionAttempts(f.key.id)[0]?.http_status,
    429,
    "rejection settled before cancellation"
  );
  controller.abort();
  const response = await pending;
  await response.text();
  assert.equal(response.status, 499);
  assert.deepEqual(hits, ["gpt-5.4"]);
  assert.equal(readDecisionAttempts(f.key.id).length, 1);
});
test("explicit operator account failover preserves the same model and explicit effort", async () => {
  const f = await fixture(true, false, true);
  const original = f.request();
  const body = await original.json();
  const response = await POST(
    new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body: JSON.stringify({ ...body, reasoning_effort: "medium" }),
    })
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(hits, ["gpt-5.4", "gpt-5.4"]);
  const rows = readDecisionAttempts(f.key.id);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.connection_id)).size, 2);
  assert.deepEqual(
    rows.map((row) => row.effort),
    ["medium", "medium"]
  );
});
test("native retry health acknowledgement cannot hide a credential change", async () => {
  const f = await fixture(true, true);
  beforePrimaryReply = () =>
    updateProviderConnection(f.connections.primary, {
      apiKey: "synthetic-replaced-credential-never-used",
    }).then(() => {});
  const response = await POST(f.request());
  await response.text();
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-omniroute-decision-reason"), "decision_authority_changed");
  assert.deepEqual(hits, ["gpt-5.4"]);
  assert.equal(decisions, 1);
  assert.equal(readDecisionAttempts(f.key.id).length, 2);
});
