import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
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

export function registerIngestRoutes(
  app: FastifyInstance,
  sql: Sql,
  config: Config,
  blobs: BlobStore | null,
): void {
  app.post("/v1/traces", {
    config: {
      rateLimit: {
        max: config.RATE_LIMIT_INGEST_PER_MIN,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    // --- auth -----------------------------------------------------------
    const auth = request.headers.authorization;
    const presented = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!presented) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Missing Bearer token. Pass your project ingest key.",
      });
    }

    const keyHash = hashKey(presented);
    const [project] = await sql<{ id: string; api_key_hash: string }[]>`
      SELECT id, api_key_hash FROM projects WHERE api_key_hash = ${keyHash} LIMIT 1
    `;
    if (!project || !safeEqual(project.api_key_hash, keyHash)) {
      return reply.code(401).send({ error: "unauthorized", message: "Invalid ingest key." });
    }

    // --- validate -------------------------------------------------------
    // Same zod schema the SDK serialised from, imported from the protocol
    // package. A protocol change is a compile error on both sides rather than
    // a runtime surprise here.
    const parsed = IngestBatch.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_batch",
        message: "Batch failed schema validation.",
        details: parsed.error.issues.slice(0, 20).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const batch = parsed.data;

    // --- backpressure ---------------------------------------------------
    // Shed load rather than queue without bound. The SDK's own buffer absorbs
    // this, and an explicit 503 + Retry-After is far better than an OOM.
    if (batch.spans.length > config.MAX_QUEUE_DEPTH) {
      return reply
        .code(503)
        .header("Retry-After", "2")
        .send({ error: "overloaded", message: "Batch exceeds queue capacity." });
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
      return reply.code(429).send({
        error: "quota_exceeded",
        message:
          `Project has reached its span limit (${config.MAX_SPANS_PER_PROJECT}). ` +
          `Delete old traces or raise MAX_SPANS_PER_PROJECT.`,
      });
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
        request.log.error({ err }, "payload offload failed — keeping inline");
      }
    }

    await sql.begin(async (tx) => {
      await upsertTraces(tx, project.id, batch.traces);
      await insertSpans(tx, spans);
      await recordDroppedSpans(tx, traceIds, batch.droppedSpans);
      await recomputeRollups(tx, traceIds);
    });

    return reply.code(202).send({
      accepted: spans.length,
      uploaded,
      deduped,
      ...(offloadError ? { offloadError } : {}),
    });
  });
}
