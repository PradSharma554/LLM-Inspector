import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { IngestBatch } from "@llm-inspector/protocol";
import type { Sql } from "../db/client.js";
import {
  insertSpans,
  recomputeRollups,
  recordDroppedSpans,
  upsertTraces,
} from "../db/spans.js";
import type { Config } from "../config.js";
import type { BlobStore } from "../storage/blobs.js";

/** SHA-256 of the presented key, compared against the stored hash. */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Constant-time comparison, to avoid leaking key material through timing.
 * Both sides are fixed-length hex digests, so length mismatch is itself a
 * failure rather than something to pad around.
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Rate-limit key: the API key for authenticated ingest, the IP otherwise.
 *
 * Keying ingest on the key rather than the IP matters: a legitimate SDK behind
 * a corporate NAT shares one IP with everyone else there, so an IP-keyed limit
 * would throttle honest users while a leaked key spread across many IPs would
 * slip straight through.
 *
 * The unauthenticated fallback runs the IP through `ipKeyGenerator`, which
 * buckets IPv6 by /64. A bare `req.ip` would be a bypass: a single IPv6 client
 * is routinely handed a whole /64, so it could take a fresh address per request
 * and never hit the limit at all.
 */
function ingestKeyGenerator(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return `k:${auth.slice(7, 39)}`;
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

export function registerIngestRoutes(
  app: Express,
  sql: Sql,
  config: Config,
  blobs: BlobStore | null,
): void {
  /**
   * In-memory, so the counter is per-instance. Fine for a single Render
   * service; a multi-instance deployment would move this to Redis.
   */
  const ingestLimit = rateLimit({
    windowMs: 60_000,
    limit: config.RATE_LIMIT_INGEST_PER_MIN,
    keyGenerator: ingestKeyGenerator,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  app.post("/v1/traces", ingestLimit, async (req, res) => {
    // --- auth -----------------------------------------------------------
    const auth = req.headers.authorization;
    const presented = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!presented) {
      res.status(401).json({
        error: "unauthorized",
        message: "Missing Bearer token. Pass your project ingest key.",
      });
      return;
    }

    const keyHash = hashKey(presented);
    const [project] = await sql<{ id: string; api_key_hash: string }[]>`
      SELECT id, api_key_hash FROM projects WHERE api_key_hash = ${keyHash} LIMIT 1
    `;
    if (!project || !safeEqual(project.api_key_hash, keyHash)) {
      res.status(401).json({ error: "unauthorized", message: "Invalid ingest key." });
      return;
    }

    // --- validate -------------------------------------------------------
    // Same zod schema the SDK serialised from, imported from the protocol
    // package. A protocol change is a compile error on both sides rather than
    // a runtime surprise here.
    const parsed = IngestBatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_batch",
        message: "Batch failed schema validation.",
        details: parsed.error.issues.slice(0, 20).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const batch = parsed.data;

    // --- backpressure ---------------------------------------------------
    // Shed load rather than queue without bound. The SDK's own buffer absorbs
    // this, and an explicit 503 + Retry-After is far better than an OOM.
    if (batch.spans.length > config.MAX_QUEUE_DEPTH) {
      res
        .status(503)
        .set("Retry-After", "2")
        .json({ error: "overloaded", message: "Batch exceeds queue capacity." });
      return;
    }

    // --- storage quota ----------------------------------------------------
    // The rate limit caps requests per minute; this caps total stored data.
    // Without it, a leaked ingest key could fill Neon's 0.5 GB free tier at a
    // perfectly polite request rate and take the demo down.
    //
    // Counted from the denormalised rollup on `traces` rather than
    // COUNT(*) FROM spans, so this is an index-only scan of a small table
    // instead of a full scan of the largest one on every ingest.
    const [usage] = await sql<{ spans: string }[]>`
      SELECT COALESCE(SUM(span_count), 0)::text AS spans
      FROM traces WHERE project_id = ${project.id}
    `;
    if (Number(usage?.spans ?? 0) >= config.MAX_SPANS_PER_PROJECT) {
      res.status(429).json({
        error: "quota_exceeded",
        message:
          `Project has reached its span limit (${config.MAX_SPANS_PER_PROJECT}). ` +
          `Delete old traces or raise MAX_SPANS_PER_PROJECT.`,
      });
      return;
    }

    // --- write ----------------------------------------------------------
    // Traces first: spans reference them via FK. Within a transaction so a
    // partial batch never lands.
    const traceIds = [
      ...new Set([...batch.traces.map((t) => t.id), ...batch.spans.map((s) => s.traceId)]),
    ];

    // Offload large payloads to object storage BEFORE the transaction, so a
    // slow upload does not hold a Postgres transaction open. Uploads run
    // concurrently — they are I/O-bound, which is what the event loop is for.
    let spans = batch.spans;
    let uploaded = 0;
    let deduped = 0;
    let offloadError: string | null = null;

    if (blobs) {
      try {
        const results = await Promise.all(
          batch.spans.map((s) => blobs.offloadSpanPayloads(sql, s)),
        );
        spans = batch.spans.map((s, i) => ({ ...s, payloads: results[i]!.payloads }));
        for (const r of results) {
          uploaded += r.uploaded;
          deduped += r.deduped;
        }
      } catch (err) {
        // Storage failure must not lose the span. Keep payloads inline and
        // carry on: degraded observability beats dropped observability.
        //
        // But do NOT hide it. This swallow once masked a misconfigured bucket
        // name for an entire debugging session: uploads threw, spans still
        // returned 202, and the only outward symptom was a stubbornly empty
        // blob ledger. The reason is echoed in the response so a caller can
        // see it without access to the server logs.
        offloadError = err instanceof Error ? err.name : "unknown";
        req.log.error({ err }, "payload offload failed — keeping inline");
      }
    }

    await sql.begin(async (tx) => {
      await upsertTraces(tx, project.id, batch.traces);
      await insertSpans(tx, spans);
      await recordDroppedSpans(tx, traceIds, batch.droppedSpans);
      await recomputeRollups(tx, traceIds);
    });

    res.status(202).json({
      accepted: spans.length,
      uploaded,
      deduped,
      ...(offloadError ? { offloadError } : {}),
    });
  });
}
