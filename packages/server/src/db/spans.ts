import type { Span, Trace, TraceRollup } from "@llm-inspector/protocol";
import { computeCostUsd, totalTokens } from "@llm-inspector/protocol";
import type { Queryable } from "./client.js";

/**
 * Insert a batch of spans in a single round trip.
 *
 * Uses `INSERT ... SELECT * FROM UNNEST($1::type[], $2::type[], ...)`, which is
 * the Postgres-native way to insert N rows from a driver without COPY support.
 * The obvious alternative — a loop of single-row INSERTs — costs N round trips,
 * and over a hosted database like Neon that latency dominates everything else.
 *
 * Idempotent by primary key: a retried batch (SDK flushed, got a timeout,
 * flushed again) updates rather than erroring, so at-least-once delivery from
 * the SDK does not produce duplicates.
 */
export async function insertSpans(sql: Queryable, spans: readonly Span[]): Promise<number> {
  if (spans.length === 0) return 0;

  // Build column-wise arrays. UNNEST zips them back into rows server-side.
  const ids: string[] = [];
  const traceIds: string[] = [];
  const parentIds: (string | null)[] = [];
  const kinds: string[] = [];
  const names: string[] = [];
  const startNs: string[] = [];
  const endNs: (string | null)[] = [];
  const ttftNs: (string | null)[] = [];
  const statuses: string[] = [];
  const errors: unknown[] = [];
  const attempts: number[] = [];
  const providers: (string | null)[] = [];
  const models: (string | null)[] = [];
  const inputTokens: (number | null)[] = [];
  const outputTokens: (number | null)[] = [];
  const cacheReadTokens: (number | null)[] = [];
  const cacheCreationTokens: (number | null)[] = [];
  const costs: (string | null)[] = [];
  // jsonb columns need care with postgres.js.
  //
  // `${arr.map(JSON.stringify)}::jsonb[]` does NOT work: the driver escapes each
  // string when building the array literal, so Postgres stores a JSON *string*
  // (`"{\"a\":1}"`) rather than an object, and it reads back character-indexed.
  // `${arr.map(sql.json)}::jsonb[]` fails outright ("cannot cast jsonb to jsonb[]").
  //
  // What works: send ONE json array and expand it server-side with
  // jsonb_array_elements, joined positionally via WITH ORDINALITY below.
  const attrs: unknown[] = [];
  const payloads: unknown[] = [];

  for (const s of spans) {
    ids.push(s.id);
    traceIds.push(s.traceId);
    parentIds.push(s.parentSpanId);
    kinds.push(s.kind);
    names.push(s.name);
    // BIGINT columns: pass as strings so values above 2^53 survive the round
    // trip intact rather than silently losing precision as JS numbers.
    startNs.push(String(s.startNs));
    endNs.push(s.endNs === null ? null : String(s.endNs));
    ttftNs.push(s.timing?.ttftNs == null ? null : String(s.timing.ttftNs));
    statuses.push(s.status);
    errors.push(s.error);
    attempts.push(s.attempt);

    const model = s.attributes["gen_ai.response.model"] ?? s.attributes["gen_ai.request.model"];
    providers.push(s.attributes["gen_ai.provider.name"] ?? null);
    models.push(model ?? null);

    inputTokens.push(s.usage?.inputTokens ?? null);
    outputTokens.push(s.usage?.outputTokens ?? null);
    cacheReadTokens.push(s.usage?.cacheReadTokens ?? null);
    cacheCreationTokens.push(s.usage?.cacheCreationTokens ?? null);

    // Trust a cost the SDK computed; otherwise derive it here. Null stays null
    // for unknown models — never coerce to 0, which would corrupt rollups.
    const cost = s.costUsd ?? computeCostUsd(model, s.usage);
    costs.push(cost === null ? null : cost.toFixed(8));

    attrs.push(s.attributes);
    payloads.push(s.payloads);
  }

  const result = await sql`
    INSERT INTO spans (
      id, trace_id, parent_span_id, kind, name,
      start_ns, end_ns, ttft_ns, status, error, attempt,
      provider, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, attrs, payloads
    )
    SELECT s.id, s.trace_id, s.parent_span_id, s.kind, s.name,
           s.start_ns, s.end_ns, s.ttft_ns, s.status,
           NULLIF(e.v, 'null'::jsonb),
           s.attempt, s.provider, s.model,
           s.input_tokens, s.output_tokens, s.cache_read_tokens, s.cache_creation_tokens,
           s.cost_usd, a.v, p.v
    FROM UNNEST(
      ${ids}::uuid[],
      ${traceIds}::uuid[],
      ${parentIds}::uuid[],
      ${kinds}::text[],
      ${names}::text[],
      ${startNs}::bigint[],
      ${endNs}::bigint[],
      ${ttftNs}::bigint[],
      ${statuses}::text[],
      ${attempts}::smallint[],
      ${providers}::text[],
      ${models}::text[],
      ${inputTokens}::integer[],
      ${outputTokens}::integer[],
      ${cacheReadTokens}::integer[],
      ${cacheCreationTokens}::integer[],
      ${costs}::numeric[]
    ) WITH ORDINALITY AS s(
      id, trace_id, parent_span_id, kind, name,
      start_ns, end_ns, ttft_ns, status, attempt, provider, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, ord
    )
    /* jsonb columns arrive as three json arrays, expanded here and joined
       back positionally. See the comment on the attrs array above for why. */
    JOIN jsonb_array_elements(${sql.json(errors as never)}::jsonb)
      WITH ORDINALITY AS e(v, ord) ON e.ord = s.ord
    JOIN jsonb_array_elements(${sql.json(attrs as never)}::jsonb)
      WITH ORDINALITY AS a(v, ord) ON a.ord = s.ord
    JOIN jsonb_array_elements(${sql.json(payloads as never)}::jsonb)
      WITH ORDINALITY AS p(v, ord) ON p.ord = s.ord
    ON CONFLICT (id) DO UPDATE SET
      end_ns   = EXCLUDED.end_ns,
      ttft_ns  = EXCLUDED.ttft_ns,
      status   = EXCLUDED.status,
      error    = EXCLUDED.error,
      cost_usd = EXCLUDED.cost_usd,
      attrs    = EXCLUDED.attrs,
      payloads = EXCLUDED.payloads,
      input_tokens          = EXCLUDED.input_tokens,
      output_tokens         = EXCLUDED.output_tokens,
      cache_read_tokens     = EXCLUDED.cache_read_tokens,
      cache_creation_tokens = EXCLUDED.cache_creation_tokens
  `;

  return result.count;
}

