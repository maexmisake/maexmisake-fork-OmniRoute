/**
 * Guards for the fork-only System One verification (.github/workflows/systemone-verify.yml
 * and scripts/ci/systemone-*).
 *
 * Three layers:
 *  1. policy: the workflow and the smoke script stay read-only, local-only and
 *     secret-free (no publication, registry login, secrets, privileged mode or host
 *     volumes), and are scoped to the intended fork/branches;
 *  2. the mock upstream behaves as the smoke assertions assume and never logs a
 *     credential or the request state;
 *  3. the smoke harness itself runs end to end against an in-process STAND-IN for
 *     OmniRoute (not the real app — the real routes are covered by systemone-route
 *     and systemone-dispatch; the real image run happens in CI). The stand-in exists
 *     so harness bugs surface here and not as a red 40-minute Docker job, and a
 *     deliberately leaky stand-in proves the harness can fail.
 *
 *   node --import tsx/esm --test tests/unit/systemone-verify-workflow.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

import {
  createMockHandler,
  DECISION_PATH,
  MODELS_PATH,
} from "../../scripts/ci/systemone-mock-upstream.mjs";
import { runSmoke } from "../../scripts/ci/systemone-smoke.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const WORKFLOW_PATH = ".github/workflows/systemone-verify.yml";
const workflowText = read(WORKFLOW_PATH);
const smokeShell = read("scripts/ci/systemone-image-smoke.sh");
const dockerfile = read("Dockerfile");

type Step = { uses?: string; run?: string; with?: Record<string, unknown>; if?: string };
type Job = { if?: string; permissions?: unknown; steps: Step[]; env?: Record<string, string> };
type Workflow = {
  on: Record<string, { branches?: string[]; types?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const workflow = yamlLoad(workflowText) as Workflow;

const FORK = "maexmisake/maexmisake-fork-OmniRoute";

// A failing assert.doesNotMatch dumps the whole file into the report.
function assertAbsent(text: string, pattern: RegExp, message?: string) {
  assert.ok(!pattern.test(text), message ?? `unexpected match for ${pattern}`);
}

// ── 1. policy ────────────────────────────────────────────────────────────────

test("the workflow parses and defines exactly the two verification jobs", () => {
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["image-smoke", "source-checks"]);
});

test("triggers are limited to the feature branch push, the release PR and manual dispatch", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push?.branches, ["feat/native-system-one"]);
  assert.deepEqual(workflow.on.pull_request?.branches, ["release/v3.8.52"]);
  assertAbsent(workflowText, /pull_request_target|schedule:|workflow_run|merge_group/);
});

test("draft pull requests are not filtered out", () => {
  const types = workflow.on.pull_request?.types ?? [];
  assert.ok(types.includes("opened") && types.includes("synchronize"));
  for (const job of Object.values(workflow.jobs)) {
    assertAbsent(job.if ?? "", /draft/);
  }
});

test("every job is gated on the own fork and on same-repository pull requests", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const condition = (job.if ?? "").replace(/\s+/g, " ");
    assert.ok(
      condition.includes(`github.event.repository.full_name == '${FORK}'`),
      `${name} must be gated on ${FORK}`
    );
    assert.ok(
      condition.includes(
        "github.event.pull_request.head.repo.full_name == github.event.repository.full_name"
      ),
      `${name} must refuse pull requests from other repositories`
    );
  }
});

test("the token is read-only at workflow level and never widened per job", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.permissions, undefined, `${name} must not override permissions`);
  }
});

test("the workflow uses no secrets, registry login, publication, deployment or environments", () => {
  assertAbsent(workflowText, /secrets\./);
  assertAbsent(workflowText, /docker\/login-action|docker login|docker push/);
  assertAbsent(workflowText, /ghcr\.io|docker\.io|type=registry|registry\s*:/i);
  assertAbsent(workflowText, /\benvironment:|\bdeploy\s*:|id-token|packages:|--privileged/i);
  assertAbsent(workflowText, /push:\s*true|push-by-digest|type=registry/);
  assertAbsent(workflowText, /-v \S+:|--volume|--mount|\/var\/run\/docker\.sock/);
});

test("third-party actions are pinned to a commit or to the tags docker-publish already uses", () => {
  const allowedTags = new Set(["docker/setup-buildx-action@v4"]);
  const pinned = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.uses || step.uses.startsWith("./")) continue;
      assert.ok(
        pinned.test(step.uses) || allowedTags.has(step.uses),
        `${step.uses} is neither SHA-pinned nor an approved tag`
      );
    }
  }
});

test("the image is built from the repository Dockerfile, loaded locally, with the webpack pin", () => {
  const build = workflow.jobs["image-smoke"].steps.find((step) =>
    step.uses?.startsWith("docker/build-push-action@")
  );
  assert.ok(build?.with, "the build step must use docker/build-push-action");
  assert.equal(build.with.push, false);
  assert.equal(build.with.load, true);
  assert.equal(build.with.target, "runner-base");
  assert.equal(build.with.context, ".");
  assert.equal(build.with.file, undefined, "the existing Dockerfile must be reused as is");

  const buildArgs = String(build.with["build-args"]);
  assert.match(buildArgs, /^OMNIROUTE_USE_TURBOPACK=0$/m);
  assert.match(buildArgs, /^OMNIROUTE_BUILD_MEMORY_MB=6144$/m);
  assert.match(buildArgs, /^OMNIROUTE_BUILD_WORKERS=2$/m);

  assert.match(dockerfile, /^FROM base AS runner-base$/m);
  for (const arg of [
    "OMNIROUTE_USE_TURBOPACK",
    "OMNIROUTE_BUILD_MEMORY_MB",
    "OMNIROUTE_BUILD_WORKERS",
  ]) {
    assert.match(
      dockerfile,
      new RegExp(`^ARG ${arg}=`, "m"),
      `Dockerfile must still declare ARG ${arg}`
    );
  }
});

test("the build memory pins stay inside what the Docker memory budget test allows", () => {
  const build = workflow.jobs["image-smoke"].steps.find((step) =>
    step.uses?.startsWith("docker/build-push-action@")
  );
  const workers = Number(
    /OMNIROUTE_BUILD_WORKERS=(\d+)/.exec(String(build?.with?.["build-args"]))?.[1]
  );
  // One parent + (workers - 1) page-data processes at the measured 4.5 GB each must fit
  // 75% of a 16 GB hosted runner (tests/unit/docker-build-memory-budget.test.ts).
  assert.ok(
    workers * 4500 <= 16 * 1024 * 0.75,
    `${workers} build processes exceed the runner budget`
  );
});

test("the evidence upload and the cleanup run even when the smoke fails", () => {
  const steps = workflow.jobs["image-smoke"].steps;
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload?.if, "always()");
  const cleanup = steps.find((step) => step.run?.includes("docker rm -f"));
  assert.equal(cleanup?.if, "always()");
});

test("the smoke script is local-only: no publication, login, privileged mode or host mounts", () => {
  assertAbsent(
    smokeShell,
    /docker (login|push)|--privileged|--volume|--mount|\s-v\s+\S+:\S+|--network[= ]host/
  );
  assertAbsent(smokeShell, /set -x|set -o xtrace/);
  assert.match(smokeShell, /--internal/);
  assert.match(smokeShell, /--cap-drop ALL/);
  assert.match(smokeShell, /--security-opt no-new-privileges/);
  assert.match(smokeShell, /-p 127\.0\.0\.1::20128/);
  assert.match(smokeShell, /trap collect_and_cleanup EXIT INT TERM/);
  assert.match(smokeShell, /docker rm -f -v "\$APP" "\$MOCK"/);
  assert.match(smokeShell, /docker network rm "\$NET"/);
});

test("synthetic secrets are generated per run, masked, and never passed on a command line", () => {
  assert.match(smokeShell, /::add-mask::/);
  assert.match(smokeShell, /-e JWT_SECRET -e API_KEY_SECRET -e INITIAL_PASSWORD/);
  assertAbsent(smokeShell, /-e (JWT_SECRET|API_KEY_SECRET|INITIAL_PASSWORD|MOCK_\w+_KEY)=/);
  assert.match(smokeShell, /rand\(\) \{ openssl rand -hex 24; \}/);
});

// ── 2. mock upstream ─────────────────────────────────────────────────────────

const PAID = "ci-paid-test-key";
const FREE = "ci-free-test-key";
const MARKER = "canary-test-marker";

type MockCall = {
  seq: number;
  method: string;
  path: string;
  model: string | null;
  keyKind: string;
  stateSeen: boolean;
  status: number;
};

async function listen(
  handler: http.RequestListener
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function startMock() {
  const calls: MockCall[] = [];
  const handler = createMockHandler({
    paidKey: PAID,
    freeKey: FREE,
    stateMarker: MARKER,
    log: (entry: MockCall) => calls.push(entry),
  });
  const { server, url } = await listen((req, res) => void handler(req, res));
  return { server, url, calls };
}

const questions = {
  urgent: { type: "noul" },
  route: { type: "choice", criteria: { billing: "money", tech: "software" } },
  severity: { type: "score", criteria: ["low", "medium", "high"] },
};

async function decide(url: string, key: string | null, model: string) {
  return fetch(`${url}${DECISION_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model, state: `${MARKER} body`, questions }),
  });
}

test("the mock authenticates, answers every question type and enforces the key tier", async () => {
  const mock = await startMock();
  try {
    assert.equal((await decide(mock.url, null, "jev-1.13")).status, 401);
    assert.equal((await decide(mock.url, "wrong", "jev-1.13")).status, 401);

    const ok = await decide(mock.url, PAID, "jev-1.13");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { answers: Record<string, Record<string, unknown>> };
    assert.equal(body.answers.urgent.noul, 0.87);
    assert.equal(body.answers.route.choice, "billing");
    assert.equal(body.answers.severity.score, 2);

    assert.equal(
      (await decide(mock.url, FREE, "jev-1.13")).status,
      403,
      "free key on a paid model"
    );
    assert.equal(
      (await decide(mock.url, PAID, "jev-1.13-free")).status,
      403,
      "paid key on a free model"
    );
    assert.equal((await decide(mock.url, FREE, "jev-1.13-free")).status, 200);
  } finally {
    mock.server.close();
  }
});

test("the mock reproduces an echoing 422 and an answer-less success, and serves the catalog", async () => {
  const mock = await startMock();
  try {
    const rejected = await decide(mock.url, PAID, "jev-reject");
    assert.equal(rejected.status, 422);
    const rejectedText = await rejected.text();
    assert.ok(
      rejectedText.includes(MARKER) && rejectedText.includes(PAID),
      "the 422 echoes state and key"
    );

    const violation = await decide(mock.url, PAID, "jev-contract-violation");
    assert.equal(violation.status, 200);
    assert.deepEqual(((await violation.json()) as { answers: unknown }).answers, {});

    const catalog = await fetch(`${mock.url}${MODELS_PATH}`, {
      headers: { authorization: `Bearer ${PAID}` },
    });
    assert.equal(catalog.status, 200);
    assert.equal((await fetch(`${mock.url}${MODELS_PATH}`)).status, 401);
    assert.equal(
      (await fetch(`${mock.url}/zen/v1/chat/completions`, { method: "POST" })).status,
      404
    );
  } finally {
    mock.server.close();
  }
});

test("the mock's call log never contains a credential or the request state", async () => {
  const mock = await startMock();
  try {
    await decide(mock.url, PAID, "jev-1.13");
    await decide(mock.url, FREE, "jev-1.13-free");
    await decide(mock.url, PAID, "jev-reject");
    const serialized = JSON.stringify(mock.calls);
    assert.equal(mock.calls.length, 3);
    for (const secret of [PAID, FREE, MARKER]) assert.ok(!serialized.includes(secret));
    assert.deepEqual(
      mock.calls.map((call) => [call.keyKind, call.model, call.stateSeen, call.status]),
      [
        ["paid", "jev-1.13", true, 200],
        ["free", "jev-1.13-free", true, 200],
        ["paid", "jev-reject", true, 422],
      ]
    );
  } finally {
    mock.server.close();
  }
});

// ── 3. smoke harness against an in-process stand-in for OmniRoute ───────────────

const ADMIN = "ci-admin-password";

type Connection = { id: string; key: string; tier: "free" | "paid"; isActive: boolean };

/** Minimal OmniRoute stand-in implementing the documented contract the smoke asserts. */
async function startStandIn(mockUrl: string, options: { leakState?: boolean } = {}) {
  const connections: Connection[] = [];
  const keys = new Map<string, { id: string; endpoints: string[] }>();
  const session = "auth_token=standin-session";
  let sequence = 0;

  const readBody = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const send = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(text);
  };

  const handler: http.RequestListener = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stand-in.invalid");
    const route = `${req.method} ${url.pathname}`;
    const body = req.method === "GET" ? {} : await readBody(req);
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
    const managed = (req.headers.cookie ?? "").includes(session);

    if (route === "GET /healthz") return send(res, 200, { ok: true });
    if (route === "POST /api/auth/login") {
      if (body.password !== ADMIN) return send(res, 401, { error: "Invalid password" });
      return send(res, 200, { success: true }, { "set-cookie": `${session}; Path=/; HttpOnly` });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!managed) return send(res, 401, { error: "auth required" });
      if (route === "GET /api/auth/csrf") return send(res, 200, { token: "csrf" });
      if (route === "POST /api/keys") {
        const key = `sk-standin-${++sequence}`;
        keys.set(key, { id: `key-${sequence}`, endpoints: [] });
        return send(res, 201, { key, id: `key-${sequence}` });
      }
      if (req.method === "PATCH" && url.pathname.startsWith("/api/keys/")) {
        const entry = [...keys.values()].find((k) => k.id === url.pathname.split("/").pop());
        if (!entry) return send(res, 404, {});
        entry.endpoints = (body.allowedEndpoints as string[]) ?? [];
        return send(res, 200, { ok: true });
      }
      if (route === "POST /api/providers") {
        const data = (body.providerSpecificData ?? {}) as Record<string, unknown>;
        const connection: Connection = {
          id: `conn-${++sequence}`,
          key: String(body.apiKey),
          tier: data.systemOneTier === "free" ? "free" : "paid",
          isActive: false,
        };
        connections.push(connection);
        return send(res, 201, { connection: { id: connection.id } });
      }
      if (route === "GET /api/providers") {
        return send(res, 200, {
          connections: connections.map((c) => ({ id: c.id, testStatus: "active" })),
        });
      }
      if (route === "PATCH /api/providers") {
        for (const c of connections) if ((body.ids as string[]).includes(c.id)) c.isActive = true;
        return send(res, 200, { success: true });
      }
      return send(res, 404, {});
    }

    // client routes
    const caller = keys.get(bearer);
    if (!caller) return send(res, 401, { error: { message: "Invalid API key" } });
    if (
      url.pathname.startsWith("/v1/systemone") &&
      caller.endpoints.length &&
      !caller.endpoints.includes("systemone")
    ) {
      return send(res, 403, { error: { message: "systemone endpoint not allowed" } });
    }
    const active = connections.filter((c) => c.isActive);

    if (route === "GET /v1/models") {
      return send(res, 200, { object: "list", data: [{ id: "opencode-zen/big-pickle" }] });
    }
    if (route === "GET /v1/systemone/models") {
      const upstream = active.length
        ? ((await (
            await fetch(`${mockUrl}${MODELS_PATH}`, {
              headers: { authorization: `Bearer ${active[0].key}` },
            })
          ).json()) as { data: { id: string }[] })
        : { data: [] };
      const hasFree = active.some((c) => c.tier === "free");
      const data = upstream.data
        .filter((m) => /^jev/.test(m.id) && (hasFree || !m.id.endsWith("-free")))
        .map((m) => ({ id: `opencode-zen/${m.id}`, type: "decision" }));
      return send(res, 200, { object: "list", data });
    }
    if (route === "POST /v1/systemone") {
      const questionsIn = body.questions as Record<string, unknown> | undefined;
      if (
        typeof body.model !== "string" ||
        typeof body.state !== "string" ||
        !questionsIn ||
        !Object.keys(questionsIn).length
      ) {
        return send(res, 400, {
          error: {
            message: options.leakState ? `bad ${String(body.state)}` : "questions: Required",
          },
        });
      }
      const alias: Record<string, string> = { jev: "jev-1.13", "jev-free": "jev-1.13-free" };
      const model = alias[body.model] ?? body.model.replace(/^opencode-zen\//, "");
      const tier = model.endsWith("-free") ? "free" : "paid";
      const connection = active.find((c) => c.tier === tier);
      if (!connection) return send(res, 403, { error: { message: "no eligible connection" } });
      const upstream = await fetch(`${mockUrl}${DECISION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${connection.key}` },
        body: JSON.stringify({ ...body, model }),
      });
      const parsed = (await upstream.json()) as {
        answers?: Record<string, unknown>;
        error?: { code?: string };
      };
      if (upstream.status !== 200)
        return send(res, upstream.status, { error: { message: parsed.error?.code ?? "upstream" } });
      if (!parsed.answers || !Object.keys(parsed.answers).length)
        return send(res, 502, { error: { message: "contract violation" } });
      return send(res, 200, parsed, { "x-omniroute-cost-status": "known" });
    }
    return send(res, 404, {});
  };

  const { server, url } = await listen((req, res) => void handler(req, res));
  return { server, url };
}

