import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationResponsesStream } from "../../src/lib/decisionPolicy/applicationResponsesStream.ts";

test("cancelling a Responses read awaiting EOF cannot publish completed history", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  const payload = {
    object: "chat.completion.chunk",
    model: "synthetic-model",
    choices: [{ index: 0, delta: { content: "Synthetic" }, finish_reason: null }],
  };
  source.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    )
  );
  let committed = 0,
    failed = 0,
    released = 0;
  const response = applicationResponsesStream(new Response(stream), "synthetic-model", {
    id: "resp_synthetic",
    store: true,
    streaming: true,
    signal: new AbortController().signal,
    reportedUsage: () => null,
    prepare: () => {},
    complete: () => {
      committed++;
    },
    fail: () => {
      failed++;
    },
    release: () => {
      released++;
    },
  });
  const reader = response.body!.getReader();
  for (let i = 0; i < 5; i++) assert.equal((await reader.read()).done, false);
  const pending = reader.read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await reader.cancel();
  await pending;
  assert.equal(committed, 0);
  assert.ok(failed > 0);
  assert.ok(released > 0);
});

test("an aborted Responses deadline cannot publish after the inner stream completed", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  const row = {
    object: "chat.completion.chunk",
    model: "synthetic-model",
    choices: [{ index: 0, delta: { content: "Synthetic" }, finish_reason: null }],
  };
  source.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify(row)}\n\ndata: ${JSON.stringify({ ...row, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    )
  );
  const abort = new AbortController();
  let committed = 0;
  const response = applicationResponsesStream(new Response(stream), "synthetic-model", {
    id: "resp_synthetic",
    store: true,
    streaming: true,
    signal: abort.signal,
    reportedUsage: () => null,
    prepare: () => {},
    complete: () => {
      committed++;
    },
    fail: () => {},
    release: () => {},
  });
  const reader = response.body!.getReader();
  for (let i = 0; i < 5; i++) await reader.read();
  const pending = reader.read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  try {
    source.close();
  } catch {
    /* The abort handler may already have cancelled the source. */
  }
  try {
    await pending;
  } catch {
    /* Rejection expected. */
  }
  assert.equal(committed, 0);
});

test("Responses cancellation still closes its source when accounting cleanup throws", async () => {
  let cancelled = false,
    released = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const response = applicationResponsesStream(new Response(source), "synthetic-model", {
    id: "resp_synthetic",
    store: true,
    streaming: true,
    signal: new AbortController().signal,
    reportedUsage: () => null,
    prepare: () => {},
    complete: () => {
      assert.fail("No completion is available");
    },
    fail: () => {
      throw new Error("synthetic-accounting-unavailable");
    },
    release: () => {
      released = true;
      throw new Error("synthetic-release-unavailable");
    },
  });
  await assert.doesNotReject(response.body!.cancel());
  assert.equal(released, true);
  assert.equal(cancelled, true);
});
test("Responses committed completion survives a best-effort cleanup failure", async () => {
  const row = {
    object: "chat.completion.chunk",
    model: "synthetic-model",
    choices: [{ index: 0, delta: { content: "Synthetic" }, finish_reason: null }],
  };
  const source = new Response(
    `data: ${JSON.stringify(row)}\n\ndata: ${JSON.stringify({ ...row, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
  );
  let committed = 0,
    failed = 0;
  const response = applicationResponsesStream(source, "synthetic-model", {
    id: "resp_synthetic",
    store: true,
    streaming: true,
    signal: new AbortController().signal,
    prepare: () => {},
    reportedUsage: () => null,
    complete: () => {
      committed++;
    },
    fail: () => {
      failed++;
    },
    release: () => {
      throw new Error("synthetic-postcommit-cleanup");
    },
  });
  const text = await response.text();
  assert.match(text, /"type":"response.completed"/);
  assert.equal(committed, 1);
  assert.equal(failed, 0);
});
