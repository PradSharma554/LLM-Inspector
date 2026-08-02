# LLM Execution Inspector — Architecture

Chrome DevTools for AI applications. Trace and visualise every stage of an LLM
request: prompt assembly, retrieval, model calls, tool calls, streaming tokens,
retries, cost.

Status: design. Nothing built yet.

---

## 1. The three decisions that shape everything

Most of this design falls out of three constraints. Everything else is detail.

### 1.1 Storage is the binding constraint, not compute

Neon's free plan gives **0.5 GB of storage** and 100 CU-hours per project per
month. Upstash Redis free gives **256 MB and 500k commands/month**.

LLM traces are payload-dominated. One RAG trace with 4k tokens of retrieved
context, a system prompt, two completions and a couple of tool results is
comfortably 50-100 KB of JSON. At 0.5 GB that is roughly **5,000-10,000 traces
before the database is full** — few enough that you would hit it during a demo.

So the split is not optional:

| Store    | Holds                                                    | Per span |
| -------- | -------------------------------------------------------- | -------- |
| Postgres | ids, parent/child, timings, token counts, cost, status    | ~1-2 KB  |
| R2       | prompts, completions, chunks, tool IO — gzipped, hashed   | unbounded |
| Redis    | live-trace fanout + rate limiting only. Never durable.     | ephemeral |

Postgres holds only what you **query, sort, filter and aggregate on**. R2 holds
what you only ever **fetch by primary key when a user clicks a span**. That is
exactly the access pattern split that justifies object storage, and it is worth
saying so explicitly in the README — it is a design-judgement signal.

Payloads under ~4 KB stay inline in Postgres to avoid an R2 round-trip for the
common small case. Above that, the span carries a `payload_ref`.

### 1.2 Content-addressed payloads make the free tier viable

Payloads repeat enormously. The same system prompt appears in every trace. The
same retrieved chunk appears across many queries. Store payloads under
`sha256(content)` and near-duplicate traces cost almost nothing after the first.

```
r2://payloads/<sha256[0:2]>/<sha256>.gz
```

Dedup is a real engineering decision with a real payoff here, not a flourish.
It also gives you free integrity checking and idempotent writes.

### 1.3 Streaming is where the interesting data lives

This is the part that separates a real inspector from a wrapper that logs
request/response pairs.

From the Anthropic streaming event sequence:

- `message_start` carries **input tokens**, including
  `cache_creation_input_tokens` and `cache_read_input_tokens`.
- `message_delta` carries the running **output_tokens**.
- `content_block_delta` fires per token chunk.
- Tool call arguments stream as `input_json_delta` fragments.

Three consequences:

1. **Time-to-first-token is only observable from the stream.** `message_start` →
   first `content_block_delta` is the single most useful latency number in an
   LLM waterfall, and a wrapper that reads only the final message cannot compute
   it.
2. **Cost is wrong without cache accounting.** Cache reads bill at ~0.1x and
   cache writes at 1.25-2x. A cost column that multiplies total input tokens by
   the base rate is simply incorrect on any cached workload. Read the three
   input-token fields separately.
3. **Tool calls have genuine start/end times**, because their arguments stream.
   Spans are measured, not synthesised.

---

## 2. Data model

Three tables. Deliberately few.

