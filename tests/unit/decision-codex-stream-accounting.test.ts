import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { getKeyQuotaStatus } from "../../src/lib/db/keyQuota.ts";
import {
  reserveDecisionAttempt,
  startDecisionAttempt,
  readDecisionAttempts,
  releaseDecisionAttempt,
  type AttemptIdentity,
} from "../../src/lib/db/decisionAttempts.ts";
import { createApplicationStream } from "../../src/lib/decisionPolicy/applicationStream.ts";

// Closed in-memory stream fixtures, never provider/network captures.
const MODEL = "gpt-6-sol";
const ID = "synthetic-protocol-completion";
const encoder = new TextEncoder();
const usage = {
  input_tokens: 10,
  output_tokens: 7,
  total_tokens: 17,
  input_tokens_details: { cached_tokens: 4 },
  output_tokens_details: { reasoning_tokens: 3 },
};
function event(type: string, response: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
}
const created = event("response.created", { id: ID, model: MODEL });
const completed = event("response.completed", { id: ID, model: MODEL, usage });
async function stage() {
  const key = await createApiKey("synthetic-codex-stream", "synthetic");
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId: key.id,
    comboId: "synthetic-stream-combo",
    candidateId: "synthetic-codex-high",
    provider: "codex",
    model: MODEL,
    connectionId: "synthetic-codex-connection",
    effort: "high",
  };
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  const controller = new AbortController();
  const stream = createApplicationStream(identity, controller.signal, { include_usage: true });
  return { key, identity, controller, stream };
}
function source(chunks: Uint8Array[], rejectCancellation = false) {
  let cancelled = 0,
    pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else return new Promise<void>(() => {});
      },
      cancel() {
        cancelled++;
        if (rejectCancellation) return Promise.reject(new Error("Synthetic cancellation error"));
      },
    },
    { highWaterMark: 0 }
  );
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    cancelled: () => cancelled,
    pulls: () => pulls,
  };
}
async function readStaticFailure(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let observed = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) assert.fail("Rejected native stream cannot finish as success");
      observed += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "decision_stream_rejected");
    return observed;
  }
}
after(() => resetDbInstance());

test("validated native terminal closes a never-ending upstream without an extra read or lost usage", async () => {
  const { key, stream } = await stage();
  const mock = source([encoder.encode(created + completed)], true);
  const text = await stream.wrap(stream.observe(mock.response)).text();
  assert.match(text, /response.completed/);
  assert.equal(mock.cancelled(), 1);
  assert.equal(mock.pulls(), 1);
  const rows = readDecisionAttempts(key.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].application_status, 200);
  assert.equal(rows[0].input_tokens, 10);
  assert.equal(rows[0].output_tokens, 7);
  assert.equal(rows[0].reasoning_tokens, 3);
  assert.equal(rows[0].cost_usd, null);
  assert.equal(stream.reportedClientUsage()?.completion_tokens, 7);
});
test("split native frames remain pull-through and settle only on the real protocol terminal", async () => {
  const { key, stream } = await stage();
  const bytes = encoder.encode(created + completed);
  const mock = source([bytes.slice(0, 7), bytes.slice(7, 117), bytes.slice(117)]);
  await stream.wrap(stream.observe(mock.response)).text();
  assert.equal(mock.pulls(), 3);
  assert.equal(mock.cancelled(), 1);
  assert.equal(readDecisionAttempts(key.id)[0].output_tokens, 7);
});
test("source-supported data-only SSE and pre-created vendor metadata do not change terminal accounting", async () => {
  const { key, stream } = await stage();
  const rows = [
    { type: "codex.rate_limits", rate_limits: { remaining: 0 }, usage: { cost: 0 } },
    { type: "response.created", response: { id: ID, headers: { "OpenAI-Model": MODEL } } },
    { type: "response.output_text.delta", delta: "Synthetic source-compatible delta" },
    { type: "response.completed", response: { id: ID, usage } },
  ];
  const data = rows.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
  const mock = source([encoder.encode(data)]);
  await stream.wrap(stream.observe(mock.response)).text();
  const receipt = readDecisionAttempts(key.id)[0];
  assert.equal(receipt.application_status, 200);
  assert.equal(receipt.output_tokens, 7);
  assert.equal(receipt.cost_usd, null);
  assert.equal(mock.cancelled(), 1);
});
for (const trailing of [
  'data: {"type":"response.output_text.delta","delta":"unintended"}\n\n',
  'data: {"type":"response.output_text.delta"',
  ": nonempty trailing comment\n\n",
])
  test(`same-chunk data after native terminal rejects (${trailing.length} bytes)`, async () => {
    const { key, stream } = await stage();
    const mock = source([encoder.encode(created + completed + trailing)]);
    await assert.rejects(stream.wrap(stream.observe(mock.response)).text());
    const row = readDecisionAttempts(key.id)[0];
    assert.equal(row.output_tokens, null);
    assert.equal(row.cost_usd, null);
    assert.equal(row.application_status, 409);
    assert.equal(mock.cancelled(), 1);
  });
