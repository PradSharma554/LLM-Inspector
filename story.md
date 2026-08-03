# Build Story — LLM Execution Inspector

A record of how this project was built: the decisions, the reasoning behind
them, the bugs hit along the way, and what is still outstanding. Written so the
context survives past the session that produced it.

Built 2026-08-01 → 2026-08-02.

---

## 1. What was asked for

"Chrome DevTools for AI applications" — an LLM Execution Inspector that traces
every stage of an AI request (prompt, context assembly, retrieval, tool calls,
model calls, streaming tokens, latency, tokens, cost, errors, retries) and
renders it like the Chrome Network panel rather than a Grafana dashboard.

Constraints given up front: portfolio/learning project, free tiers only, no
Kubernetes, no Kafka, no ClickHouse initially, and a small SDK where
`inspector.wrap(client)` requires almost no user code change.

Explicit goal: impress senior backend engineers, not ship a startup MVP.

---

## 2. The three decisions everything else follows from

### 2.1 Storage is the binding constraint, not compute

Looked up rather than assumed: **Neon's free tier is 0.5 GB**; Upstash Redis
free is 256 MB / 500k commands per month.

One RAG trace with retrieved context, a system prompt, two completions and tool
results is 50–100 KB of JSON. That is ~5,000–10,000 traces before the database
is full — few enough to hit *during a demo*.

So the split is not optional:

| Store    | Holds                                    | Per span  |
| -------- | ---------------------------------------- | --------- |
| Postgres | ids, timings, token counts, cost, status | ~1–2 KB   |
| R2       | prompts, completions, chunks, tool IO    | unbounded |
| Redis    | live-view pub/sub only, never durable    | ephemeral |

Postgres holds what you **query, sort, filter, aggregate**. R2 holds what you
only ever **fetch by key when a user clicks a span**.

Payloads are stored under `sha256(content)`, so a repeated system prompt costs
one object however many traces reference it. **Measured on demo data: 92,202 B
logical → 393 B stored, 234× reduction** (dedup + gzip).

### 2.2 Cost is wrong unless you account for prompt caching

Cache reads bill at ~0.1× the base input rate; writes at 1.25× (5-min TTL) or
2× (1-hour). The OTel convention `gen_ai.usage.input_tokens` **includes** cached
tokens, so pricing off that single field overstates cost badly.

Demonstrated on a real trace: correct **$0.081** vs naive **$0.527 — 6.5×
overstated**. Verified independently against hand-computed arithmetic to eight
decimal places.

Consequences baked into the design:

- `TokenUsage` stores `inputTokens` (uncached), `cacheReadTokens`,
  `cacheCreationTokens`, `outputTokens` separately.
- Unknown models return `costUsd: null`, never `0`. A confident zero silently
  corrupts every aggregate above it; `null` renders as "—" and stays honest.

### 2.3 Time-to-first-token only exists in the stream

TTFT is the gap between `message_start` and the first `content_block_delta`. A
wrapper that awaits the final message object **cannot compute it at all**.

Also from the stream: input tokens and the cache breakdown arrive at
`message_start` (not at the end), running output tokens arrive on
`message_delta`, and tool arguments stream as `input_json_delta` so tool spans
have measured rather than synthesised boundaries.

---

## 3. Decisions made with the user

Three were put to an explicit choice early on:

1. **Wire protocol** → custom, OTel-shaped (not strict OTLP). Full control over
   LLM-specific fields with a credible path to OTLP later.
2. **Demo data** → a real RAG+agent demo app (not a synthetic generator), so the
   UI is proven against messy reality.
3. **Payloads** → R2 offload from day one (not truncation or aggressive
   retention), since the "raw payload viewer" is the core feature and truncating
   it guts the product.

Then, mid-build: **"dont use go, use typescript onnly."**

That was the right call and it improved the design. Recorded in ARCHITECTURE §7:

