# LLM Execution Inspector

Chrome DevTools for AI applications. Trace and inspect every stage of an LLM
request — prompt assembly, retrieval, model calls, tool calls, streaming tokens,
retries, and cost — instead of seeing only the final answer.

> **Live:** [llm-inspector.vercel.app](https://llm-inspector.vercel.app) —
> UI on Vercel, collector on Render, Postgres on Neon, payloads on Cloudflare R2.
>
> Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
> Build story and decisions: [story.md](story.md) ·
> Deployment: [DEPLOY.md](DEPLOY.md)

## Why this is not another wrapper that logs prompts

Three things are hard to get right, and each is a deliberate design decision
here rather than an afterthought:

**Cost is wrong unless you account for prompt caching.** Cache reads bill at
~0.1x the base input rate; writes at 1.25x (5-min TTL) or 2x (1-hour). The
`gen_ai.usage.input_tokens` convention *includes* cached tokens, so pricing from
that single field alone silently overstates cost — on the sample trace in this
repo, by **6.5x** ($0.527 vs the correct $0.081). Token usage is therefore stored
split, and unknown models cost `null` rather than a confident `$0.00` that would
corrupt every aggregate above it.

**Time-to-first-token only exists in the stream.** TTFT is the gap between
`message_start` and the first `content_block_delta`. A wrapper that reads the
final response object cannot compute it at all.

**Storage is the binding constraint, not compute.** Neon's free tier is 0.5 GB,
and one RAG trace with retrieved context runs 50–100 KB. Postgres therefore
holds only what is queried, sorted, filtered or aggregated on (~1–2 KB/span);
payloads go to R2 under `sha256(content)`, so repeated system prompts and chunks
collapse to a single object.

## Stack

TypeScript everywhere — one language, one toolchain, and a wire protocol defined
**once** as a zod schema that the SDK, collector, and UI all import. A protocol
change is a compile error across the workspace rather than a runtime surprise.
(The Go-for-the-collector alternative is considered and rejected in
[ARCHITECTURE.md §7](docs/ARCHITECTURE.md).)

| Layer    | Choice | Why |
| -------- | ------ | --- |
| Protocol | zod 4 | single source of truth, shared by every package |
| Collector| Fastify 5 | schema-based validation/serialisation on a pure-JSON path |
| Database | Postgres via `postgres.js` | pipelining, prepared statements, parameterised by construction |
| Payloads | R2 / MinIO via `@aws-sdk/client-s3` | S3-compatible, so identical code locally and in prod |
| Frontend | Next.js 16 + Tailwind 4 | dense monospace UI, virtualised waterfall |

## Quick start

Requires Node ≥22.13 (pnpm 11 needs `node:sqlite`) and Docker.

```bash
nvm use                     # reads .nvmrc → Node 24
corepack enable pnpm
pnpm install

docker compose up -d        # Postgres :5433, Redis :6379, MinIO :9000
cp .env.example .env

pnpm --filter @llm-inspector/server db:migrate
```

The migration prints a `PROJECT_ID` and `INGEST_KEY` on first run. Only the
key's SHA-256 is stored, so copy it then — it cannot be recovered.

### Running it

Two terminals. The collector reads `.env` via Node's `--env-file`, so neither
command needs environment variables inline.

```bash
pnpm build          # once, after a checkout or a change to packages/
pnpm server         # terminal 1 -> collector on :4000
pnpm web            # terminal 2 -> UI on http://localhost:3000
```

Generate a trace (no API key, no cost — the demo uses a fake client that emits
real Anthropic stream event shapes):

```bash
INSPECTOR_KEY=insp_... pnpm demo
```

| Script | What it does |
| ------ | ------------ |
| `pnpm infra` / `pnpm infra:down` | Postgres, Redis, MinIO via docker compose |
| `pnpm server` | collector on :4000 (built output) |
| `pnpm dev:server` | collector with tsc watch + auto-restart |
| `pnpm web` | Next.js UI on :3000 |
| `pnpm demo` | send a sample trace |
| `pnpm test` | all 41 tests |

## Verified in production

Content-addressed dedup + gzip against Cloudflare R2:

```
72,656 B logical  →  290 B stored   (250× smaller)
```

Same migration and same results on both local Postgres 17 and Neon 18.4:

```
POST /api/chat  spans=7 errors=1 tokens=102668 cost=$0.08099400 dur=4820ms

span                    kind                 ms   ttft att  status
agent run               agent_step         4820          1  ok
  build prompt          prompt_assembly      12          1  ok
  pgvector search       retrieval           297          1  ok
  chat claude-opus-5    llm_call            875          1  error   ← 529, retried
  chat claude-opus-5    llm_call           1440    402   2  ok      ← attempt 2
  sql_query             tool_call           360          1  ok
  chat claude-opus-5    llm_call           1790    288   1  ok
```

Retries are first-class spans rather than being hidden inside the SDK: seeing
attempt 1 fail beside attempt 2 succeeding is the point, and collapsing them
would make the timeline lie about where the latency went.

## Layout

```
packages/protocol/   zod schemas, cache-aware pricing, tree assembly   15 tests
packages/server/     Fastify collector + query API, R2 offload
packages/sdk/        inspector.wrap(client), AsyncLocalStorage, TTFT   26 tests
apps/web/            Next.js DevTools UI — waterfall, flame, inspector
examples/            agent-demo.mjs — runs with no API key
```

## Using the SDK

```ts
import { Inspector } from "@llm-inspector/sdk";
import Anthropic from "@anthropic-ai/sdk";

const inspector = new Inspector({ endpoint: "http://localhost:4000", apiKey: INGEST_KEY });
const anthropic = inspector.wrap(new Anthropic());

await inspector.trace("POST /api/chat", async () => {
  const chunks = await inspector.span("retrieve", async (s) => {
    const docs = await vectorSearch(query);
    s.setPayload("chunks", docs);
    return docs;
  }, { kind: "retrieval" });

  // Traced automatically — nesting comes from AsyncLocalStorage, so no
  // context argument is threaded through application code.
  const stream = anthropic.messages.stream({ model: "claude-opus-5", messages });
  for await (const ev of stream) { /* ... */ }
});
```

## UI

Three views, keyboard-navigable (`j`/`k` to move, `←`/`→` to fold, `Esc` to close):

- **Waterfall** — execution tree with time-scaled bars. A white tick inside each
  LLM bar marks time-to-first-token, so the wait-then-stream split is visible at
  a glance. Virtualised, because a long agent trace is thousands of spans.
- **Flame** — time on x, depth on y. Answers "where did the time actually go",
  which the waterfall does not: a wide bar with narrow children did the work
  itself; one filled by its children was waiting.
- **Inspector** — per-span timing, the token cache split, `gen_ai.*` attributes,
  and raw payloads fetched lazily from object storage on click.

## Notable implementation details

- **Batch insert via `UNNEST`** — `INSERT ... SELECT * FROM UNNEST($1::uuid[], …)`
  inserts N spans in one round trip. A loop of single-row inserts costs N round
  trips, and over a hosted database that latency dominates everything else.
- **`ON CONFLICT DO UPDATE`** makes ingest idempotent, so at-least-once delivery
  from the SDK cannot produce duplicates.
- **No FK on `parent_span_id`** — spans arrive across batches and a child can
  land before its parent. Orphans are promoted to roots at read time instead of
  being rejected at write time.
- **Keyset pagination**, not `OFFSET`: deep pages stay fast and rows shifting
  between requests can't cause skips or repeats.
- **`api_key_hash`, never the key** — a leaked database dump should not hand
  over working write credentials.
- **BIGINT as strings** across the driver boundary, so nanosecond timings above
  2^53 don't silently lose precision.
- **Timings are trace-relative offsets**, not wall-clock, so cross-process clock
  skew can't produce negative durations.
- **Content-addressed payloads** — stored under `sha256(content)`, so a repeated
  system prompt costs one object no matter how many traces reference it. Measured
  on the demo data: **90 KB logical → 393 B stored, 234× smaller** (dedup + gzip).
- **Gzip runs async** (`node:zlib` promisified, on the libuv threadpool). The
  `gzipSync` form blocks the event loop and serialises every concurrent request
  behind it — the single most likely performance bug in a Node collector.
- **jsonb goes in as one JSON array**, expanded server-side with
  `jsonb_array_elements(...) WITH ORDINALITY`. postgres.js escapes strings inside
  array literals, so the obvious `${arr.map(JSON.stringify)}::jsonb[]` silently
  stores a JSON *string* instead of an object; `sql.json()` per element fails
  outright. This one shipped as a bug and was caught by reading the stored rows.