```sql
-- A single top-level AI request.
CREATE TABLE traces (
  id            UUID PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES projects(id),
  name          TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  duration_ms   INTEGER,
  status        TEXT NOT NULL,          -- ok | error | partial
  -- denormalised rollups so the trace list never touches spans
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  span_count    INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  metadata      JSONB
);

CREATE INDEX ON traces (project_id, started_at DESC);
CREATE INDEX ON traces (project_id, status) WHERE status <> 'ok';

-- One node in the execution tree.
CREATE TABLE spans (
  id             UUID PRIMARY KEY,
  trace_id       UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  parent_span_id UUID REFERENCES spans(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,   -- llm_call | retrieval | tool_call
                                  -- | agent_step | prompt_assembly | embedding
  name           TEXT NOT NULL,

  start_ns       BIGINT NOT NULL, -- ns since trace start, not wall clock
  end_ns         BIGINT,
  ttft_ns        BIGINT,          -- llm_call only; the headline latency number

  status         TEXT NOT NULL,
  error          JSONB,
  attempt        SMALLINT NOT NULL DEFAULT 1,  -- retries are spans, not hidden

  -- gen_ai.* attributes, promoted to columns because we filter/aggregate here
  provider       TEXT,
  model          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  cost_usd       NUMERIC(12,6),

  attrs          JSONB,           -- everything else, incl. full gen_ai.* set
  payload_inline JSONB,           -- small payloads (<4KB)
  payload_ref    TEXT             -- r2 key for large ones
);

CREATE INDEX ON spans (trace_id, start_ns);
CREATE INDEX ON spans (trace_id, parent_span_id);
```

Notes on choices a reviewer will look for:

- **`start_ns` is relative to trace start**, not a wall-clock timestamp. Waterfall
  rendering needs offsets; storing absolute times forces every read to subtract,
  and invites clock-skew bugs across processes.
- **Rollups are denormalised onto `traces`.** The trace list is the hottest query
  in the app; making it aggregate over spans would be the obvious performance
  mistake.
- **Retries are first-class spans** with an `attempt` number, not swallowed by
  the SDK. Seeing attempt 1 fail and attempt 2 succeed *in the waterfall* is a
  genuine debugging feature.
- **Hot attributes are columns; the rest is JSONB.** Promoting only what you
  filter on keeps rows narrow without losing fidelity.

### Attribute naming

Follow the OpenTelemetry GenAI semantic conventions, which are **in development**
(not stable) and live in their own repo, having moved out of the main
semantic-conventions repository.

Use the current names:

| Attribute                     | Note |
| ----------------------------- | ---- |
| `gen_ai.provider.name`        | **Renamed from `gen_ai.system` in semconv v1.37.0.** The old name is deprecated — do not use it. |
| `gen_ai.operation.name`       | e.g. `chat` |
| `gen_ai.request.model`        | requested model |
| `gen_ai.response.model`       | model that actually served it |
| `gen_ai.usage.input_tokens`   | **includes cached tokens** |
| `gen_ai.usage.output_tokens`  | |

Span name convention is `{gen_ai.operation.name} {gen_ai.request.model}` —
e.g. `chat claude-opus-5`.

Using `gen_ai.system` would be an immediate tell to anyone who works with OTel.
Using the current names, and knowing they are unstable, is a credibility signal.

---

## 3. Components

Everything is TypeScript. One language, one toolchain, one set of types shared
end to end — see §7 for why that is the right call here.

```
┌─────────────┐   batched POST /v1/traces    ┌──────────────────────┐
│  SDK (TS)   │ ───────────────────────────► │  Collector (TS/Node) │
│ wrap(client)│                              │  - validate (zod)    │
└─────────────┘                              │  - split payload     │
                                             │  - enqueue           │
                                             └──────────┬───────────┘
                                                        │
                                   ┌────────────────────┼──────────────┐
                                   ▼                    ▼              ▼
                              ┌─────────┐       ┌──────────┐   ┌──────────┐
                              │ Neon PG │       │ R2 blobs │   │  Redis   │
                              │ metadata│       │ payloads │   │ live SSE │
                              └─────────┘       └──────────┘   └──────────┘
                                   ▲                                │
                                   │   Query API (TS, same service) │
                                   └────────────┬───────────────────┘
                                                ▼
                                      ┌───────────────────┐
                                      │  Next.js DevTools │
                                      │  waterfall / tree │
                                      └───────────────────┘
```

### 3.0 The shared-types payoff

The single biggest win from going TypeScript-only: **the wire protocol is defined
once and used everywhere.**

```
packages/
  protocol/     # zod schemas + inferred types — the source of truth
  sdk/          # imports protocol, emits it
  server/       # imports protocol, validates with the same schemas
  web/          # imports protocol, renders it
```

