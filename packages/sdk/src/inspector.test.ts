import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Inspector } from "./inspector.js";
import type { Span } from "@llm-inspector/protocol";

/** Capture spans by intercepting fetch, so we test the real export path. */
function capturing() {
  const spans: Span[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    spans.push(...body.spans);
    return new Response(JSON.stringify({ accepted: body.spans.length }), { status: 202 });
  }) as any;
  return spans;
}

/** Minimal stand-in for @anthropic-ai/sdk — the SDK must not depend on it. */
class FakeAnthropic {
  messages = {
    create: async (params: any) => {
      if (params.__fail) throw Object.assign(new Error("Overloaded"), { status: 529 });
      return {
        model: "claude-opus-5",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
      };
    },
    stream: (_params: any) => {
      async function* gen() {
        yield { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 0 } } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "a" } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "b" } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } };
      }
      const it = gen();
      return {
        [Symbol.asyncIterator]: () => it,
        finalMessage: async () => ({ model: "claude-opus-5", usage: { input_tokens: 50, output_tokens: 2 } }),
        customHelper: () => "still here",
      };
    },
  };
  // A method we do not instrument — must survive wrapping untouched.
  countTokens = async () => ({ input_tokens: 7 });
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

const newInspector = () =>
  new Inspector({ endpoint: "http://x", apiKey: "k", batchSize: 1000, flushIntervalMs: 60_000 });

describe("Inspector.wrap", () => {
  test("traces a non-streaming call with cache-aware cost", async () => {
    const spans = capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());

    await insp.trace("test", async () => {
      await client.messages.create({ model: "claude-opus-5", max_tokens: 100 });
    });
    await insp.shutdown();

    const llm = spans.find((s) => s.kind === "llm_call")!;
    assert.ok(llm, "an llm_call span should be recorded");
    assert.equal(llm.name, "chat claude-opus-5", "OTel span-name convention");
    assert.equal(llm.attributes["gen_ai.provider.name"], "anthropic");
    assert.equal(llm.usage?.cacheReadTokens, 4000);

    // 100 uncached + 4000 cached@0.1x + 20 out, at $5/$25 per MTok
    const expected = (100 * 5 + 4000 * 5 * 0.1 + 20 * 25) / 1e6;
    assert.ok(Math.abs(llm.costUsd! - expected) < 1e-12, `cost ${llm.costUsd} != ${expected}`);
  });

  test("captures TTFT and usage from a stream", async () => {
    const spans = capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());

    await insp.trace("test", async () => {
      const stream = client.messages.stream({ model: "claude-opus-5" });
      for await (const _ of stream as AsyncIterable<unknown>) { /* consume */ }
    });
    await insp.shutdown();

    const llm = spans.find((s) => s.kind === "llm_call")!;
    assert.ok(llm.timing?.ttftNs != null, "TTFT must be captured — only observable from the stream");
    assert.equal(llm.timing?.chunkCount, 2);
    assert.equal(llm.usage?.cacheReadTokens, 1000);
    assert.equal(llm.usage?.outputTokens, 2);
  });

  test("preserves helper methods on the stream object", async () => {
    capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());

    await insp.trace("test", async () => {
      const stream: any = client.messages.stream({ model: "claude-opus-5" });
      // Replacing the helper with a bare generator would break every consumer
      // that calls finalMessage() or a provider-specific helper.
      assert.equal(stream.customHelper(), "still here");
      const msg = await stream.finalMessage();
      assert.equal(msg.model, "claude-opus-5");
    });
    await insp.shutdown();
  });

  test("passes uninstrumented methods straight through", async () => {
    capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());
    // Wrapping must never remove functionality.
    assert.deepEqual(await client.countTokens(), { input_tokens: 7 });
    await insp.shutdown();
  });

  test("records an error span and rethrows the user's error unchanged", async () => {
    const spans = capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());

    await assert.rejects(
      insp.trace("test", async () => {
        await client.messages.create({ model: "claude-opus-5", __fail: true });
      }),
      /Overloaded/,
    );
    await insp.shutdown();

    const llm = spans.find((s) => s.kind === "llm_call")!;
    assert.equal(llm.status, "error");
    assert.equal(llm.error?.statusCode, 529);
  });

  test("works untraced — calls outside a trace still execute", async () => {
    capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());
    const res = await client.messages.create({ model: "claude-opus-5" });
    assert.equal(res.model, "claude-opus-5");
    await insp.shutdown();
  });
});

