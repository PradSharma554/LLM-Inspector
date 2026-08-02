import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Exporter } from "./exporter.js";
import type { Span } from "@llm-inspector/protocol";

const span = (): Span => ({
  id: randomUUID(), traceId: randomUUID(), parentSpanId: null,
  kind: "custom", name: "s", startNs: 0, endNs: 1000,
  status: "ok", error: null, attempt: 1,
  usage: null, timing: null, costUsd: null, attributes: {}, payloads: {},
});

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Exporter", () => {
  test("flushes once the batch size is reached", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_u: any, init: any) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
    }) as any;

    const e = new Exporter({ endpoint: "http://x", apiKey: "k", batchSize: 3, flushIntervalMs: 60_000 });
    e.recordSpan(span());
    e.recordSpan(span());
    assert.equal(bodies.length, 0, "should not flush before batchSize");
    e.recordSpan(span());
    await e.flush();

    assert.equal(bodies.length, 1);
    assert.equal(JSON.parse(bodies[0]!).spans.length, 3);
    await e.shutdown();
  });

  test("drops OLDEST spans past the cap and counts them", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 202 })) as any;
    // Bounded buffer is deliberate: an unbounded one turns a collector outage
    // into an OOM in the host application.
    const e = new Exporter({
      endpoint: "http://x", apiKey: "k",
      batchSize: 10_000, flushIntervalMs: 60_000, maxBufferSize: 5,
    });

    const ids: string[] = [];
    for (let i = 0; i < 8; i++) { const s = span(); ids.push(s.id); e.recordSpan(s); }

    assert.equal(e.stats.buffered, 5);
    assert.equal(e.stats.dropped, 3);
    await e.shutdown();
  });

  test("never throws when the collector is unreachable", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    const errors: unknown[] = [];
    const e = new Exporter({
      endpoint: "http://x", apiKey: "k", batchSize: 1,
      flushIntervalMs: 60_000, onError: (err) => errors.push(err),
    });

    // An observability tool that can break the host app is worse than none.
    assert.doesNotThrow(() => e.recordSpan(span()));
    await e.flush();
    assert.ok(errors.length > 0, "error should surface via onError, not a throw");
    await e.shutdown();
  });

  test("re-buffers on 503 so a transient outage does not lose data", async () => {
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt++;
      return attempt === 1
        ? new Response("{}", { status: 503 })
        : new Response("{}", { status: 202 });
    }) as any;

    const e = new Exporter({ endpoint: "http://x", apiKey: "k", batchSize: 100, flushIntervalMs: 60_000 });
    e.recordSpan(span());
    e.recordSpan(span());

    await e.flush();
    assert.equal(e.stats.buffered, 2, "spans should return to the buffer after 503");

    await e.flush();
    assert.equal(e.stats.buffered, 0, "second attempt should succeed");
    await e.shutdown();
  });

  test("does NOT re-buffer on 401 — retrying a bad key would loop forever", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as any;
    const e = new Exporter({
      endpoint: "http://x", apiKey: "bad", batchSize: 100,
      flushIntervalMs: 60_000, onError: () => {},
    });
    e.recordSpan(span());
    await e.flush();
    assert.equal(e.stats.buffered, 0);
    await e.shutdown();
  });

  test("sends the protocol version and bearer auth", async () => {
    let captured: any = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      return new Response("{}", { status: 202 });
    }) as any;

    const e = new Exporter({ endpoint: "http://collector/", apiKey: "insp_secret", batchSize: 1, flushIntervalMs: 60_000 });
    e.recordSpan(span());
    await e.flush();

    assert.equal(captured.url, "http://collector/v1/traces", "trailing slash normalised");
    assert.equal(captured.headers.authorization, "Bearer insp_secret");
    assert.equal(captured.body.v, 1);
    await e.shutdown();
  });

  test("concurrent flushes do not double-send", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response("{}", { status: 202 });
    }) as any;

    const e = new Exporter({ endpoint: "http://x", apiKey: "k", batchSize: 1000, flushIntervalMs: 60_000 });
    e.recordSpan(span());
    await Promise.all([e.flush(), e.flush(), e.flush()]);
    assert.equal(calls, 1);
    await e.shutdown();
  });
});
