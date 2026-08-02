# Deploying

Four services, all on free tiers. Roughly 30 minutes end to end.

| Service | Host | Free tier |
| ------- | ---- | --------- |
| Database | Neon | 0.5 GB, 100 CU-hours/mo, scales to zero after 5 min |
| Payload storage | Cloudflare R2 | 10 GB, no egress fees |
| Collector + API | Render | 512 MB, **sleeps after ~15 min idle** |
| Web UI | Vercel | 100 GB bandwidth |

Redis is not required to deploy — it is only used by the live-view feature,
which is designed but not built.

---

## Order matters

Deploy back to front, because each step needs values from the previous one:

```
Neon  →  R2  →  Render (needs both)  →  Vercel (needs Render's URL)
```

---

## 1. Neon (already done)

The project exists and the schema is applied. To confirm:

```bash
NEON_URL=$(grep '^NEON_DATABASE_URL=' .env | cut -d= -f2-)
docker run --rm -i postgres:17-alpine psql "$NEON_URL" -c "\dt"
```

You should see `payload_blobs`, `projects`, `spans`, `traces`.

> **Rotate the password first.** It was pasted into a chat session, so treat it
> as compromised. Neon Console → your project → Roles → Reset password. Then
> update `.env` locally and use the new string everywhere below.

Use the **pooled** connection string — the hostname contains `-pooler`. Neon
scales compute to zero after ~5 minutes idle, and holding a hot pool against a
direct endpoint is the classic serverless-Postgres footgun.

## 2. Cloudflare R2

1. Cloudflare dashboard → **R2** → *Create bucket* → name it
   `llm-inspector-payloads`.
2. **R2 → Manage API Tokens → Create API Token**, with *Object Read & Write*
   scoped to that bucket.
3. Copy three values: **Access Key ID**, **Secret Access Key**, and the
   **S3 API endpoint** (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

The code is S3-compatible and already runs against MinIO locally, so nothing
changes but the environment variables.

## 3. Render — collector

`render.yaml` is in the repo, so Render can read it directly.

1. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**.
2. Connect `PradSharma554/LLM-Inspector`. Render finds `render.yaml`.
3. Set the secret env vars it prompts for (`sync: false` in the blueprint):

   | Variable | Value |
   | -------- | ----- |
   | `DATABASE_URL` | the **pooled** Neon string |
   | `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
   | `S3_BUCKET` | `llm-inspector-payloads` |
   | `S3_ACCESS_KEY_ID` | from step 2 |
   | `S3_SECRET_ACCESS_KEY` | from step 2 |

4. Deploy, then verify:

   ```bash
   curl https://llm-inspector-collector.onrender.com/health
   ```

   The first request wakes the service and can take ~30 s.

**Why `start:bare` and not `start`.** The `start` script passes
`--env-file=../../.env`, and Node **throws** if that file is missing — which it
is on Render, where env vars come from the dashboard. The blueprint's
`startCommand` runs `node packages/server/dist/main.js` directly.

**Why the build runs from the repo root.** The server imports
`@llm-inspector/protocol` via `workspace:*`, so pnpm has to install the whole
workspace and build protocol first. Building only `packages/server` fails to
resolve the import.

## 4. Migrate the production database

Run once against Neon, from your machine:

```bash
cd packages/server
DATABASE_URL="<pooled neon url>" node dist/db/migrate.js
```

It is idempotent — already-applied migrations are skipped. On a database with
no projects it prints a `PROJECT_ID` and `INGEST_KEY`. **Copy the key: only its
SHA-256 is stored and it cannot be recovered.**

## 5. Vercel — web UI

1. [vercel.com/new](https://vercel.com/new) → import the repo.
2. Leave the build settings alone; `vercel.json` handles the monorepo.
3. Add one environment variable:

   | Variable | Value |
   | -------- | ----- |
   | `NEXT_PUBLIC_API_BASE` | `https://llm-inspector-collector.onrender.com` |

4. Deploy.

`NEXT_PUBLIC_` is required — the payload viewer calls the collector from the
browser, so the value has to be inlined into the client bundle. Changing it
later needs a redeploy, not just an env-var edit.

## 6. Send a trace

```bash
INSPECTOR_ENDPOINT=https://llm-inspector-collector.onrender.com \
INSPECTOR_KEY=insp_...  \
node examples/agent-demo.mjs
```

Then open the Vercel URL.

---

## The cold-start problem

Render's free tier sleeps after ~15 minutes idle, so a recruiter clicking your
link waits ~30 s on an empty page. Options, best first:

1. **Seed a demo trace and make the landing page resilient.** The list already
   renders a clear message rather than an error when the collector is
   unreachable — worth extending it to say "waking the backend, ~30s".
2. **Keep-alive ping.** A GitHub Action hitting `/health` every 10 minutes.
   Cheap, though it burns free-tier hours.
3. **Railway instead of Render.** No sleeping, but the free allowance is
   credit-based and runs out.

Do not put the collector on Vercel functions. The in-memory batch queue does not
survive between invocations, so you would lose batching entirely and pay a cold
start on every flush. The collector needs a long-lived process.

---

## Free-tier ceilings to watch

- **Neon 0.5 GB.** With R2 offload, spans are ~1–2 KB each, so this is roughly
  250k–500k spans. Check with:
  ```sql
  SELECT pg_size_pretty(pg_database_size(current_database()));
  ```
- **Neon 100 CU-hours/month.** Scale-to-zero means an idle project burns
  nothing; a keep-alive ping that touches the database does.
- **R2 10 GB.** Content-addressed dedup plus gzip measured 234× on demo data, so
  this is effectively unreachable for a portfolio project.
- **Render 512 MB RAM.** The collector's bounded buffer caps memory growth by
  design; the batch queue sheds load with a 503 rather than growing without
  limit.

---

## Pre-deploy checklist

- [ ] Neon password rotated
- [ ] Pooled connection string (`-pooler` in hostname), not direct
- [ ] R2 bucket created, token scoped to that bucket only
- [ ] `pnpm build && pnpm test` passes locally (41 tests)
- [ ] `.env` still gitignored — `git check-ignore -v .env`
- [ ] Migration run against Neon, ingest key saved somewhere safe
- [ ] `NEXT_PUBLIC_API_BASE` points at the Render URL, no trailing slash
