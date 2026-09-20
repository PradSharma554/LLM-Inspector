import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import http, { type Server } from "node:http";
import express from "express";
import pino from "pino";
import { registerLiveRoutes } from "./live.js";
import type { LiveBus } from "../live/bus.js";
import type { Config } from "../config.js";
import type { LiveEvent } from "@llm-inspector/protocol";

/**
 * SSE route tests.
 *
 * The bus is faked: Redis pub/sub itself is not the interesting part here,
 * and requiring a live Redis would make the suite unrunnable in CI. What is
 * worth pinning down is the HTTP contract — the stream headers, the event
 * framing, per-project filtering, the capacity cap, the 503 when Redis is
 * absent, and above all that a disconnect unregisters its listener.
 */

/** Stand-in for LiveBus that lets a test drive events directly. */
function fakeBus() {
  const listeners = new Set<(e: LiveEvent) => void>();
  return {
    bus: {
      subscribe(fn: (e: LiveEvent) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      publish(e: LiveEvent) {
        for (const fn of listeners) fn(e);
      },
      get listenerCount() {
        return listeners.size;
      },
      async close() {},
    } as unknown as LiveBus,
    emit(e: LiveEvent) {
      for (const fn of listeners) fn(e);
    },
    get count() {
      return listeners.size;
    },
  };
}

const config = { MAX_LIVE_CLIENTS: 2 } as Config;

const event = (over: Partial<LiveEvent> = {}): LiveEvent =>
  ({
    type: "trace_updated",
    traceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    name: "POST /api/chat",
    status: "ok",
    startedAt: new Date().toISOString(),
    durationMs: 1200,
    spanCount: 7,
    errorCount: 0,
    totalTokens: 102_668,
    totalCostUsd: 0.081,
    at: new Date().toISOString(),
    ...over,
  }) as LiveEvent;

let server: Server;
let base: string;
let harness: ReturnType<typeof fakeBus>;

before(async () => {
  harness = fakeBus();
  const app = express();
  registerLiveRoutes(app, harness.bus, config);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  // An SSE response is an open socket by definition, and `server.close()`
  // waits for in-flight requests. Without forcing them shut the test process
  // never exits and the run dies on the file-level timeout instead of
  // reporting its results.
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/**
 * Open an SSE stream over a raw http request.
 *
 * `fetch` is the wrong tool here: its body is a web stream whose pending
 * `read()` keeps the event loop alive, so a test file that opens one never
 * lets the process exit and the run hangs instead of finishing. A raw
 * `http.get` hands back a socket that can be destroyed outright.
 */
function openStream(path = "/v1/live"): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  waitFor: (pred: (s: string) => boolean, ms?: number) => Promise<string>;
  ready: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, (res) => {
      let buffered = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffered += chunk;
      });
      res.on("error", () => {});

      const waitFor = async (pred: (s: string) => boolean, ms = 2000): Promise<string> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (pred(buffered)) return buffered;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`timed out waiting for frame; buffer was ${JSON.stringify(buffered)}`);
      };

      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        waitFor,
        ready: () => waitFor((b) => b.includes("connected")),
        close: () => {
          res.destroy();
          req.destroy();
        },
      });
    });
    req.on("error", reject);
  });
}

/** Read a non-streaming JSON response (the 503 paths). */
async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

/** Wait until the bus listener count settles at `want`. */
async function waitForListeners(want: number, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (harness.count !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("GET /v1/live", () => {
  test("opens an event stream with the right headers", async () => {
    const s = await openStream();
    assert.equal(s.status, 200);
    assert.match(String(s.headers["content-type"]), /text\/event-stream/);
    assert.match(String(s.headers["cache-control"]), /no-cache/);
    // Proxies that buffer would defeat the whole endpoint.
    assert.equal(s.headers["x-accel-buffering"], "no");
    s.close();
    await waitForListeners(0);
  });

  test("delivers a published event as a named SSE frame", async () => {
    const s = await openStream();
    await s.ready();
    harness.emit(event({ name: "live trace" }));

    const frame = await s.waitFor((b) => b.includes("event: trace_updated"));
    assert.match(frame, /event: trace_updated/);
    assert.match(frame, /data: /);

    const line = frame.split("\n").find((l) => l.startsWith("data: "))!;
    const parsed = JSON.parse(line.slice(6));
    assert.equal(parsed.name, "live trace");
    assert.equal(parsed.spanCount, 7);
    s.close();
    await waitForListeners(0);
  });

  test("projectId filters the feed", async () => {
    const mine = "33333333-3333-4333-8333-333333333333";
    const s = await openStream(`/v1/live?projectId=${mine}`);
    await s.ready();

    harness.emit(event({ projectId: "44444444-4444-4444-8444-444444444444", name: "other" }));
    harness.emit(event({ projectId: mine, name: "mine" }));

    const frame = await s.waitFor((b) => b.includes("mine"));
    assert.match(frame, /mine/);
    assert.doesNotMatch(frame, /other/, "must not leak another project's traces");
    s.close();
    await waitForListeners(0);
  });

  test("a disconnect unregisters its listener", async () => {
    // The leak that would otherwise accumulate one dead listener per closed
    // browser tab until the process is restarted.
    await waitForListeners(0);
    assert.equal(harness.count, 0, "precondition: no listeners left by earlier tests");

    const s = await openStream();
    await s.ready();
    assert.equal(harness.count, 1, "listener should be registered while open");

    s.close();

    // The server learns of the disconnect asynchronously, so poll rather than
    // sleeping a fixed amount and hoping.
    await waitForListeners(0);
    assert.equal(harness.count, 0, "listener should be gone after disconnect");
  });

  test("refuses connections past the capacity cap", async () => {
    await waitForListeners(0);

    const open = [];
    for (let i = 0; i < config.MAX_LIVE_CLIENTS; i++) {
      const s = await openStream();
      await s.ready();
      open.push(s);
    }

    const res = await getJson(`${base}/v1/live`);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "too_many_clients");

    for (const s of open) s.close();
    await waitForListeners(0);
  });
});

describe("GET /v1/live without Redis", () => {
  let noRedis: Server;
  let noRedisBase: string;

  before(async () => {
    const app = express();
    // Null bus is the production state today: Redis is not provisioned there.
    registerLiveRoutes(app, null, config);
    noRedis = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => noRedis.once("listening", () => r()));
    noRedisBase = `http://127.0.0.1:${(noRedis.address() as AddressInfo).port}`;
  });

  after(async () => {
    noRedis.closeAllConnections();
    await new Promise<void>((r) => noRedis.close(() => r()));
  });

  test("reports 503 rather than holding a stream that can never emit", async () => {
    const res = await getJson(`${noRedisBase}/v1/live`);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "live_unavailable");
    assert.match(res.body.message, /REDIS_URL/);
  });
});

describe("LiveBus without a reachable Redis", () => {
  test("constructing against a dead address does not throw or crash", async () => {
    // The whole point of the optional dependency: a misconfigured or down
    // Redis degrades the live view and leaves the collector serving.
    const { LiveBus } = await import("../live/bus.js");
    const log = pino({ level: "silent" });

    const bus = new LiveBus("redis://127.0.0.1:1", log);
    bus.publish(event());                       // must not throw
    await new Promise((r) => setTimeout(r, 200));
    await bus.close();
  });
});
