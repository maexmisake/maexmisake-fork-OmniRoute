#!/usr/bin/env node
// Black-box System One smoke test against a running OmniRoute instance (the CI image).
//
// It configures the instance over its own HTTP management API with SYNTHETIC
// credentials, then exercises the real auth, routing, catalog and rejection paths of
// POST /v1/systemone and GET /v1/systemone/models. The upstream is the local mock in
// systemone-mock-upstream.mjs; `readMockCalls` returns that mock's call log so each
// step can prove which upstream calls it did (or did not) cause.
//
// Evidence is sanitized by construction: it records step names, HTTP statuses, short
// fixed-vocabulary details and the mock's call log (no bodies, headers or keys).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PAID_MODEL = "opencode-zen/jev-1.13";
const FREE_MODEL = "opencode-zen/jev-1.13-free";

function noulRequest(model, state) {
  return {
    model,
    state,
    questions: {
      urgent: { type: "noul", instructions: "Is this urgent?" },
      route: { type: "choice", criteria: { billing: "money", tech: "software" } },
      severity: { type: "score", instructions: "Classify severity", criteria: ["low", "medium", "high"] },
    },
  };
}

/**
 * @param {{
 *   baseUrl: string,
 *   adminPassword: string,
 *   paidKey: string,
 *   freeKey: string,
 *   stateMarker: string,
 *   readMockCalls: () => Promise<object[]> | object[],
 *   settleMs?: number,
 * }} options
 */