test("an incomplete trailing UTF-8 codepoint cannot disappear behind native completion", async () => {
  const { key, stream } = await stage();
  const bytes = encoder.encode(created + completed);
  const chunk = new Uint8Array(bytes.length + 1);
  chunk.set(bytes);
  chunk[bytes.length] = 0xe2;
  const mock = source([chunk]);
  await assert.rejects(stream.wrap(stream.observe(mock.response)).text());
  assert.equal(readDecisionAttempts(key.id)[0].output_tokens, null);
  assert.equal(mock.cancelled(), 1);
});
test("disconnect before native terminal preserves unknown output and cancels exactly once", async () => {
  const { key, controller, stream } = await stage();
  const mock = source([encoder.encode(created)]);
  const reader = stream.wrap(stream.observe(mock.response)).body!.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await assert.rejects(reader.read());
  const row = readDecisionAttempts(key.id)[0];
  assert.equal(row.output_tokens, null);
  assert.equal(row.cost_usd, null);
  assert.equal(row.application_status, 499);
  assert.equal(mock.cancelled(), 1);
});
test("a supplied server-model header mismatch rejects before consuming response data", async () => {
  const { key, identity, stream } = await stage();
  const mock = source([encoder.encode(created + completed)]);
  mock.response.headers.set("openai-model", "gpt-5.6-sol");
  assert.throws(() => stream.observe(mock.response), /decision_codex_response_invalid/);
  assert.equal(mock.pulls(), 0);
  releaseDecisionAttempt(identity);
  assert.equal(readDecisionAttempts(key.id)[0].output_tokens, null);
  await mock.response.body?.cancel();
});
for (const type of ["response.failed", "response.incomplete", "response.cancelled"])
  test(`${type} retains native usage but is never recorded as application success`, async () => {
    const { key, stream } = await stage();
    const mock = source([encoder.encode(created + event(type, { id: ID, usage }))]);
    await readStaticFailure(stream.wrap(stream.observe(mock.response)));
    const row = readDecisionAttempts(key.id)[0];
    assert.ok(Number(row.application_status) >= 400);
    assert.equal(row.output_tokens, 7);
    assert.equal(row.cost_usd, null);
  });
test("native refusal and explicitly non-final turn receipts never become successful applications", async () => {
  for (const extra of [
    { end_turn: false },
    {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "Synthetic" }],
        },
      ],
    },
  ]) {
    const { key, stream } = await stage();
    const mock = source([
      encoder.encode(created + event("response.completed", { id: ID, usage, ...extra })),
    ]);
    await readStaticFailure(stream.wrap(stream.observe(mock.response)));
    const row = readDecisionAttempts(key.id)[0];
    assert.ok(Number(row.application_status) >= 400);
    assert.equal(row.output_tokens, 7);
    assert.equal(mock.cancelled(), 1);
  }
});
const OPAQUE = "OpaqueNativeFixtureCredential_78b5a4621c";
type UnsafeFrame =
  | "response.failed"
  | "refusal"
  | "error"
  | "early-refusal"
  | "item-refusal"
  | "lifecycle-refusal"
  | "text-error";