Define the span schema in zod once; derive the TypeScript type with
`z.infer`; validate at the collector boundary with the *same* schema the SDK
serialised from. A protocol change is then a compile error across all three
packages rather than a runtime surprise in production.

With a Go backend this would have been a hand-maintained type definition on each
side plus a codegen step to keep them honest. That is real work you now do not
have to do, and it is worth stating in the README — it is a coherent
architectural argument, not a fallback.

Use a pnpm workspace monorepo.

### 3.1 SDK (TypeScript)

The API you specified:

```ts
const inspector = new Inspector({ apiKey, endpoint });
const llm = inspector.wrap(anthropic);   // or openai, or any client
```

`wrap()` returns a **Proxy** over the client, so it survives SDK version changes
without you re-implementing method signatures. It intercepts the call sites that
matter (`messages.create`, `messages.stream`, `chat.completions.create`) and
passes everything else straight through.

Requirements that follow from "must not require developers to change much code":

- **Never throw into user code.** Any inspector failure is caught and dropped.
  An observability tool that can break the app it observes is worse than none.
- **Never block.** Spans go into an in-memory ring buffer, flushed on a timer or
  a size threshold. Bounded buffer, drop-oldest on overflow, with a dropped
  counter surfaced so silent loss is visible.
- **Context propagation via `AsyncLocalStorage`**, so nested retrieval and tool
  calls attach to the right parent without threading a context argument through
  every function. This is what makes the tree assemble itself.
- **Streaming wrapper is a passthrough iterator.** It must yield chunks to the
  caller with no added latency while observing them, recording TTFT on the first
  `content_block_delta` and accumulating usage from `message_start` and
  `message_delta`.

Explicit spans for the parts no proxy can infer:

```ts
await inspector.span('retrieval', async (s) => {
  const chunks = await vectorSearch(q);
  s.setPayload({ chunks });
  return chunks;
});
```

### 3.2 Collector (TypeScript / Node)

Runtime: **Node 20+ with Fastify.** Fastify over Express because its
schema-based validation and serialisation are meaningfully faster on a
JSON-heavy ingest path, and this service is nothing but JSON in, JSON out.

Postgres client: **`postgres.js`** (not `pg`). It supports pipelining, has
first-class prepared statements, and its tagged-template API generates
parameterised queries — no string concatenation, no ORM overhead on a hot path.

- `POST /v1/traces` — batched span ingest, project-key auth.
- Validate with the shared zod schema, then **split**: payloads over ~4 KB to R2,
  metadata to Postgres.
- **Return 202 once the batch is accepted into the in-process queue**, not after
  the DB write. Ingest latency must not depend on Postgres — especially with Neon
  scaling to zero, where a cold start would otherwise be paid by the SDK's flush.
- **Batch insert** spans via a single multi-row `INSERT ... SELECT * FROM
  UNNEST($1::uuid[], $2::text[], ...)`. This is the Postgres-native way to insert
  N rows in one round trip from a driver without `COPY` support, and it is the
  detail that keeps ingest fast. Row-by-row inserts would be the obvious mistake.
- Publish a compact "trace updated" event to Redis for the live view.

**The concurrency question, answered honestly.** Go's advantage here would have
been cheap parallel fan-out. Node is single-threaded for *compute*, but this
workload is almost entirely **I/O-bound** — network waits on Postgres and R2 —
which is exactly what the event loop handles well. Concretely:

- Fan-out to Postgres and R2 is `Promise.all`, genuinely concurrent because both
  are I/O.
- Backpressure is an explicit bounded queue with a `maxQueueDepth`; when full,
  shed load with `503` + `Retry-After` and let the SDK's buffer absorb it.
- The one real CPU cost is **gzipping payloads before R2**. Do that in a
  `node:zlib` async call (which runs on libuv's threadpool, *off* the event
  loop) — never `gzipSync`. That single choice is the difference between a
  collector that stays responsive under load and one that stalls.