async function smokeAgainstStandIn(options: { leakState?: boolean } = {}) {
  const mock = await startMock();
  const standIn = await startStandIn(mock.url, options);
  try {
    const result = await runSmoke({
      baseUrl: standIn.url,
      adminPassword: ADMIN,
      paidKey: PAID,
      freeKey: FREE,
      stateMarker: MARKER,
      readMockCalls: () => [...mock.calls],
      settleMs: 2_000,
    });
    return { result, calls: mock.calls };
  } finally {
    standIn.server.close();
    mock.server.close();
  }
}

test("the smoke harness passes every check against a conforming instance", async () => {
  const { result, calls } = await smokeAgainstStandIn();
  const failed = result.steps.filter((step: { ok: boolean }) => !step.ok);
  assert.deepEqual(failed, []);
  assert.equal(result.ok, true);
  assert.ok(result.steps.length >= 35, `only ${result.steps.length} checks ran`);
  assert.deepEqual(
    calls.filter((call) => call.path === DECISION_PATH).map((call) => call.model),
    ["jev-1.13", "jev-1.13", "jev-reject", "jev-contract-violation", "jev-1.13-free", "jev-1.13"]
  );
});

test("the smoke harness fails when an instance echoes the request state", async () => {
  const { result } = await smokeAgainstStandIn({ leakState: true });
  assert.equal(result.ok, false);
  const failed = result.steps
    .filter((step: { ok: boolean }) => !step.ok)
    .map((step: { name: string }) => step.name);
  assert.deepEqual(failed, ["the 400 does not echo the request state"]);
});

test("smoke evidence contains no secret, body or header value", async () => {
  const { result } = await smokeAgainstStandIn();
  const evidence = JSON.stringify(result);
  for (const secret of [ADMIN, PAID, FREE, MARKER, "sk-standin"]) {
    assert.ok(!evidence.includes(secret), `evidence leaks ${secret}`);
  }
});