describe("Inspector context propagation", () => {
  test("nests spans automatically across async boundaries", async () => {
    const spans = capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());

    await insp.trace("agent", async () => {
      await insp.span("retrieval", async (h) => {
        h.setPayload("chunks", { k: 3 });
        // Nested three frames deep — AsyncLocalStorage is what makes this
        // attach to the retrieval span without threading a context argument.
        await new Promise((r) => setTimeout(r, 1));
        await insp.span("rerank", async () => {
          await client.messages.create({ model: "claude-opus-5" });
        }, { kind: "custom" });
      }, { kind: "retrieval" });
    });
    await insp.shutdown();

    const root = spans.find((s) => s.name === "agent" && s.parentSpanId === null)!;
    const retrieval = spans.find((s) => s.name === "retrieval")!;
    const rerank = spans.find((s) => s.name === "rerank")!;
    const llm = spans.find((s) => s.kind === "llm_call")!;

    // trace() emits a root span so the waterfall has one bar spanning the
    // whole request, rather than a flat list of parentless siblings.
    assert.ok(root, "trace() should emit a root span");
    assert.equal(retrieval.parentSpanId, root.id, "top-level work nests under the root");
    assert.equal(rerank.parentSpanId, retrieval.id, "rerank nests under retrieval");
    assert.equal(llm.parentSpanId, rerank.id, "model call nests under rerank");
    assert.equal(retrieval.payloads.chunks?.storage, "inline");
    // All three share one trace.
    assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  });

  test("concurrent traces do not interleave", async () => {
    const spans = capturing();
    const insp = newInspector();
    const client = insp.wrap(new FakeAnthropic());

    await Promise.all([
      insp.trace("a", async () => { await client.messages.create({ model: "claude-opus-5" }); }),
      insp.trace("b", async () => { await client.messages.create({ model: "claude-opus-5" }); }),
      insp.trace("c", async () => { await client.messages.create({ model: "claude-opus-5" }); }),
    ]);
    await insp.shutdown();

    const llms = spans.filter((s) => s.kind === "llm_call");
    assert.equal(llms.length, 3);
    // Each concurrent request must get its own trace — a module-level variable
    // instead of AsyncLocalStorage would collapse these into one.
    assert.equal(new Set(llms.map((s) => s.traceId)).size, 3);
  });

  test("timings are trace-relative and monotonic", async () => {
    const spans = capturing();
    const insp = newInspector();

    await insp.trace("t", async () => {
      await insp.span("first", async () => { await new Promise((r) => setTimeout(r, 5)); });
      await insp.span("second", async () => { await new Promise((r) => setTimeout(r, 5)); });
    });
    await insp.shutdown();

    const first = spans.find((s) => s.name === "first")!;
    const second = spans.find((s) => s.name === "second")!;
    assert.ok(first.startNs >= 0, "offsets are relative to trace start");
    assert.ok(second.startNs >= first.endNs!, "second starts after first ends");
    assert.ok(first.endNs! > first.startNs, "duration is positive");
  });

  test("disabled inspector adds no spans but still runs the work", async () => {
    const spans = capturing();
    const insp = new Inspector({ endpoint: "http://x", apiKey: "k", enabled: false });
    const client = insp.wrap(new FakeAnthropic());

    const res = await insp.trace("t", async () => client.messages.create({ model: "claude-opus-5" }));
    await insp.shutdown();

    assert.equal(res.model, "claude-opus-5");
    assert.equal(spans.length, 0);
  });
});
