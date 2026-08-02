import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildSpanTree, type Span } from "@llm-inspector/protocol";
import type { Sql } from "../db/client.js";
import type { BlobStore } from "../storage/blobs.js";

const ListQuery = z.object({
  projectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Cursor: ISO timestamp of the last trace seen. Keyset, not OFFSET. */
  before: z.iso.datetime().optional(),
  status: z.enum(["ok", "error", "cancelled", "in_progress"]).optional(),
});

export function registerQueryRoutes(
  app: FastifyInstance,
  sql: Sql,
  blobs: BlobStore | null = null,
): void {
  /**
   * Trace list. Hits only the `traces` table — never aggregates over spans,
   * which is why rollups are denormalised at ingest.
   *
   * Keyset pagination (`started_at < cursor`) rather than OFFSET: OFFSET scans
   * and discards rows, so deep pages get progressively slower, and rows shifting
   * between requests cause items to be skipped or repeated.
   */
  app.get("/v1/traces", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", message: parsed.error.message });
    }
    const { projectId, limit, before, status } = parsed.data;

    const rows = await sql`
      SELECT id, project_id, name, started_at, ended_at, duration_ms, status,
             total_tokens, total_cost_usd, span_count, error_count, dropped_spans,
             metadata
      FROM traces
      WHERE TRUE
        ${projectId ? sql`AND project_id = ${projectId}` : sql``}
        ${before ? sql`AND started_at < ${before}` : sql``}
        ${status ? sql`AND status = ${status}` : sql``}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;

    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.started_at : null;
    return reply.send({ traces: rows, nextCursor });
  });

  /**
   * Full trace with its span tree.
   *
   * Flat SELECT plus in-memory assembly, deliberately not a recursive CTE:
   * traces are small (hundreds to low thousands of spans), the flat fetch uses
   * the (trace_id, start_ns) index directly, and the same buildSpanTree() runs
   * in the browser — one implementation, tested once.
   */
  app.get<{ Params: { id: string } }>("/v1/traces/:id", async (request, reply) => {
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) {
      return reply.code(400).send({ error: "invalid_id", message: "Malformed trace id." });
    }

    const [trace] = await sql`SELECT * FROM traces WHERE id = ${id.data} LIMIT 1`;
    if (!trace) {
      return reply.code(404).send({ error: "not_found", message: "No such trace." });
    }

    const rows = await sql`
      SELECT * FROM spans WHERE trace_id = ${id.data} ORDER BY start_ns ASC
    `;

    const spans: Span[] = rows.map(rowToSpan);
    return reply.send({ trace, spans, tree: buildSpanTree(spans) });
  });

  /**
   * Fetch an offloaded payload on demand.
   *
   * This endpoint is the reason payloads are offloaded at all: the trace list
   * and the waterfall never pay for prompt or completion bytes, because they
   * are only pulled when a user actually clicks a span to inspect it.
   */
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>(
    "/v1/spans/:id/payload",
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success) {
        return reply.code(400).send({ error: "invalid_id", message: "Malformed span id." });
      }

      const [row] = await sql<{ payloads: Record<string, any> }[]>`
        SELECT payloads FROM spans WHERE id = ${id.data} LIMIT 1
      `;
      if (!row) return reply.code(404).send({ error: "not_found", message: "No such span." });

      const key = request.query.key;
      const entries = key ? { [key]: row.payloads[key] } : row.payloads;
      const out: Record<string, unknown> = {};

      for (const [k, p] of Object.entries(entries)) {
        if (!p) continue;
        if (p.storage === "inline") {
          out[k] = p.data;
        } else if (blobs) {
          try {
            out[k] = await blobs.fetch(p.ref);
          } catch (err) {
            request.log.error({ err, ref: p.ref }, "payload fetch failed");
            out[k] = { __error: "payload unavailable" };
          }
        } else {
          out[k] = { __error: "object storage not configured" };
        }
      }

      return reply.send({ payloads: out });
    },
  );

  /**
   * Storage stats — how much the content-addressed dedup and gzip are saving.
   *
   * Worth exposing rather than hiding: on a 0.5 GB free tier this ratio is the
   * difference between a usable tool and one that fills up mid-demo.
   */
  app.get("/v1/stats/storage", async (_request, reply) => {
    const [stats] = await sql<
      { blobs: string; logical_bytes: string; stored_bytes: string; total_refs: string }[]
    >`
      SELECT COUNT(*)::text AS blobs,
             COALESCE(SUM(size_bytes * ref_count), 0)::text AS logical_bytes,
             COALESCE(SUM(stored_bytes), 0)::text AS stored_bytes,
             COALESCE(SUM(ref_count), 0)::text AS total_refs
      FROM payload_blobs
    `;

    const logical = Number(stats?.logical_bytes ?? 0);
    const stored = Number(stats?.stored_bytes ?? 0);

    return reply.send({
      blobs: Number(stats?.blobs ?? 0),
      totalReferences: Number(stats?.total_refs ?? 0),
      logicalBytes: logical,
      storedBytes: stored,
      // Combined effect of dedup (same content stored once) and gzip.
      compressionRatio: stored > 0 ? Number((logical / stored).toFixed(2)) : null,
      bytesSaved: Math.max(0, logical - stored),
    });
  });
}

/**
 * Map a DB row back to the protocol shape.
 *
 * BIGINT columns arrive as strings from postgres.js (they can exceed 2^53), so
 * they are converted explicitly here rather than being implicitly coerced.
 */
function rowToSpan(row: Record<string, unknown>): Span {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

  const usage =
    row.input_tokens === null && row.output_tokens === null
      ? null
      : {
          inputTokens: num(row.input_tokens) ?? 0,
          outputTokens: num(row.output_tokens) ?? 0,
          cacheReadTokens: num(row.cache_read_tokens) ?? 0,
          cacheCreationTokens: num(row.cache_creation_tokens) ?? 0,
        };

  const ttft = num(row.ttft_ns);

  return {
    id: row.id as string,
    traceId: row.trace_id as string,
    parentSpanId: (row.parent_span_id as string | null) ?? null,
    kind: row.kind as Span["kind"],
    name: row.name as string,
    startNs: Number(row.start_ns),
    endNs: num(row.end_ns),
    status: row.status as Span["status"],
    error: (row.error as Span["error"]) ?? null,
    attempt: Number(row.attempt),
    usage,
    timing: ttft === null ? null : { ttftNs: ttft },
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    attributes: (row.attrs as Span["attributes"]) ?? {},
    payloads: (row.payloads as Span["payloads"]) ?? {},
  };
}