- The case *for* Go was concurrency at ingest. Weaker than it looks: the
  workload is I/O-bound (waiting on Postgres and R2), which is what the event
  loop is good at. The only real CPU cost is gzip, which `node:zlib` runs on the
  libuv threadpool.
- The case *against* was concrete: the wire protocol is the heart of the
  project, and with one language it is a single zod schema imported by SDK,
  collector and UI — a protocol change becomes a compile error across the
  workspace instead of hand-maintained duplicates plus codegen. The SDK had to
  be TypeScript regardless (it wraps `@anthropic-ai/sdk` in the user's process),
  so Go was never going to be *the* language, only a second one.
- Given up deliberately: true multi-core parallelism, raw throughput ceiling.
  Both irrelevant at this scale, both with escape hatches (`worker_threads`,
  horizontal replicas).

Context that informed this: CloudAIr's git history contains
`74ce59f Rewrite backend from Go to TypeScript + Express` — Go had already been
abandoned once on a portfolio backend. Raised honestly at the time rather than
discovered later.

---

## 4. What exists

```
llm-inspector/
├── .nvmrc                  Node 24.18.1
├── docker-compose.yml      Postgres 17 :5433, Redis 7 :6379, MinIO :9000/:9001
├── .env / .env.example     .env is gitignored
├── docs/ARCHITECTURE.md    full design doc
├── README.md
├── story.md                this file
├── examples/agent-demo.mjs runs with no API key
├── packages/
│   ├── protocol/           zod schemas, pricing, tree assembly   15 tests
│   ├── server/             Fastify collector + query API + R2
│   └── sdk/                wrap(), AsyncLocalStorage, TTFT       26 tests
└── apps/web/               Next.js 16 DevTools UI
```

**41 tests passing.** Verified against local Postgres 17 *and* Neon 18.4.

### Versions (checked at build time, not assumed)

Node 24.18.1 · pnpm 11.18.0 · TypeScript 7.0.2 · zod 4.4.3 · Fastify 5.11.0 ·
postgres.js 3.4.9 · Next 16.2.12 · React 19.2.8 · Tailwind 4.3.3 ·
@aws-sdk/client-s3 3.1101.0 · @types/react 19.2.18 · @types/react-dom 19.2.4

### Data model

Three tables — `projects`, `traces`, `spans` — plus `payload_blobs` for the
content-addressed index.

Decisions a reviewer would look for:

- **`start_ns` is trace-relative**, not wall-clock. Waterfalls want offsets, and
  a single monotonic origin per trace stops cross-process clock skew producing
  negative durations.
- **Rollups denormalised onto `traces`.** The trace list is the hottest query;
  aggregating over spans there would be the obvious mistake.
- **No FK on `parent_span_id`.** Spans arrive across batches and a child can land
  before its parent; a hard FK would reject it. Orphans are promoted to roots at
  read time by `buildSpanTree`.
- **`api_key_hash`, never the key.** A leaked dump shouldn't hand over working
  write credentials.
- **Retries are first-class spans** with an `attempt` number, not hidden in the
  SDK. Seeing attempt 1 fail beside attempt 2 succeeding is the point.

### OTel naming

Follows the GenAI semantic conventions, which are **in development** (not
stable) and live in their own repo (`open-telemetry/semantic-conventions-genai`),
having moved out of the main one.

**`gen_ai.system` was renamed to `gen_ai.provider.name` in semconv v1.37.0** and
the old name is deprecated. Using the old one would be an immediate tell.
Span name convention: `{gen_ai.operation.name} {gen_ai.request.model}` — e.g.
`chat claude-opus-5`.

---

## 5. Bugs hit, and what they taught

### 5.1 jsonb double-encoding (the significant one)

**Symptom:** payload fetch returned a character-indexed object —
`{"0": "{", "1": "\""}` — because the `payloads` column held a JSON *string*
rather than an object.

**Cause:** `${arr.map(JSON.stringify)}::jsonb[]`. postgres.js escapes strings
when building an array literal, so Postgres stored `"{\"a\":1}"`.

**Investigation:** tested three encodings against a temp table.

| Approach                                  | Result                                |
| ----------------------------------------- | ------------------------------------- |
| `arr.map(JSON.stringify)` + `::jsonb[]`   | stores a **string**                   |
| `arr.map(sql.json)` + `::jsonb[]`         | **fails**: "cannot cast jsonb to jsonb[]" |
| one json array + `jsonb_array_elements()` | **object** ✓                          |

**Fix:** send one JSON array and expand it server-side with
`jsonb_array_elements(...) WITH ORDINALITY`, joined positionally to the UNNEST
rows. Documented in `packages/server/src/db/spans.ts` so it can't regress.

**Lesson:** the fix was only found by *reading the stored rows*, not by trusting
a 202 response. Verify the data, not the status code.

### 5.2 Flat span tree — caught by the demo, missed by 26 unit tests

`inspector.trace()` set the context parent to `null`, so top-level spans had no
root and the waterfall had no bar spanning the request. Unit tests asserted the
buggy behaviour, so they passed.

Fixed by emitting a root span in `trace()`; the test now asserts correct
nesting. **End-to-end runs catch what unit tests bless.**

### 5.3 `--experimental-strip-types` cannot resolve `.js` → `.ts`

The `.js` extensions are *correct* for NodeNext output, so the right fix was to
run tests and scripts against compiled `dist/` output — which is what production
does anyway — rather than corrupting the source.

### 5.4 pnpm 11 requires Node ≥22.13

It imports `node:sqlite`, absent in Node 20. Moved to Node 24.18.1 (LTS), pinned
in `.nvmrc` and `engines`. Node 20 would have been fine for Next 16 alone; pnpm
was the actual constraint.

### 5.5 Next.js 16 + TypeScript 7

Next cannot drive TS 7's compiler API. Compilation succeeded; only the typecheck
step failed. Fixed with `experimental.useTypeScriptCli` rather than downgrading
TypeScript for the whole workspace.

### 5.6 `TransactionSql` is not `Sql`

`tx as Sql` was rejected by the compiler. Rather than cast through `unknown`,
introduced a `Queryable` type (pool **or** transaction). Repository functions are
now statically prevented from closing the connection pool. The compiler caught a
real layering mistake.

### 5.7 Stale process left on :4000

A collector from testing survived `pkill -f "node dist/main.js"` because the
command line had just changed to include `--env-file`, so the pattern no longer
matched. My cleanup error, surfaced to the user as `EADDRINUSE`.

Fixed properly: `main.ts` now catches `EADDRINUSE` and prints the `lsof`/`kill`
commands instead of a 20-line stack trace.

### 5.8 `source .env` breaks on the Neon URL

`&channel_binding=require` is a shell metacharacter. Reading it needs
`grep`/`cut`, or better, Node's `--env-file` (below).

---

## 6. Implementation details worth keeping

- **Batch insert via `UNNEST`** — N spans in one round trip. A loop of
  single-row inserts costs N round trips, and over a hosted database that
  latency dominates.
- **`ON CONFLICT DO UPDATE`** makes ingest idempotent, so at-least-once delivery
  from the SDK can't duplicate.
- **Keyset pagination**, not `OFFSET` — deep pages stay fast, and rows shifting
  between requests can't cause skips or repeats.
- **BIGINT as strings** across the driver boundary, so ns timings above 2^53
  don't lose precision.
- **Gzip is async** (`node:zlib` promisified). `gzipSync` on the request path
  blocks the event loop and serialises every concurrent request behind it — the
  most likely performance bug in a Node collector.
- **Payload offload runs before the transaction**, so a slow upload never holds
  a Postgres transaction open. Storage failure degrades to inline rather than
  dropping the span.
- **SDK never throws into user code** — verified against `ECONNREFUSED`.
- **Bounded ring buffer**, drops *oldest* and counts them. An unbounded buffer
  in a library turns a collector outage into an OOM in the host app.
- **Re-buffers on 503, not on 401** — retrying a bad key would loop forever.
- **`runDetached`** wraps the exporter's own fetch, or wrapping a client the
  exporter uses would trace the export, generating a span, triggering an export.
- **Proxy-based `wrap()`** survives provider SDK upgrades and passes
  uninstrumented methods straight through — wrapping can never remove
  functionality. Stream helpers (`finalMessage()`) are preserved; replacing the
  helper with a bare generator would silently break consumers.
- **`buildSpanTree` is iterative**, verified against a 5000-deep chain, and runs
  in *both* the API and the browser — one implementation, tested once.
- **`selfTimeNs` merges overlapping children**, so parallel tool calls don't
  produce negative self time.

---

## 6a. Abuse protection — worth talking through in an interview

This started as a user question ("what if someone spams requests and I get
billed?") and turned into a real design gap. The *reasoning* is the interesting
part, not the feature list.

### Step 1 — locate the actual attack surface

The instinct was that Cloudflare R2 was the exposure. It is not: the bucket has
no public URL and no presigned uploads, so the only writer is the collector, and
only after a request passes auth. R2's free tier is also 10 GB with **no egress
fees**, and measured compression here is 234×.

The real exposure was the ingest endpoint — which, on checking, had **no rate
limiting at all**.

### Step 2 — rule out the scenario that cannot happen

Next question: "couldn't someone create 100,000 accounts?" Enumerating every
route showed **six endpoints, none of which creates a project**. The only
`INSERT INTO projects` lives in `migrate.ts`, a CLI script run from a laptop
with the database URL — unreachable over HTTP.

So there is no signup, and the attacker has exactly one path: steal the single
ingest key.

Worth saying plainly in an interview: *the first fix is knowing which threats
are real.* A signup-flooding defence here would have been effort spent on a
threat the architecture already precludes.

### Step 3 — find the gap that was real

The first fix added a span quota. Then the arithmetic:

```
250,000 spans × unique 100 KB payloads = ~24 GB  →  238% of R2's 10 GB free tier
```

**A row quota does not bound bytes.** Unique payloads defeat content-addressed
dedup completely — different content, different hash, nothing collapses — so an
attacker could stay entirely inside the row limit and still blow past the free
tier. The row quota protected Postgres and did nothing for the storage bill.

### The four layers, and what each is actually for

| Layer | Default | Bounds | Env var |
| ----- | ------- | ------ | ------- |
| Ingest rate limit (per API key) | 120/min | request rate | `RATE_LIMIT_INGEST_PER_MIN` |
| Read rate limit (per IP) | 300/min | scraping the public UI | `RATE_LIMIT_READ_PER_MIN` |
| Spans per project | 250,000 | Postgres rows (Neon 0.5 GB) | `MAX_SPANS_PER_PROJECT` |
| **Stored bytes (global)** | **5 GB** | **the R2 bill** | `MAX_STORAGE_BYTES` |
| Single payload size | 1 MB | per-request inflation | `MAX_PAYLOAD_BYTES` |

Rate limits bound requests *per minute*; the quotas bound *cumulative* data. A
polite attacker under the rate limit could still fill storage over days — which
is exactly why both kinds are needed.

### Design details worth defending

- **Ingest is keyed by API key, not IP.** An SDK behind a corporate NAT shares
  one IP with everyone there, so an IP-keyed limit throttles honest users, while
  a key leaked across many IPs slips straight through. Read routes are keyed by
  IP because they are unauthenticated.
- **Deduped content is exempt from the byte ceiling** — it adds a reference, not
  bytes, so a legitimate repeated system prompt keeps working at quota.
- **Over-quota degrades, it does not reject.** The span still ingests (202) and
  the payload is replaced with a `__truncated` marker explaining why. Losing one
  blob is better than losing the trace.
- **The span quota reads `SUM(span_count)` from `traces`**, not
  `COUNT(*) FROM spans` — reusing the denormalised rollup means a small-table
  scan instead of scanning the largest table on every ingest.
- **`SUM(stored_bytes)` is cached 5 s.** It runs per offloaded payload; an
  uncached aggregate on each would be a self-inflicted hot spot.

### Verified, not assumed

Tested with deliberately tiny limits (`MAX_PAYLOAD_BYTES=20000`,
`MAX_STORAGE_BYTES=3000`):

```
oversized 50KB        HTTP 202  → {"__truncated":true,"reason":"payload exceeds 20000 byte limit"}
10KB w/ 3KB ceiling   HTTP 202  → {"__truncated":true,"reason":"storage quota reached"}
blob ledger: 0 blobs, 0 bytes   → nothing reached storage
```

Rate limiting verified separately: with `RATE_LIMIT_READ_PER_MIN=5`, requests
1–5 returned 200 and 6–8 returned 429.

### Known limits — say these before being asked

- **Counters are in-memory**, so they are per-instance. Correct for one Render
  service; a multi-instance deployment needs Redis. This is a scaling seam, not
  an oversight.
- **No key rotation endpoint.** A leaked key means deleting the project row
  (spans cascade) and re-running `db:migrate`.
- **No GC for orphaned blobs.** `ref_count` increments but never decrements, so
  deleting traces leaves objects in storage. Bounded by `MAX_STORAGE_BYTES` so
  it cannot run away, but the reclamation path does not exist.

---

## 7. Running it

```bash
nvm use                 # Node 24 (.nvmrc)
corepack enable pnpm
pnpm install
pnpm infra              # docker: Postgres, Redis, MinIO
pnpm db:migrate         # prints PROJECT_ID + INGEST_KEY once — only the hash is stored
pnpm build

pnpm server             # terminal 1 → :4000
pnpm web                # terminal 2 → :3000

INSPECTOR_KEY=insp_... pnpm demo
```

**`--env-file`**: `packages/server/package.json`'s `start` script is
`node --enable-source-maps --env-file=../../.env dist/main.js`. Node parses
`.env` into `process.env` *before* any module loads, so `loadConfig()` needed no
change — it still just reads `process.env`. No dotenv dependency.

Caveats: the path is relative to the *working directory* (pnpm runs from
`packages/server/`, so `../../.env` is the repo root), and Node **throws** if the
file is missing — hence `start:bare` for production, where env vars come from
the platform dashboard.

**MinIO bucket** must exist:

```bash
docker compose exec minio mc alias set local http://localhost:9000 inspector inspector123
docker compose exec minio mc mb local/inspector-payloads
```

**Ingest keys** are printed once by `pnpm db:migrate`, on the first run against
an empty database. Only the SHA-256 is stored, so a lost key cannot be
recovered — generate a new project instead. Keys are per-database, so local and
Neon each have their own.

---

## 8. Verified end-to-end output

```
TRACE  POST /api/chat   1331ms  spans=8  errors=1  tokens=102093  cost=$0.06092500

span                      kind                 ms   ttft  tokens      cost  st
POST /api/chat            agent_step         1331                           ok
  build prompt            prompt_assembly       9                           ok
  pgvector search         retrieval           242                           ok
  answer                  agent_step          504                           ok
    chat claude-opus-5    llm_call            502    294   53657  $0.03283  ok
  sql_query               tool_call           161                           ok
  chat claude-opus-5      llm_call            248                          error  ← 529
  chat claude-opus-5      llm_call            165          48436  $0.02810  ok
```

Produced from ordinary application code with no manual span plumbing — nesting
comes from `AsyncLocalStorage`.

Storage: `92,202 B logical → 393 B stored (234.61×)`, 4 blobs, 6 references.

---

## 9. Networking notes (came up in discussion)

Everything in this project is **TCP** — verified, no Unix domain sockets
anywhere. `app.listen({ port, host })`, never `{ path }`.

Why: the collector receives spans from an SDK running in *someone else's*
application, potentially on another host. Postgres and Redis are local in Docker
now but hosted (Neon, Upstash) in production. Unix sockets only work when both
ends are on one machine — they'd fit a sidecar or local batching agent (what the
OTel Collector does), not this.

A socket is the OS handle for one end of a connection, modelled as a file — which
is why `lsof` finds it. In `lsof -ti:4000`, `-i:4000` filters to that port and
`-t` prints only the PID so it can pipe into `kill`. Add `-P` to see `4000`
rather than the `/etc/services` name (`terabase`).

`kill` sends SIGTERM, which the collector handles: drain in-flight requests,
close the pool. `kill -9` skips that and leaks a Neon connection slot.

---

## 10. Outstanding

**Security**

- [ ] **Rotate the Neon password** — it was pasted into chat and is in history.
- [ ] `git init` — `.gitignore` is written and covers `.env`, but nothing is
      committed yet.

**Correctness**

- [ ] The demo uses a fake client emitting real Anthropic stream event shapes.
      The instrumentation path is genuinely exercised, but it has **never run
      against the live Anthropic API**. Swapping `new FakeAnthropic()` for
      `new Anthropic()` is the only change needed — worth doing once, since it's
      the first thing a reviewer would try.

**Not built (deliberately deferred)**

- Live view via Redis pub/sub — `GET /v1/live` (SSE) is designed, not
  implemented.
- **The collector is deployed and serving** at
  `llm-inspector-collector.onrender.com` — `/health` 200 in ~1s, `/v1/traces`
  returning real data from Neon. The UI (Vercel) and R2 are not yet set up, so
  payloads currently stay inline in Postgres.

  **Deploys are triggered by hook, not by Render's GitHub App.** Auto-deploy is
  not used on this account, so `.github/workflows/deploy-backend.yml` POSTs the
  service's Deploy Hook (`RENDER_DEPLOY_HOOK` secret) on any push touching
  `packages/server/**`, `packages/protocol/**`, `pnpm-lock.yaml`, or
  `render.yaml` — matching the pattern already used in CloudAIr. Protocol is in
  that list deliberately: the collector imports it via `workspace:*`, so a
  protocol-only change still needs a redeploy.

  Render's free tier sleeps after ~15 min idle (~30 s cold start on a
  recruiter's click). The keep-alive workflow pings **`/health`, not `/ready`**
  — `/health` deliberately does not touch Postgres, because a DB-touching ping
  every 10 minutes would burn ~90 of Neon's 100 free CU-hours per month purely
  to avoid a cold start. Verified by stopping Postgres: `/health` returned 200,
  `/ready` returned 503.
- `ref_count` on `payload_blobs` increments but nothing decrements it — there is
  no GC for orphaned blobs. Now bounded by `MAX_STORAGE_BYTES` so it cannot run
  away, but the reclamation path still does not exist. Confirmed during quota
  testing: truncating the ledger left 4 objects orphaned in MinIO.
- Rate-limit counters are in-memory and therefore per-instance. Correct for a
  single Render service; multi-instance needs Redis (§6a).
- No key-rotation endpoint. A leaked ingest key means deleting the project row
  and re-running `db:migrate`.
- Head-based sampling (`sampleRate`) — a designed seam, not written.

**Scaling seams (for interviews, not to build)**

- Kafka: the collector already writes behind a queue interface.
- ClickHouse: spans are append-only, immutable, time-ordered — move `spans`
  there, keep `traces` in Postgres.
- The valuable answer is *"here is the seam, here is the trigger volume, and
  here is why it isn't worth it yet."*
