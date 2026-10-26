import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import {
  readDecisionAttempts,
  reserveDecisionAttempt,
  type AttemptIdentity,
} from "../../src/lib/db/decisionAttempts.ts";
process.env.REQUIRE_API_KEY = "true";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
const { POST: countTokens } = await import("../../src/app/api/v1/responses/input_tokens/route.ts");
type Event = { event: string; [key: string]: unknown };
const workers = new Set<ReviewWorker>();
class ReviewWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private events: Event[] = [];
  private waiters: Array<{
    kinds: string[];
    resolve: (value: Event) => void;
    reject: (error: Error) => void;
  }> = [];
  constructor(options: Record<string, unknown>) {
    this.child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "--import",
        "./open-sse/utils/setupPolyfill.ts",
        "tests/fixtures/decisionPolicy/admissionRecoveryReviewWorker.ts",
        JSON.stringify(options),
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] }
    );
    this.closed = new Promise((resolve) =>
      this.child.once("exit", (code, signal) => {
        for (const waiter of this.waiters.splice(0))
          waiter.reject(new Error(`Worker exited before expected event (${code}/${signal})`));
        resolve({ code, signal });
      })
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!line.startsWith("ADMISSION_REVIEW ")) return;
      const event = JSON.parse(line.slice("ADMISSION_REVIEW ".length)) as Event;
      const index = this.waiters.findIndex((waiter) => waiter.kinds.includes(event.event));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(event);
      else this.events.push(event);
    });
    this.child.stderr.resume();
    workers.add(this);
  }
  send(action: string, extra: Record<string, unknown> = {}) {
    this.child.stdin.write(JSON.stringify({ action, ...extra }) + "\n");
  }
  next(...kinds: string[]): Promise<Event> {
    const index = this.events.findIndex((event) => kinds.includes(event.event));
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker event timeout: ${kinds.join(",")}`)),
        60000
      );
      this.waiters.push({
        kinds,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
  async kill() {
    this.child.kill("SIGKILL");
    const result = await this.closed;
    workers.delete(this);
    return result;
  }
  async exit() {
    this.send("exit");
    const result = await this.closed;
    workers.delete(this);
    assert.equal(result.code, 0);
  }
}
afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.kill()));
});
after(() => resetDbInstance());
let sequence = 0;
async function keyAndConnection() {
  const key = await createApiKey(`synthetic-review-${++sequence}`, "synthetic-machine");
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: `synthetic-review-${sequence}`,
    apiKey: "synthetic-admission-execution",
    isActive: true,
    testStatus: "active",
    maxConcurrent: 1,
    providerSpecificData: {},
  });
  return { key, connection };
}
async function comboFor(seed: Awaited<ReturnType<typeof keyAndConnection>>, native = false) {
  const candidate = (id: string, effort: "medium" | "high") => ({
    id,
    provider: "openai",
    model: "gpt-5.4",
    endpointKind: "direct",
    evidence: "Synthetic review profile",
    capabilities: {
      text: true,
      images: false,
      tools: false,
      reasoning: true,
      contextTokens: 100000,
    },
    effort: {
      mode: "set",
      value: effort,
      supported: ["medium", "high"],
      evidence: "Synthetic review efforts",
    },
  });
  let selection: Record<string, unknown> = { mode: "deterministic" };
  if (native) {
    const selector = await createProviderConnection({
      provider: "opencode-zen",
      authType: "apikey",
      name: `synthetic-review-selector-${++sequence}`,
      apiKey: "synthetic-admission-selector",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { systemOneTier: "free" },
    });
    selection = {
      mode: "native",
      provider: "opencode-zen",
      model: "jev-1.13-free",
      connectionId: selector.id,
      timeoutMs: 10000,
      maxCandidates: 32,
    };
  }
  const candidates = native
    ? [candidate("light", "medium"), candidate("deep", "high")]
    : [candidate("light", "medium")];
  return createCombo({
    name: `synthetic-review-combo-${++sequence}`,
    models: ["openai/gpt-5.4"],
    config: {
      decisionPolicy: {
        enabled: true,
        applicationMode: "bounded-v1",
        selection,
        connections: Object.fromEntries(candidates.map((row) => [row.id, seed.connection.id])),
        policy: {
          version: 1,
          candidates,
          taskOrder: { explanation: candidates.map((row) => row.id) },
          unknownQuota: "allow",
          decisionFailure: "stop",
          maxDecisionAttempts: native ? 1 : 0,
          maxExecutionAttempts: 1,
          timeoutMs: 30000,
        },
      },
    },
  });
}
async function workerFor(
  seed: Awaited<ReturnType<typeof keyAndConnection>>,
  mode: string,
  native = false
) {
  const combo = await comboFor(seed, native);
  const worker = new ReviewWorker({
    key: seed.key.key,
    keyId: seed.key.id,
    comboId: combo.id,
    comboName: combo.name,
    connectionId: seed.connection.id,
    mode,
  });
  await worker.next("booted");
  return { worker, comboId: String(combo.id) };
}
const expire = (id: string) =>
  getDbInstance()
    .prepare("UPDATE decision_application_attempts SET lease_expires_at=? WHERE id=?")
    .run(Date.now() - 1, id);
const counts = (keyId: string) => {
  const db = getDbInstance();
  return {
    ledger: Number(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM request_cost_ledger WHERE api_key_id=?")
          .get(keyId) as { n: number }
      ).n
    ),
    usd: Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount_usd),0) AS n FROM request_cost_ledger WHERE api_key_id=?"
          )
          .get(keyId) as { n: number }
      ).n
    ),
    rpm: Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(consumed),0) AS n FROM api_key_quota_counters WHERE api_key_id=? AND dimension_key='key-quota:rpm'"
          )
          .get(keyId) as { n: number }
      ).n
    ),
  };
};
test("actual ordinary local token endpoint is unaffected by an uncapped pending automatic request", async () => {
  const { key } = await keyAndConnection();
  const request = () =>
    new Request("http://synthetic.invalid/api/v1/responses/input_tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", input: "Synthetic local count" }),
    });
  assert.equal((await countTokens(request())).status, 200);
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId: String(key.id),
    comboId: "synthetic-reserved",
    candidateId: "light",
    provider: "openai",
    model: "gpt-5.4",
    connectionId: "synthetic-connection",
    effort: "medium",
  };
  reserveDecisionAttempt(identity);
  assert.equal((await countTokens(request())).status, 200);
});
for (const mode of ["queue", "execution"] as const)
  test(`actual handler ${mode} owner crash expires safely without request replay`, async () => {
    const seed = await keyAndConnection();
    const { worker } = await workerFor(seed, mode);
    worker.send("start");
    const ready = await worker.next("ready", "finished", "failed");
    assert.equal(ready.event, "ready", JSON.stringify(ready));
    const id = String(ready.id);
    assert.equal((await worker.kill()).signal, "SIGKILL");
    assert.equal(
      readDecisionAttempts(String(seed.key.id)).find((row) => row.id === id)!.state,
      mode === "queue" ? "reserved" : "started"
    );
    expire(id);
    resetDbInstance();
    const next = await workerFor(seed, "normal");
    next.worker.send("start");
    const finished = await next.worker.next("finished", "failed");
    assert.equal(finished.status, 200, JSON.stringify(finished));
    assert.equal(finished.syntheticDispatches, 1);
    const old = readDecisionAttempts(String(seed.key.id)).find((row) => row.id === id)!;
    assert.equal(old.state, mode === "queue" ? "cancelled" : "unknown");
    assert.equal(old.cost_usd, mode === "queue" ? 0 : null);
    assert.equal(counts(String(seed.key.id)).ledger, 1);
    await next.worker.exit();
  });
test("seven actual application workers share exactly four live key slots", async () => {
  const seed = await keyAndConnection();
  const clients = await Promise.all(Array.from({ length: 7 }, () => workerFor(seed, "execution")));
  for (const { worker } of clients) worker.send("start");
  const events = await Promise.all(
    clients.map(async (client) => ({
      ...client,
      result: await client.worker.next("ready", "finished", "failed"),
    }))
  );
  const admitted = events.filter((event) => event.result.event === "ready");
  const rejected = events.filter((event) => event.result.event === "finished");
  assert.equal(admitted.length, 4, JSON.stringify(events.map((event) => event.result)));
  assert.equal(rejected.length, 3);
  for (const event of rejected) {
    assert.equal(event.result.status, 409);
    assert.equal(event.result.syntheticDispatches, 0);
  }
  for (const event of admitted) event.worker.send("release");
  for (const event of admitted)
    assert.equal((await event.worker.next("finished", "failed")).status, 200);
  assert.equal(counts(String(seed.key.id)).ledger, 4);
  assert.equal(counts(String(seed.key.id)).rpm, 4);
  assert.equal(readDecisionAttempts(String(seed.key.id)).length, 4);
  await Promise.all(clients.map((client) => client.worker.exit()));
});
test("expired native selector records late billing once but cannot hand over or replay", async () => {
  const seed = await keyAndConnection();
  const old = await workerFor(seed, "decision", true);
  const current = await workerFor(seed, "normal", true);
  old.worker.send("start");
  const held = await old.worker.next("ready", "finished", "failed");
  assert.equal(held.event, "ready", JSON.stringify(held));
  expire(String(held.id));
  current.worker.send("start");
  const accepted = await current.worker.next("finished", "failed");
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.syntheticDispatches, 2);
  old.worker.send("release");
  const stale = await old.worker.next("finished", "failed");
  assert.equal(stale.status, 409, JSON.stringify(stale));
  assert.equal(stale.syntheticDispatches, 1);
  const oldRows = readDecisionAttempts(String(seed.key.id)).filter(
    (row) => row.combo_id === old.comboId
  );
  assert.equal(oldRows.length, 1);
  assert.equal(oldRows[0].cost_usd, 0.003);
  old.worker.send("staleStart");
  assert.equal((await old.worker.next("staleRejected", "staleStarted")).event, "staleRejected");
  for (let index = 0; index < 2; index++) {
    old.worker.send("settle", { cost: 0.003 });
    const receipt = await old.worker.next("settled", "settleRejected");
    assert.equal(receipt.event, "settled", JSON.stringify(receipt));
    assert.deepEqual(receipt.counts, {
      ledger: 1,
      usage: 1,
    });
  }
  old.worker.send("settle", { cost: 0.004 });
  assert.equal((await old.worker.next("settleRejected", "settled")).event, "settleRejected");
  assert.equal(counts(String(seed.key.id)).ledger, 3);
  assert.ok(Math.abs(counts(String(seed.key.id)).usd - 0.026) < 1e-9);
  assert.equal(counts(String(seed.key.id)).rpm, 2);
  await old.worker.exit();
  await current.worker.exit();
});
test("caller cancellation after response headers retains unknown receipt, then trusted late settlement is idempotent", async () => {
  const seed = await keyAndConnection();
  const { worker, comboId } = await workerFor(seed, "headers");
  worker.send("start");
  const ready = await worker.next("ready", "finished", "failed");
  assert.equal(ready.event, "ready", JSON.stringify(ready));
  worker.send("abort");
  const finished = await worker.next("finished", "failed");
  assert.equal(finished.status, 499, JSON.stringify(finished));
  assert.equal(finished.syntheticDispatches, 1);
  const row = readDecisionAttempts(String(seed.key.id)).find((row) => row.combo_id === comboId)!;
  assert.equal(row.cost_usd, null);
  for (let index = 0; index < 2; index++) {
    worker.send("settle", { cost: 0.02 });
    const receipt = await worker.next("settled", "settleRejected");
    assert.equal(receipt.event, "settled", JSON.stringify(receipt));
    assert.deepEqual(receipt.counts, {
      ledger: 1,
      usage: 1,
    });
  }
  assert.equal(counts(String(seed.key.id)).rpm, 1);
  await worker.exit();
});

test("a requested-combo token cap cannot enter the uncapped bounded application lane", async () => {
  const { upsertTokenLimit } = await import("../../src/lib/db/tokenLimits.ts");
  const seed = await keyAndConnection();
  const combo = await comboFor(seed);
  upsertTokenLimit({
    apiKeyId: String(seed.key.id),
    scopeType: "model",
    scopeValue: String(combo.name),
    tokenLimit: 100000,
    enabled: true,
  });
  const worker = new ReviewWorker({
    key: seed.key.key,
    keyId: seed.key.id,
    comboId: combo.id,
    comboName: combo.name,
    connectionId: seed.connection.id,
    mode: "normal",
  });
  await worker.next("booted");
  worker.send("start");
  const result = await worker.next("finished", "failed");
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.syntheticDispatches, 0);
  assert.equal(readDecisionAttempts(String(seed.key.id)).length, 0);
  await worker.exit();
});

test("a live queued owner whose lease expires cannot reach the actual execution transport", async () => {
  const seed = await keyAndConnection();
  const { worker } = await workerFor(seed, "queue");
  worker.send("start");
  const ready = await worker.next("ready", "finished", "failed");
  assert.equal(ready.event, "ready", JSON.stringify(ready));
  expire(String(ready.id));
  worker.send("release");
  const result = await worker.next("finished", "failed");
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.syntheticDispatches, 0);
  const row = readDecisionAttempts(String(seed.key.id)).find((item) => item.id === ready.id)!;
  assert.equal(row.state, "cancelled");
  assert.equal(row.cost_usd, 0);
  assert.equal(counts(String(seed.key.id)).rpm, 0);
  await worker.exit();
});
