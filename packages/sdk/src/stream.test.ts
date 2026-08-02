import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StreamObserver, observeStream } from "./stream.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("StreamObserver — Anthropic events", () => {
  test("captures the cache breakdown from message_start", () => {
    // The whole reason streaming instrumentation exists: input tokens and the
    // cache split arrive at the START, not on the final message.
    const o = new StreamObserver();
    o.observe({
      type: "message_start",
      message: {
        model: "claude-opus-5",
        usage: {
          input_tokens: 2140,
          cache_read_input_tokens: 48500,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
    o.observe({ type: "message_delta", usage: { output_tokens: 188 } });

    const r = o.result();
    assert.equal(r.usage?.inputTokens, 2140);
    assert.equal(r.usage?.cacheReadTokens, 48500);
    assert.equal(r.usage?.outputTokens, 188);
    assert.equal(r.responseModel, "claude-opus-5");
  });

  test("TTFT is measured from the first CONTENT delta, not message_start", async () => {
    const o = new StreamObserver();
    o.observe({ type: "message_start", message: { usage: { input_tokens: 10 } } });
    await sleep(25);
    o.observe({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } });

    const ttftMs = o.result().ttftNs! / 1e6;
    // message_start carries metadata, not content — counting it as TTFT would
    // understate perceived latency.
    assert.ok(ttftMs >= 20, `expected >=20ms, got ${ttftMs.toFixed(1)}ms`);
  });

  test("counts chunks and records the finish reason", () => {
    const o = new StreamObserver();
    o.observe({ type: "message_start", message: { usage: { input_tokens: 1 } } });
    for (let i = 0; i < 5; i++) o.observe({ type: "content_block_delta", delta: {} });
    o.observe({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });

    const r = o.result();
    assert.equal(r.chunkCount, 5);
    assert.equal(r.finishReason, "end_turn");
  });

  test("caps sampled offsets so a long completion cannot bloat the span", () => {
    const o = new StreamObserver();
    for (let i = 0; i < 5000; i++) o.observe({ type: "content_block_delta", delta: {} });
    const r = o.result();
    assert.equal(r.chunkCount, 5000);
    assert.ok(r.chunkOffsetsNs.length <= 256, `offsets=${r.chunkOffsetsNs.length}`);
  });
});

describe("StreamObserver — OpenAI events", () => {
  test("reads cached_tokens from prompt_tokens_details", () => {
    const o = new StreamObserver();
    o.observe({ model: "gpt-4o", choices: [{ delta: { content: "hi" } }] });
    o.observe({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 768 } },
    });

    const r = o.result();
    assert.equal(r.usage?.inputTokens, 900);
    assert.equal(r.usage?.cacheReadTokens, 768);
    assert.equal(r.finishReason, "stop");
  });
});

describe("StreamObserver — robustness", () => {
  test("malformed events never throw", () => {
    const o = new StreamObserver();
    for (const bad of [null, undefined, 42, "text", {}, { type: "unknown" }, { choices: null }]) {
      assert.doesNotThrow(() => o.observe(bad));
    }
    assert.equal(o.result().chunkCount, 0);
  });

  test("no usage reported yields null rather than a fabricated zero", () => {
    const o = new StreamObserver();
    o.observe({ type: "content_block_delta", delta: {} });
    assert.equal(o.result().usage, null);
  });
});

describe("observeStream", () => {
  test("passes every chunk through unchanged and in order", async () => {
    const src = (async function* () {
      yield { type: "content_block_delta", delta: { text: "a" } };
      yield { type: "content_block_delta", delta: { text: "b" } };
      yield { type: "content_block_delta", delta: { text: "c" } };
    })();

    const o = new StreamObserver();
    const seen: unknown[] = [];
    for await (const c of observeStream(src, o)) seen.push(c);

    assert.equal(seen.length, 3);
    assert.equal((seen[0] as any).delta.text, "a");
    assert.equal((seen[2] as any).delta.text, "c");
    assert.equal(o.result().chunkCount, 3);
  });

  test("does not delay chunk delivery", async () => {
    // Observation must happen on the same tick — the point of streaming is
    // perceived responsiveness, and an observability layer that buffered
    // tokens would defeat it.
    const src = (async function* () {
      for (let i = 0; i < 200; i++) yield { type: "content_block_delta", delta: {} };
    })();

    const t0 = process.hrtime.bigint();
    let count = 0;
    for await (const _ of observeStream(src, new StreamObserver())) count++;
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

    assert.equal(count, 200);
    assert.ok(elapsedMs < 50, `200 chunks took ${elapsedMs.toFixed(1)}ms`);
  });
});