export async function runSmoke(options) {
  const { baseUrl, adminPassword, paidKey, freeKey, stateMarker, readMockCalls } = options;
  const settleMs = options.settleMs ?? 30_000;
  const steps = [];
  const secrets = [adminPassword, paidKey, freeKey, stateMarker].filter(Boolean);
  let cookie = "";
  let csrf = "";

  const record = (name, ok, detail = "") => {
    steps.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
    return Boolean(ok);
  };

  async function http(method, route, { body, headers = {} } = {}) {
    const response = await fetch(new URL(route, baseUrl), {
      method,
      redirect: "manual",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, text, json: parsed, headers: response.headers };
  }

  const admin = (method, route, body) =>
    http(method, route, {
      body,
      headers: { cookie, ...(csrf ? { "x-omniroute-csrf": csrf } : {}) },
    });
  const client = (method, route, key, body) =>
    http(method, route, { body, headers: key ? { authorization: `Bearer ${key}` } : {} });

  const leaks = (res) => secrets.filter((secret) => secret && res.text.includes(secret)).length;
  // Auto-test and model-sync probes fire after a connection is created; wait for the
  // mock's call log to stop growing so they cannot leak into a later step's call count.
  const quiesce = async () => {
    let previous = -1;
    let stable = 0;
    const deadline = Date.now() + 15_000;
    while (stable < 2 && Date.now() < deadline) {
      const count = await callCount();
      stable = count === previous ? stable + 1 : 0;
      previous = count;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  const callsSince = async (mark) => (await readMockCalls()).slice(mark);
  const callCount = async () => (await readMockCalls()).length;

  // ── health ────────────────────────────────────────────────────────────────
  const health = await http("GET", "/healthz");
  record("healthz answers 200", health.status === 200, `status ${health.status}`);

  // ── management session ────────────────────────────────────────────────────
  const wrong = await http("POST", "/api/auth/login", { body: { password: `${adminPassword}-x` } });
  record("a wrong dashboard password is rejected", wrong.status === 401, `status ${wrong.status}`);

  const login = await http("POST", "/api/auth/login", { body: { password: adminPassword } });
  const setCookie = login.headers.getSetCookie?.() ?? [];
  const session = setCookie
    .map((value) => value.split(";")[0])
    .find((v) => v.startsWith("auth_token="));
  cookie = session ?? "";
  if (
    !record(
      "dashboard login issues a session cookie",
      login.status === 200 && cookie,
      `status ${login.status}`
    )
  ) {
    return finish(steps);
  }
  const csrfRes = await admin("GET", "/api/auth/csrf");
  csrf = typeof csrfRes.json?.token === "string" ? csrfRes.json.token : "";

  // ── API keys ──────────────────────────────────────────────────────────────
  const allKey = await admin("POST", "/api/keys", { name: "ci-systemone" });
  const chatOnly = await admin("POST", "/api/keys", { name: "ci-chat-only" });
  const apiKey = allKey.json?.key;
  const chatKey = chatOnly.json?.key;
  secrets.push(apiKey, chatKey);
  if (
    !record(
      "two client API keys were created",
      allKey.status === 201 && chatOnly.status === 201,
      `statuses ${allKey.status}/${chatOnly.status}`
    )
  ) {
    return finish(steps);
  }
  const restrict = await admin("PATCH", `/api/keys/${chatOnly.json.id}`, {
    allowedEndpoints: ["chat"],
  });
  record(
    "a key can be restricted to the chat category",
    restrict.status === 200,
    `status ${restrict.status}`
  );

  // ── connections ───────────────────────────────────────────────────────────
  async function addConnection(name, key, extra = {}) {
    const created = await admin("POST", "/api/providers", {
      provider: "opencode-zen",
      name,
      apiKey: key,
      ...extra,
    });
    const id = created.json?.connection?.id;
    if (
      !record(
        `connection ${name} was created`,
        created.status === 201 && id,
        `status ${created.status}`
      )
    ) {
      return null;
    }
    const deadline = Date.now() + settleMs;
    let settled = false;
    while (Date.now() < deadline && !settled) {
      const list = await admin("GET", "/api/providers");
      const row = (list.json?.connections ?? []).find((c) => c.id === id);
      settled = !row || (row.testStatus && row.testStatus !== "unknown");
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const activate = await admin("PATCH", "/api/providers", { ids: [id], isActive: true });
    await quiesce();
    record(`connection ${name} is active`, activate.status === 200, `status ${activate.status}`);
    return id;
  }

  const paidId = await addConnection("ci-zen-paid", paidKey);
  if (!paidId) return finish(steps);

  // ── authentication and policy gates ───────────────────────────────────────
  let mark = await callCount();
  const body = noulRequest(PAID_MODEL, `${stateMarker} the customer cannot log in`);

  let res = await client("POST", "/v1/systemone", null, body);
  record("POST /v1/systemone without a key is 401", res.status === 401, `status ${res.status}`);
  res = await client("POST", "/v1/systemone", `${apiKey}-bad`, body);
  record(
    "POST /v1/systemone with an unknown key is 401",
    res.status === 401,
    `status ${res.status}`
  );
  res = await client("GET", "/v1/systemone/models", null);
  record(
    "GET /v1/systemone/models without a key is 401",
    res.status === 401,
    `status ${res.status}`
  );
  res = await client("POST", "/v1/systemone", chatKey, body);
  record(
    "a chat-only key is refused on POST /v1/systemone",
    res.status === 403,
    `status ${res.status}`
  );
  res = await client("GET", "/v1/systemone/models", chatKey);
  record(
    "a chat-only key is refused on GET /v1/systemone/models",
    res.status === 403,
    `status ${res.status}`
  );
  record("no rejected request reached the upstream", (await callsSince(mark)).length === 0);

  // ── request validation ────────────────────────────────────────────────────
  res = await client("POST", "/v1/systemone", apiKey, { model: PAID_MODEL, state: stateMarker });
  record("an envelope without questions is 400", res.status === 400, `status ${res.status}`);
  record("the 400 does not echo the request state", leaks(res) === 0);

  // ── a real decision, pinned and by alias ──────────────────────────────────
  mark = await callCount();
  res = await client("POST", "/v1/systemone", apiKey, body);
  record("a pinned decision request is 200", res.status === 200, `status ${res.status}`);
  const answers = res.json?.answers ?? {};
  record(
    "all three typed answers come back intact",
    answers.urgent?.type === "noul" &&
      answers.urgent?.noul === 0.87 &&
      answers.route?.type === "choice" &&
      answers.route?.choice === "billing" &&
      answers.severity?.type === "score" &&
      answers.severity?.score === 2
  );
  record(
    "the response carries a known cost status",
    res.headers.get("x-omniroute-cost-status") === "known"
  );
  record("the response leaks no credential", leaks(res) === 0);
  let calls = await callsSince(mark);
  record(
    "the upstream saw one call with the paid key, the upstream model id and the state",
    calls.length === 1 &&
      calls[0].path === "/inference/v1/systemone" &&
      calls[0].keyKind === "paid" &&
      calls[0].model === "jev-1.13" &&
      calls[0].stateSeen === true &&
      calls[0].status === 200,
    `calls ${calls.length}`
  );

  mark = await callCount();
  res = await client("POST", "/v1/systemone", apiKey, noulRequest("jev", stateMarker));
  calls = await callsSince(mark);
  record(
    "a bare alias is 200 and resolves to the paid Zen model",
    res.status === 200 &&
      calls.length === 1 &&
      calls[0].model === "jev-1.13" &&
      calls[0].keyKind === "paid",
    `status ${res.status}`
  );

  mark = await callCount();
  res = await client("POST", "/v1/systemone", apiKey, noulRequest("jev-free", stateMarker));
  record(
    "the free alias fails closed (403) with only a paid connection",
    res.status === 403,
    `status ${res.status}`
  );
  record("the free alias never reached the upstream", (await callsSince(mark)).length === 0);

  // ── upstream failures ─────────────────────────────────────────────────────
  mark = await callCount();
  res = await client(
    "POST",
    "/v1/systemone",
    apiKey,
    noulRequest("opencode-zen/jev-reject", stateMarker)
  );
  calls = await callsSince(mark);
  record("an upstream 422 is passed through as 422", res.status === 422, `status ${res.status}`);
  record("the 422 does not echo the state or any key", leaks(res) === 0);
  record("a caller-fault status is not retried", calls.length === 1, `calls ${calls.length}`);

  mark = await callCount();
  res = await client(
    "POST",
    "/v1/systemone",
    apiKey,
    noulRequest("opencode-zen/jev-contract-violation", stateMarker)
  );
  calls = await callsSince(mark);
  record(
    "an answer-less upstream success is a 502 contract violation",
    res.status === 502,
    `status ${res.status}`
  );
  record("the 502 does not echo the state or any key", leaks(res) === 0);
  record("a contract violation is not retried", calls.length === 1, `calls ${calls.length}`);

  // ── catalog ───────────────────────────────────────────────────────────────
  mark = await callCount();
  res = await client("GET", "/v1/systemone/models", apiKey);
  let ids = Array.isArray(res.json?.data) ? res.json.data.map((m) => m.id) : [];
  record("the decision catalog is 200", res.status === 200, `status ${res.status}`);
  record(
    "the catalog lists the paid decision model",
    ids.includes(PAID_MODEL),
    `models ${ids.length}`
  );
  record(
    "the catalog hides chat models and the unservable free model",
    !ids.includes("opencode-zen/big-pickle") &&
      !ids.includes("opencode-zen/qwen3-coder") &&
      !ids.includes(FREE_MODEL)
  );
  calls = await callsSince(mark);
  record(
    "the catalog read hit the upstream catalog with the paid key",
    calls.some((c) => c.method === "GET" && c.path === "/zen/v1/models" && c.keyKind === "paid")
  );

  res = await client("GET", "/v1/models", apiKey);
  const unified = Array.isArray(res.json?.data) ? res.json.data.map((m) => String(m.id)) : [];
  record("the unified /v1/models catalog is 200", res.status === 200, `status ${res.status}`);
  record(
    "the unified catalog does not offer a decision model as chat",
    !unified.some((id) => /jev/i.test(id))
  );

  // ── explicit free tier ────────────────────────────────────────────────────
  const freeId = await addConnection("ci-zen-free", freeKey, {
    providerSpecificData: { systemOneTier: "free" },
  });
  if (freeId) {
    mark = await callCount();
    res = await client("POST", "/v1/systemone", apiKey, noulRequest("jev-free", stateMarker));
    calls = await callsSince(mark);
    record(
      "the free alias is served by the explicitly tagged free connection only",
      res.status === 200 &&
        calls.length === 1 &&
        calls[0].model === "jev-1.13-free" &&
        calls[0].keyKind === "free",
      `status ${res.status}`
    );

    mark = await callCount();
    res = await client("POST", "/v1/systemone", apiKey, noulRequest("jev", stateMarker));
    calls = await callsSince(mark);
    record(
      "the paid alias never spends the free connection",
      res.status === 200 &&
        calls.length === 1 &&
        calls[0].model === "jev-1.13" &&
        calls[0].keyKind === "paid",
      `status ${res.status}`
    );

    res = await client("GET", "/v1/systemone/models", apiKey);
    ids = Array.isArray(res.json?.data) ? res.json.data.map((m) => m.id) : [];
    record(
      "the catalog now lists the free model too",
      ids.includes(FREE_MODEL) && ids.includes(PAID_MODEL)
    );
  }

  return finish(steps, await readMockCalls());
}

function finish(steps, upstreamCalls = []) {
  return {
    ok: steps.length > 0 && steps.every((step) => step.ok),
    steps,
    upstreamCalls,
  };
}

function readDockerMockCalls(container) {
  const logs = spawnSync("docker", ["logs", container], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`;
  return text
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.event === "upstream_call");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`systemone-smoke: ${name} is required`);
    process.exit(2);
  }
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const evidenceDir = requiredEnv("SMOKE_EVIDENCE_DIR");
  const container = requiredEnv("SMOKE_MOCK_CONTAINER");
  const result = await runSmoke({
    baseUrl: requiredEnv("SMOKE_BASE_URL"),
    adminPassword: requiredEnv("SMOKE_ADMIN_PASSWORD"),
    paidKey: requiredEnv("SMOKE_PAID_KEY"),
    freeKey: requiredEnv("SMOKE_FREE_KEY"),
    stateMarker: requiredEnv("SMOKE_STATE_MARKER"),
    readMockCalls: () => readDockerMockCalls(container),
  });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "smoke-results.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2)}\n`
  );
  for (const step of result.steps) {
    console.log(
      `${step.ok ? "PASS" : "FAIL"}  ${step.name}${step.detail ? ` (${step.detail})` : ""}`
    );
  }
  console.log(result.ok ? "System One smoke: all checks passed" : "System One smoke: FAILED");
  process.exit(result.ok ? 0 : 1);
}