If ingest ever became CPU-bound, the escape hatch is `node:worker_threads` for
compression, or horizontal replicas — both cheaper than a rewrite. Being able to
explain *why* the event loop is sufficient here, and where the limit is, is a
better interview answer than "I used Go because it's fast."

### 3.3 Query API (TypeScript, same service)

Same Fastify app, separate route module. One deployable instead of two — less to
run on free tiers, and the read and write paths share connection pooling.

- `GET /v1/traces` — cursor-paginated list, hits only the `traces` table.
- `GET /v1/traces/:id` — flat span fetch, tree assembled in memory. Traces are
  small (hundreds to low thousands of spans); a flat `SELECT` plus an O(n)
  parent-map pass beats a recursive CTE and is far easier to reason about.
- `GET /v1/spans/:id/payload` — fetch from R2 on demand. This is why payloads are
  offloaded: the list view never pays for them.
- `GET /v1/live` — SSE, backed by Redis pub/sub.

Type-safety note: `postgres.js` lets you parameterise row types, so query results
are typed against the same protocol types the SDK emits. End-to-end type flow
from `wrap()` call site to React component.

### 3.4 Frontend (Next.js)

DevTools, not Grafana. The distinction is concrete:

- **Dense, monospace, information-first.** No cards, no rounded shadows, no
  animated gauges.
- **Waterfall is the primary view**, x-axis = time, one row per span, nested by
  depth — the Network panel, not a dashboard.
- **Split pane:** tree on the left, event inspector on the right. Clicking a span
  shows raw payload with a JSON viewer.
- **Flame graph** as a second tab for self-time vs total-time.
- **Keyboard navigation** (j/k, arrow keys to expand/collapse). DevTools users
  expect it, and it takes an afternoon.

Virtualise the span list. A long agent trace can be thousands of spans and
naive rendering will jank.

---

## 4. Build order

Each milestone is independently demoable. That matters: a portfolio project that
is 60% done in every direction shows nothing.

**M0 — Workspace + protocol package.** pnpm workspace, `packages/protocol` with
the zod span schema. Small, but it is the keystone: every other package imports
it, so getting it first means the rest is type-checked against reality.

**M1 — Skeleton end to end.** One hardcoded span from a script → Fastify
collector → Neon → a page that renders it. Proves the whole pipeline before any
polish.

**M2 — SDK wrapper, non-streaming.** Proxy-based `wrap()`, `AsyncLocalStorage`
context, ring buffer + flush. Correct parent/child on nested calls.

**M3 — Streaming + token accounting.** TTFT, per-chunk timing, the three input
token fields, correct cost including cache rates. The technical core.

**M4 — Waterfall UI.** Virtualised, zoom, hover, click-to-inspect.

**M5 — R2 offload.** Content-addressed, gzipped, dedup by sha256. Instrument the
dedup hit rate — it is a satisfying number to show.

**M6 — Demo RAG + agent app.** Real retrieval, real tool calls, real multi-step
loops. Deliberately include a flaky tool so retry spans appear.

**M7 — Flame graph, live view, error inspection.**

Deploy: Vercel (frontend), Render or Railway (Node service), Neon, Upstash, R2.

**Do not put the collector on Vercel functions.** Serverless is actively wrong
for this component: the in-memory batch queue does not survive between
invocations, so you would lose the batching that makes ingest cheap, and you
would pay a cold start on every flush. The collector wants a long-lived process.
Render or Railway, not a Vercel route handler.

Note Render's free web services **sleep after inactivity** and cold-start on the
next request. For a portfolio demo that is a real papercut — a recruiter clicking
your link waits ~30s on a blank screen. Mitigate with a cheap keep-alive ping, or
put the collector on Railway, or ship a seeded read-only demo trace that renders
from the frontend without waking the backend.

---

## 5. Scaling story (asked about in interviews, not built now)

Design so these are *swaps*, not rewrites:

- **Kafka** — the collector already writes to a queue interface. Swap the
  in-process channel for Kafka; nothing upstream changes.
