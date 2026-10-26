import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { currentApplicationAttempt } from "../../../open-sse/services/decisionPolicy/applicationContext.ts";
import {
  readDecisionAttempts,
  readDecisionAttemptReceipt,
  settleDecisionAttempt,
  startDecisionAttempt,
  type AttemptIdentity,
} from "../../../src/lib/db/decisionAttempts.ts";
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import { acquire, getStats } from "../../../open-sse/services/accountSemaphore.ts";

process.env.REQUIRE_API_KEY = "true";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
const { POST } = await import("../../../src/app/api/v1/chat/completions/route.ts");
type Options = {
  key: string;
  keyId: string;
  comboId: string;
  comboName: string;
  connectionId: string;
  mode: "normal" | "queue" | "execution" | "decision" | "headers";
};
const options = JSON.parse(process.argv[2]) as Options;
const controller = new AbortController();
let releaseQueue: (() => void) | undefined;
let releaseFetch: (() => void) | undefined;
let captured: AttemptIdentity | undefined;
let started = false;
let syntheticDispatches = 0;
let unexpectedFetches = 0;
const emit = (event: string, data: Record<string, unknown> = {}) =>
  process.stdout.write(`ADMISSION_REVIEW ${JSON.stringify({ event, ...data })}\n`);
function publicSummary() {
  const rows = readDecisionAttempts(options.keyId).filter(
    (row) => row.combo_id === options.comboId
  );
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    lane: row.lane,
    cost: row.cost_usd,
    status: row.http_status,
  }));
}
function receiptCounts() {
  const db = getDbInstance();
  const count = (table: string) =>
    Number(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE request_id=?`).get(captured!.id) as {
          n: number;
        }
      ).n
    );
  return {
    ledger: count("request_cost_ledger"),
    usage: Number(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM usage_history WHERE decision_attempt_id=?")
          .get(captured!.id) as { n: number }
      ).n
    ),
  };
}
globalThis.fetch = async (input, init = {}) => {
  const address = input instanceof Request ? input.url : String(input);
  if (
    ![
      "https://api.openai.com/v1/chat/completions",
      "https://opencode.ai/inference/systemone/v1/systemone",
    ].includes(address) ||
    init.method !== "POST"
  ) {
    unexpectedFetches++;
    throw new Error("Unexpected fetch in synthetic admission worker");
  }
  const decision = address.includes("opencode.ai");
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  const headers = new Headers(init.headers);
  assert.equal(
    headers.get("authorization"),
    `Bearer synthetic-admission-${decision ? "selector" : "execution"}`
  );
  assert.equal(body.model, decision ? "jev-1.13-free" : "gpt-5.4");
  assert.equal(init.redirect, "error");
  syntheticDispatches++;
  const attempt = currentApplicationAttempt();
  assert.ok(attempt);
  const hold =
    (decision && options.mode === "decision") || (!decision && options.mode === "execution");
  if (hold || options.mode === "headers") {
    const owner = readDecisionAttemptReceipt(attempt.id).lease_owner;
    assert.equal(typeof owner, "string");
    // Snapshot this originating worker's capability at its initial transport boundary.
    // Never emit it through the fixture protocol or reconstruct it after expiry.
    captured = { ...attempt, leaseOwner: String(owner) };
  }
  if (hold) {
    emit("ready", {
      id: attempt.id,
      stage: decision ? "decision" : "execution",
      syntheticDispatches,
    });
    await new Promise<void>((resolve, reject) => {
      const signal = init.signal;
      const onAbort = () => reject(signal?.reason ?? new Error("synthetic abort"));
      releaseFetch = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  if (options.mode === "headers" && !decision) {
    return new Response(
      new ReadableStream({
        pull() {
          emit("ready", { id: attempt.id, stage: "headers", syntheticDispatches });
        },
        cancel() {
          emit("bodyCancelled");
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  if (decision) {
    return Response.json({
      model: "jev-1.13-free",
      answers: {
        route: {
          type: "choice",
          choice: "light",
          probabilities: { light: 0.8, deep: 0.2 },
          confidence: 0.6,
        },
      },
      usage: { input_tokens: 7, output_tokens: 2, cost: 0.003 },
    });
  }
  return Response.json({
    id: "synthetic-admission-result",
    model: "gpt-5.4",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Synthetic local result" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.02 },
  });
};
async function run() {
  if (started) return;
  started = true;
  if (options.mode === "queue")
    releaseQueue = await acquire(`openai:${options.connectionId}`, { maxConcurrency: 1 });
  const pending = POST(
    new Request("http://synthetic.invalid/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.comboName,
        messages: [{ role: "user", content: "Explain a variable." }],
        stream: false,
        max_completion_tokens: 64,
      }),
    })
  );
  if (options.mode === "queue") {
    for (let n = 0; n < 2000; n++) {
      const row = publicSummary().find((row) => row.state === "reserved");
      if (row && getStats()[`openai:${options.connectionId}`]?.queued) {
        emit("ready", { id: row.id, stage: "reserved", syntheticDispatches });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    const response = await pending;
    await response.text();
    emit("finished", {
      status: response.status,
      rows: publicSummary(),
      syntheticDispatches,
      unexpectedFetches,
    });
  } catch (error) {
    emit("failed", {
      message: error instanceof Error ? error.message : "worker failed",
      syntheticDispatches,
      unexpectedFetches,
    });
  }
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line) as { action: string; cost?: number };
  if (command.action === "start") void run();
  if (command.action === "release") {
    releaseQueue?.();
    releaseFetch?.();
  }
  if (command.action === "abort") controller.abort(new Error("synthetic client disconnected"));
  if (command.action === "settle") {
    try {
      assert.ok(captured);
      settleDecisionAttempt(captured, {
        status: 200,
        input: options.mode === "decision" ? 7 : 8,
        output: options.mode === "decision" ? 2 : 4,
        cost: command.cost ?? 0.02,
      });
      emit("settled", { rows: publicSummary(), counts: receiptCounts() });
    } catch (error) {
      emit("settleRejected", { message: error instanceof Error ? error.message : "rejected" });
    }
  }
  if (command.action === "staleStart") {
    try {
      assert.ok(captured);
      startDecisionAttempt(captured);
      emit("staleStarted");
    } catch (error) {
      emit("staleRejected", { message: error instanceof Error ? error.message : "rejected" });
    }
  }
  if (command.action === "exit") {
    releaseQueue?.();
    resetDbInstance();
    lines.close();
    process.exit(0);
  }
});
emit("booted");
