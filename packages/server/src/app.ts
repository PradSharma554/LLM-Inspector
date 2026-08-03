import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "./config.js";
import type { Sql } from "./db/client.js";
import { BlobStore } from "./storage/blobs.js";
import { blobConfig } from "./config.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerQueryRoutes } from "./routes/query.js";

/**
 * Build the Fastify app.
 *
 * Separated from main.ts so tests can construct an app against a test database
 * without binding a port or installing signal handlers.
 */
export async function buildApp(config: Config, sql: Sql): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Redact auth headers so ingest keys never reach the logs.
      redact: ["req.headers.authorization"],
    },
    // Batched spans routinely exceed Fastify's 1 MB default. Raised
    // deliberately, but still bounded — an unbounded body limit lets one
    // malformed client OOM the process.
    bodyLimit: config.BODY_LIMIT_BYTES,
    // Trust proxy headers: behind Render/Railway the real client IP is in
    // X-Forwarded-For, which matters for per-IP rate limiting later.
    trustProxy: true,
  });

  await app.register(cors, { origin: true });

  /**
   * Rate limiting.
   *
   * Keyed by API key for authenticated ingest, and by IP otherwise. Keying
   * ingest on the key rather than the IP matters: a legitimate SDK behind a
   * corporate NAT shares one IP with everyone else there, so an IP-keyed limit
   * would throttle honest users while a leaked key spread across many IPs would
   * slip straight through.
   *
   * In-memory, so the counter is per-instance. Fine for a single Render
   * service; a multi-instance deployment would move this to Redis.
   */
  await app.register(rateLimit, {
    global: false, // opt in per route — read and write have different budgets
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ")) return `k:${auth.slice(7, 39)}`;
      return `ip:${req.ip}`;
    },
  });

  /**
   * Liveness — is this process up? Deliberately does NOT touch the database.
   *
   * This is the endpoint a keep-alive pinger should hit. Render sleeps on HTTP
   * inactivity and does not care whether a request reached Postgres, so waking
   * the database on every ping would burn Neon compute hours for nothing: at a
   * 10-minute interval that is ~90 CU-hours/month against a 100-hour free
   * budget, purely to avoid a cold start.
   */
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  /**
   * Readiness — can this process actually serve traffic?
   *
   * Touches the database, so it fails when Postgres is unreachable. Use this
   * for deploy gates and real monitoring, not for keep-alive.
   */
  app.get("/ready", async (_request, reply) => {
    try {
      await sql`SELECT 1`;
      return { status: "ok", database: "reachable", uptime: process.uptime() };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      return reply.code(503).send({ status: "degraded", database: "unreachable" });
    }
  });

  const bc = blobConfig(config);
  const blobs = bc ? new BlobStore(bc) : null;
  if (!blobs) {
    app.log.warn("object storage not configured — payloads stay inline in Postgres");
  }

  registerIngestRoutes(app, sql, config, blobs);
  registerQueryRoutes(app, sql, blobs, config);

  return app;
}