- **ClickHouse** — spans are append-only, immutable, time-ordered. Move the
  `spans` table to ClickHouse and keep `traces` in Postgres. Being able to say
  *why* the schema suits a columnar store (and why you did not need it at this
  scale) is a stronger answer than having used it prematurely.
- **Sampling** — head-based sampling in the SDK behind a `sampleRate` option, with
  a note on why tail-based sampling needs a buffering collector.

The valuable interview answer is *"here is the seam, here is the trigger volume,
and here is why it is not worth it yet."*

---

## 6. Things that will bite

- **Node 18 is EOL and Next.js 16 requires Node 20+.** Run `nvm install 20`
  before starting the frontend. (Detected locally: Node v18.20.8.)
- **Neon scales compute to zero after 5 min idle.** First query after idle pays a
  cold start. Fine for a demo; do not benchmark on a cold connection and panic.
- **Use a pooled Neon connection string** from the Node service; serverless
  Postgres plus a hot connection pool is a classic footgun.
- **Gzip payloads asynchronously.** `zlib.gzipSync` on the collector's request
  path blocks the event loop and serialises every concurrent request behind it.
  Use the callback/promise form so it runs on the libuv threadpool. This is the
  single most likely performance bug in a Node collector.
- **Cap the ingest body size.** Fastify's `bodyLimit` defaults to 1 MB; batched
  span payloads will exceed it. Raise it deliberately to a known ceiling rather
  than discovering the 413 in production — and keep a ceiling, so a malformed
  client cannot OOM the process.
- **`AsyncLocalStorage` context is lost across `setTimeout`/`setInterval`
  boundaries** in some patterns and across worker threads. If a span tree comes
  out flat when it should be nested, this is the first thing to check.
- **Never put payloads in Redis.** 256 MB fills instantly and it is not durable.
  Pub/sub notifications only.
- **Clock skew across processes.** Trace-relative `start_ns` from a single
  monotonic origin per trace avoids negative durations.
- **Do not let the inspector's own HTTP calls get traced.** Tag and exclude them,
  or you get infinite recursion the first time you wrap a client the SDK uses.

## 7. Why TypeScript everywhere

This was considered with Go for the collector and decided against. The reasoning
is worth keeping, because "why not Go?" is a question an interviewer will ask
about an ingest pipeline, and the answer should be a decision rather than a
shrug.

**The case for Go was concurrency at the ingest boundary.** It is a real
argument, and it is weaker than it first appears here: this workload is
I/O-bound, not CPU-bound. Waiting on Postgres and R2 is what the Node event loop
is good at. Go's goroutines win when you are doing parallel *computation*; the
only meaningful compute in this service is gzip, which `node:zlib` already runs
off the event loop on the libuv threadpool (§3.2).

**The case against Go was concrete and specific to this system:**

1. **The wire protocol is the heart of the project.** With one language it is a
   single zod schema imported by SDK, collector and UI, and a protocol change is
   a compile error everywhere. Split across languages it becomes a
   hand-maintained duplicate plus codegen to keep the two honest. That is pure
   overhead on the artefact that matters most.
2. **The SDK must be TypeScript regardless** — it wraps `@anthropic-ai/sdk` and
   `openai` in the user's Node process. So Go could never have been the whole
   backend; it would always have been a second language, not the language.
3. **Scope.** M0–M7 is a lot of surface for one person. Two toolchains, two
   dependency stories, two deploy configs and two sets of tests is exactly the
   overhead that leaves a portfolio project 60% finished in every direction.

**What is deliberately given up:** true multi-core parallelism in one process,
and the raw throughput ceiling. Both are irrelevant at portfolio scale and both
have escape hatches (§3.2: `worker_threads`, horizontal replicas). Knowing where
that ceiling is, and being able to say so, is the point.

The engineering signal in this project lives in the data model (§2), the
streaming instrumentation (§1.3) and the storage tiering (§1.1) — none of which
depend on the backend language. A finished inspector demonstrates all three. An
abandoned one demonstrates none.
