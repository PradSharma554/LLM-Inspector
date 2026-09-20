import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import type { Sql } from "./db/client.js";

/**
 * HTTP-level tests for the collector.
 *
 * These cover the parts that live in the framework rather than in a pure
 * function: routing, middleware order, auth, body limits, rate limiting and
 * the error handler. None of it is reachable from a unit test of a helper,
 * and all of it is what actually faces the internet.
 *
 * The database is faked. The point here is the HTTP layer, and a fake keeps
 * the suite runnable in CI with no Postgres and no fixtures to reset between
 * runs. The SQL itself is exercised by running the collector for real.
 */

const KEY = "insp_testkey";
const KEY_HASH = createHash("sha256").update(KEY).digest("hex");
const PROJECT_ID = randomUUID();

/** Set by a test to make every query reject, for the readiness path. */
let dbFails = false;

/**
 * Minimal postgres.js stand-in.
 *
 * postgres.js is a tagged-template function with helper methods hung off it,
 * so the fake matches that shape: dispatch on the query text, and provide the
 * `json`/`begin` helpers the repository layer reaches for.
 */
function makeSql(): Sql {
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (dbFails) return Promise.reject(new Error("database unreachable"));
    const q = strings.join("?");

    if (q.includes("api_key_hash")) {
      return Promise.resolve(
        vals[0] === KEY_HASH ? [{ id: PROJECT_ID, api_key_hash: KEY_HASH }] : [],
      );
    }
    if (q.includes("SUM(span_count)")) return Promise.resolve([{ spans: "0" }]);
    if (q.includes("payload_blobs")) {
      return Promise.resolve([
        { blobs: "2", logical_bytes: "41480", stored_bytes: "253", total_refs: "3" },
      ]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;

  const helpers = sql as unknown as Record<string, unknown>;
  helpers.json = (v: unknown) => v;
  helpers.array = (v: unknown) => v;
  helpers.begin = async (fn: (tx: Sql) => Promise<unknown>) => fn(sql);
  helpers.end = async () => {};
  return sql;
}

const config: Config = {
  DATABASE_URL: "postgres://fake",
  PORT: 0,
  HOST: "127.0.0.1",
  LOG_LEVEL: "silent" as Config["LOG_LEVEL"],
  TRUST_PROXY_HOPS: 1,
  PAYLOAD_INLINE_LIMIT_BYTES: 4096,
  MAX_QUEUE_DEPTH: 10_000,
  // Small on purpose so the 413 and 429 paths are reachable in a test.
  BODY_LIMIT_BYTES: 2048,
  S3_REGION: "auto",
  RATE_LIMIT_INGEST_PER_MIN: 5,
  RATE_LIMIT_READ_PER_MIN: 300,
  MAX_SPANS_PER_PROJECT: 250_000,
  MAX_STORAGE_BYTES: 5 * 1024 * 1024 * 1024,
  MAX_PAYLOAD_BYTES: 1024 * 1024,
} as Config;

let server: Server;
let base: string;

before(async () => {
  const { app } = buildApp(config, makeSql());
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeIdleConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

/** A schema-valid batch, so tests exercise the write path rather than validation. */
function validBatch() {
  const traceId = randomUUID();
  return {
    v: 1,
    traces: [
      {
        id: traceId,
        projectId: PROJECT_ID,
        name: "t",
        startedAt: new Date().toISOString(),
        metadata: {},
      },
    ],
    spans: [
      {
        id: randomUUID(),
        traceId,
        parentSpanId: null,
        kind: "llm_call",
        name: "chat",
        startNs: 0,
        endNs: 1000,
        status: "ok",
        error: null,
        attempt: 1,
        usage: null,
        timing: null,
        costUsd: null,
        attributes: {},
        payloads: {},
      },
    ],
    droppedSpans: 0,
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const auth = { authorization: `Bearer ${KEY}` };

describe("health and readiness", () => {
  test("/health does not touch the database", async () => {
    // Proven by making every query fail: /health must still answer.
    dbFails = true;
    const res = await fetch(`${base}/health`);
    dbFails = false;

    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; uptime: number };
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptime, "number");
  });

  test("/ready reports reachable when the database answers", async () => {
    const res = await fetch(`${base}/ready`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { database: string }).database, "reachable");
  });

  test("/ready returns 503 when the database is down", async () => {
    dbFails = true;
    const res = await fetch(`${base}/ready`);
    dbFails = false;

    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { database: string }).database, "unreachable");
  });
});

describe("ingest auth", () => {
  test("rejects a request with no bearer token", async () => {
    const res = await post(validBatch());
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "unauthorized");
  });

  test("rejects an unknown key", async () => {
    const res = await post(validBatch(), { authorization: "Bearer insp_wrong" });
    assert.equal(res.status, 401);
  });

  test("accepts a valid key", async () => {
    const res = await post(validBatch(), auth);
    assert.equal(res.status, 202);
    assert.equal(((await res.json()) as { accepted: number }).accepted, 1);
  });
});

