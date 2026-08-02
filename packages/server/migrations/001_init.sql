-- LLM Execution Inspector — initial schema.
--
-- Design notes that matter (see docs/ARCHITECTURE.md §2):
--
--  * Postgres stores only what we QUERY, SORT, FILTER or AGGREGATE on. Payloads
--    (prompts, completions, retrieved chunks, tool IO) live in R2 and are
--    fetched by key on demand. Neon's free tier is 0.5 GB; a payload-heavy
--    schema would exhaust it in a few thousand traces.
--
--  * Timings are stored as offsets in nanoseconds from the trace start, not as
--    wall-clock timestamps. Waterfall rendering wants offsets, and a single
--    monotonic origin per trace prevents cross-process clock skew from
--    producing negative durations.
--
--  * Rollups are denormalised onto `traces` because the trace list is the
--    hottest query in the app and must never aggregate over spans.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  -- SHA-256 of the ingest key. Never store the key itself: a leaked database
  -- dump should not hand over working write credentials.
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traces (
  id             UUID PRIMARY KEY,
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  duration_ms    INTEGER,
  status         TEXT NOT NULL DEFAULT 'ok'
                 CHECK (status IN ('ok','error','cancelled','in_progress')),

  -- Denormalised rollups, recomputed by the collector on each batch.
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  span_count     INTEGER NOT NULL DEFAULT 0,
  error_count    INTEGER NOT NULL DEFAULT 0,
  -- Spans the SDK dropped due to buffer pressure. Surfaced in the UI so
  -- silent data loss is visible rather than looking like less work happened.
  dropped_spans  INTEGER NOT NULL DEFAULT 0,

  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The trace-list query: newest first, scoped to a project.
CREATE INDEX IF NOT EXISTS traces_project_started_idx
  ON traces (project_id, started_at DESC);

-- Partial index: "show me failures" is a common filter and errors are rare,
-- so indexing only non-ok rows keeps this small.
CREATE INDEX IF NOT EXISTS traces_project_errors_idx
  ON traces (project_id, started_at DESC)
  WHERE status <> 'ok';

CREATE TABLE IF NOT EXISTS spans (
  id             UUID PRIMARY KEY,
  trace_id       UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  -- Self-referential FK is deliberately NOT declared: spans can arrive out of
  -- order across batches (a child may land before its parent), and a hard FK
  -- would reject the child. Orphans are resolved at read time by promoting
  -- them to roots — see buildSpanTree() in @llm-inspector/protocol.
  parent_span_id UUID,

  kind           TEXT NOT NULL
                 CHECK (kind IN ('llm_call','retrieval','tool_call','agent_step',
                                 'prompt_assembly','embedding','guardrail','custom')),
  name           TEXT NOT NULL,

  start_ns       BIGINT NOT NULL,
  end_ns         BIGINT,
  -- Time to first token: only observable from a stream (message_start -> first
  -- content_block_delta). Null for non-streamed or non-LLM spans.
  ttft_ns        BIGINT,

  status         TEXT NOT NULL DEFAULT 'ok'
                 CHECK (status IN ('ok','error','cancelled','in_progress')),
  error          JSONB,
  -- Retries are first-class spans, not hidden inside the SDK. Seeing attempt 1
  -- fail and attempt 2 succeed in the waterfall is a real debugging feature.
  attempt        SMALLINT NOT NULL DEFAULT 1,

  -- gen_ai.* attributes promoted to columns because we filter/aggregate on them.
  -- Note: `provider` corresponds to gen_ai.provider.name (renamed from
  -- gen_ai.system in semconv v1.37.0 — the old name is deprecated).
  provider       TEXT,
  model          TEXT,

  -- Token usage kept split. gen_ai.usage.input_tokens INCLUDES cached tokens
  -- per spec, so it cannot price a request on its own: cache reads bill ~0.1x
  -- and writes 1.25-2x. input_tokens here is the UNCACHED remainder.
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  -- Nullable on purpose: unknown model means unknown price. A confident 0.00
  -- would silently corrupt every aggregate above it.
  cost_usd       NUMERIC(14,8),

  attrs          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Small payloads (<4KB) inline; larger ones promoted to R2 and referenced.
  payloads       JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The span-tree fetch: all spans for one trace, in timeline order.
CREATE INDEX IF NOT EXISTS spans_trace_start_idx
  ON spans (trace_id, start_ns);

-- Parent lookup during tree assembly.
CREATE INDEX IF NOT EXISTS spans_trace_parent_idx
  ON spans (trace_id, parent_span_id);

-- Cross-trace model analytics ("p95 latency for claude-opus-5 this week").
CREATE INDEX IF NOT EXISTS spans_model_created_idx
  ON spans (model, created_at DESC)
  WHERE model IS NOT NULL;

-- Content-addressed payload index. Because payloads are stored under
-- sha256(content), identical system prompts and repeated retrieval chunks
-- collapse to one object — this is what makes the free tier viable.
CREATE TABLE IF NOT EXISTS payload_blobs (
  sha256      TEXT PRIMARY KEY,
  r2_key      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  -- Compressed size, so the dedup + gzip win is measurable and demoable.
  stored_bytes INTEGER NOT NULL,
  ref_count   INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