/** Upsert trace rows. Spans for a trace can arrive before or after this. */
export async function upsertTraces(
  sql: Queryable,
  projectId: string,
  traces: readonly Trace[],
): Promise<void> {
  if (traces.length === 0) return;

  const ids = traces.map((t) => t.id);
  const projectIds = traces.map(() => projectId);
  const names = traces.map((t) => t.name);
  const startedAt = traces.map((t) => t.startedAt);
  const endedAt = traces.map((t) => t.endedAt);
  const statuses = traces.map((t) => t.status);
  const metadata: unknown[] = traces.map((t) => t.metadata);

  await sql`
    INSERT INTO traces (id, project_id, name, started_at, ended_at, status, metadata)
    SELECT t.id, t.project_id, t.name, t.started_at, t.ended_at, t.status, m.v
    FROM UNNEST(
      ${ids}::uuid[],
      ${projectIds}::uuid[],
      ${names}::text[],
      ${startedAt}::timestamptz[],
      ${endedAt}::timestamptz[],
      ${statuses}::text[]
    ) WITH ORDINALITY AS t(id, project_id, name, started_at, ended_at, status, ord)
    JOIN jsonb_array_elements(${sql.json(metadata as never)}::jsonb)
      WITH ORDINALITY AS m(v, ord) ON m.ord = t.ord
    ON CONFLICT (id) DO UPDATE SET
      name     = EXCLUDED.name,
      ended_at = COALESCE(EXCLUDED.ended_at, traces.ended_at),
      status   = EXCLUDED.status,
      metadata = EXCLUDED.metadata
  `;
}

/**
 * Recompute denormalised rollups for the given traces.
 *
 * Run after every batch rather than assuming a batch completes a trace: a long
 * agent run flushes incrementally, so rollups must be correct at every
 * intermediate point, not only at the end.
 *
 * Cost deliberately uses SUM over non-null values only. A trace mixing priced
 * and unpriced models reports the cost it can account for; `null` costs are
 * excluded rather than counted as zero.
 */
export async function recomputeRollups(sql: Queryable, traceIds: readonly string[]): Promise<void> {
  if (traceIds.length === 0) return;

  await sql`
    UPDATE traces t SET
      span_count     = agg.span_count,
      error_count    = agg.error_count,
      total_tokens   = agg.total_tokens,
      total_cost_usd = agg.total_cost,
      duration_ms    = agg.duration_ms,
      status = CASE
        WHEN agg.error_count > 0 THEN 'error'
        WHEN agg.unfinished > 0  THEN 'in_progress'
        ELSE 'ok'
      END
    FROM (
      SELECT
        trace_id,
        COUNT(*)::int AS span_count,
        COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
        COUNT(*) FILTER (WHERE end_ns IS NULL)::int AS unfinished,
        COALESCE(SUM(
          COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
          + COALESCE(cache_read_tokens,0) + COALESCE(cache_creation_tokens,0)
        ), 0)::int AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS total_cost,
        (MAX(end_ns) / 1000000)::int AS duration_ms
      FROM spans
      WHERE trace_id = ANY(${traceIds}::uuid[])
      GROUP BY trace_id
    ) agg
    WHERE t.id = agg.trace_id
  `;
}

/** Increment the dropped-span counter so client-side loss stays visible. */
export async function recordDroppedSpans(
  sql: Queryable,
  traceIds: readonly string[],
  dropped: number,
): Promise<void> {
  if (dropped <= 0 || traceIds.length === 0) return;
  await sql`
    UPDATE traces SET dropped_spans = dropped_spans + ${dropped}
    WHERE id = ANY(${traceIds}::uuid[])
  `;
}

/** Client-side rollup, used by tests and the SDK. Mirrors the SQL above. */
export function computeRollup(spans: readonly Span[]): TraceRollup {
  let tokens = 0;
  let cost = 0;
  let errors = 0;
  let maxEnd = 0;
  let unfinished = 0;

  for (const s of spans) {
    if (s.usage) tokens += totalTokens(s.usage);
    if (s.costUsd !== null) cost += s.costUsd;
    if (s.status === "error") errors++;
    if (s.endNs === null) unfinished++;
    else if (s.endNs > maxEnd) maxEnd = s.endNs;
  }

  return {
    durationMs: spans.length === 0 ? null : Math.round(maxEnd / 1_000_000),
    totalTokens: tokens,
    totalCostUsd: cost,
    spanCount: spans.length,
    errorCount: errors,
  };
}