describe("ingest validation", () => {
  test("rejects a batch that fails the shared schema", async () => {
    const res = await post({ nonsense: true }, auth);
    assert.equal(res.status, 400);

    const body = (await res.json()) as { error: string; details: unknown[] };
    assert.equal(body.error, "invalid_batch");
    assert.ok(Array.isArray(body.details), "should report which fields failed");
  });

  test("malformed JSON is a 400, not a 500", async () => {
    // Regression guard: a body that fails to parse reaches the error handler,
    // which must classify it as a bad request rather than a server fault.
    const res = await post("{not json", auth);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_json");
  });

  test("a body over the limit is refused with 413", async () => {
    const res = await post({ pad: "x".repeat(config.BODY_LIMIT_BYTES * 2) }, auth);
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: string }).error, "payload_too_large");
  });
});

describe("rate limiting", () => {
  test("throttles once the per-key ingest budget is spent", async () => {
    // A key of its own, so this does not consume another test's budget.
    const key = "insp_ratelimit_probe";
    let sawLimit = false;

    for (let i = 0; i < config.RATE_LIMIT_INGEST_PER_MIN + 3; i++) {
      const res = await post(validBatch(), { authorization: `Bearer ${key}` });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    assert.ok(sawLimit, "expected a 429 once the budget was exhausted");
  });

  test("a forged X-Forwarded-For cannot mint a fresh budget", async () => {
    /**
     * The regression this exists for.
     *
     * X-Forwarded-For is client-supplied. With `trust proxy: true` Express
     * believes the whole chain, so a caller could put a new address in front
     * on every request and never exhaust an IP-keyed limit. Trusting a hop
     * COUNT instead means only what our own proxy appended is believed, and
     * all of these requests land in one bucket.
     */
    const remaining: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${base}/v1/traces`, {
        headers: { "x-forwarded-for": `198.51.100.${i}, 9.9.9.9` },
      });
      const header = res.headers.get("ratelimit");
      const m = header?.match(/r=(\d+)/);
      if (m) remaining.push(Number(m[1]));
    }

    assert.equal(remaining.length, 3, "expected a RateLimit header on each response");
    assert.ok(
      remaining[1]! < remaining[0]! && remaining[2]! < remaining[1]!,
      `forged addresses shared a bucket? remaining went ${remaining.join(" -> ")}`,
    );
  });
});

describe("query routes", () => {
  test("lists traces", async () => {
    const res = await fetch(`${base}/v1/traces`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(((await res.json()) as { traces: unknown[] }).traces));
  });

  test("rejects an out-of-range limit", async () => {
    const res = await fetch(`${base}/v1/traces?limit=9999`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_query");
  });

  test("rejects a malformed trace id", async () => {
    const res = await fetch(`${base}/v1/traces/not-a-uuid`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_id");
  });

  test("returns 404 for a trace that does not exist", async () => {
    const res = await fetch(`${base}/v1/traces/${randomUUID()}`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "not_found");
  });

  test("reports storage savings", async () => {
    const res = await fetch(`${base}/v1/stats/storage`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { compressionRatio: number; bytesSaved: number };
    assert.equal(body.compressionRatio, 163.95);
    assert.equal(body.bytesSaved, 41_227);
  });

  test("says so when object storage is not configured", async () => {
    // The symptom this surfaces is otherwise invisible from outside: payloads
    // quietly stay inline and the blob ledger just looks empty.
    const res = await fetch(`${base}/v1/stats/storage`);
    assert.equal(((await res.json()) as { objectStorage: string }).objectStorage, "not_configured");
  });
});

describe("hardening", () => {
  test("does not advertise the framework", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  test("an unknown route is a 404", async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test("CORS reflects the requesting origin", async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: "http://localhost:3000" } });
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });
});
