import test from "node:test";
import assert from "node:assert/strict";
import { createSSEOutputSink } from "../../open-sse/utils/sseOutputSink.ts";

const timing = { markForward() {}, observeOutput() {} };

for (const asynchronous of [false, true]) {
  test(`output sink preserves ${asynchronous ? "asynchronous" : "synchronous"} transform failure and cleans up without flush`, async () => {
    const failure = new Error("Synthetic formatter failure");
    let cleaned = 0;
    let flushed = 0;
    const sink = createSSEOutputSink(timing, {
      claudeClient: false,
      onTransformError: () => cleaned++,
    });
    const stream = new TransformStream(
      sink.wrap({
        transform() {
          if (asynchronous) return Promise.reject(failure);
          throw failure;
        },
        flush() {
          flushed++;
        },
      })
    );
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const read = reader.read();
    const write = writer.write(new Uint8Array([1]));
    await Promise.all([
      assert.rejects(read, (error) => error === failure),
      assert.rejects(write, (error) => error === failure),
    ]);
    assert.equal(cleaned, 1);
    assert.equal(flushed, 0);
  });
}

test("ordinary output sink retains original transform identity without cleanup hook", () => {
  const names = ["SSE_FRAME_COALESCE_MS", "SSE_COALESCE_MS"];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    const sink = createSSEOutputSink(timing, { claudeClient: false });
    const transformer = { transform() {} };
    assert.equal(sink.wrap(transformer), transformer);
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
});

test("watchdog cleanup preserves ordinary late-usage frames during terminal grace drain", async () => {
  const { createStreamController, pipeWithDisconnect } =
    await import("../../open-sse/utils/streamHandler.ts");
  const { FORMATS } = await import("../../open-sse/translator/formats.ts");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let resolveFlushed!: () => void;
  const flushed = new Promise<void>((resolve) => {
    resolveFlushed = resolve;
  });
  const observed: string[] = [];
  let errors = 0;
  const sc = createStreamController({
    clientResponseFormat: FORMATS.OPENAI,
    clientDisconnectGracePeriodMs: 1000,
    onError() {
      errors++;
    },
  });
  const provider = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    })
  );
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      observed.push(decoder.decode(chunk));
      controller.enqueue(chunk);
    },
    flush() {
      resolveFlushed();
    },
  });
  const reader = pipeWithDisconnect(provider, transform, sc, {
    stallTimeoutMs: 1000,
    activeTimeoutMs: 2000,
    highWaterMark: 0,
  }).getReader();
  const terminal =
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const receipt =
    'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n';
  try {
    upstream.enqueue(encoder.encode(terminal));
    await reader.read();
    await reader.cancel("client closed after terminal");
    upstream.enqueue(encoder.encode(receipt));
    upstream.close();
    await flushed;
    assert.deepEqual(observed, [terminal, receipt]);
    assert.equal(errors, 0);
    assert.equal(sc.signal.aborted, false);
  } finally {
    sc.abort();
    await reader.cancel().catch(() => {});
  }
});