function secretFrames(type: UnsafeFrame) {
  if (type === "text-error")
    return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Synthetic", error: { message: OPAQUE } })}\n\n`;
  if (type === "error")
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { message: OPAQUE } })}\n\n`;
  if (type === "early-refusal")
    return `event: response.refusal.delta\ndata: ${JSON.stringify({ type: "response.refusal.delta", delta: OPAQUE })}\n\n`;
  if (type === "response.failed") return event(type, { id: ID, usage, error: { message: OPAQUE } });
  const output = [
    { type: "message", role: "assistant", content: [{ type: "refusal", refusal: OPAQUE }] },
  ];
  if (type === "item-refusal")
    return `data: ${JSON.stringify({ type: "response.output_item.done", item: output[0] })}\n\n`;
  if (type === "lifecycle-refusal") return event("response.in_progress", { id: ID, output });
  return event("response.completed", {
    id: ID,
    usage,
    output: [
      { type: "message", role: "assistant", content: [{ type: "refusal", refusal: OPAQUE }] },
    ],
  });
}
for (const type of [
  "response.failed",
  "refusal",
  "error",
  "early-refusal",
  "item-refusal",
  "lifecycle-refusal",
  "text-error",
] as const)
  for (const split of [false, true])
    test(`opaque credential in native ${type} is withheld before forwarding (${split ? "split" : "whole"})`, async () => {
      const { key, stream } = await stage();
      const failure = secretFrames(type);
      const boundary = failure.indexOf(OPAQUE) + 18;
      const chunks = split
        ? [
            encoder.encode(created),
            encoder.encode(failure.slice(0, boundary)),
            encoder.encode(failure.slice(boundary)),
          ]
        : [encoder.encode(created), encoder.encode(failure)];
      const mock = source(chunks);
      const observed = await readStaticFailure(stream.wrap(stream.observe(mock.response)));
      assert.equal(observed.includes(OPAQUE), false);
      assert.equal(observed.includes("OpaqueNativeFixture"), false);
      assert.equal(observed.includes("response.failed"), false);
      const row = readDecisionAttempts(key.id)[0];
      assert.equal(row.output_tokens, type === "response.failed" || type === "refusal" ? 7 : null);
      assert.equal(row.cost_usd, null);
      assert.equal(
        row.application_status,
        type === "response.failed" || type === "error" || type === "text-error" ? 409 : 422
      );
      assert.equal(readDecisionAttempts(key.id).length, 1);
      const history = getDbInstance()
        .prepare(
          "SELECT tokens_output,success,provider_cost_usd FROM usage_history WHERE decision_attempt_id=?"
        )
        .all(row.id) as Array<{
        tokens_output: number | null;
        success: number;
        provider_cost_usd: number | null;
      }>;
      assert.equal(history.length, 1);
      assert.equal(history[0].success, 0);
      assert.equal(
        history[0].tokens_output,
        type === "response.failed" || type === "refusal" ? 4 : null
      );
      assert.equal(history[0].provider_cost_usd, null);
      assert.equal(getKeyQuotaStatus(key.id).counters.rpmUsed, 1);
      assert.equal(
        getKeyQuotaStatus(key.id).counters.tpmUsed,
        type === "response.failed" || type === "refusal" ? 17 : 0
      );
      const ledger = getDbInstance()
        .prepare("SELECT COUNT(*) n FROM request_cost_ledger WHERE request_id=?")
        .get(row.id) as { n: number };
      assert.equal(ledger.n, 0, "Unknown USD is not a fabricated zero-dollar receipt");
      assert.equal(mock.cancelled(), 1);
    });
