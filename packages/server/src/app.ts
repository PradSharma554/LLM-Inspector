import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
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

  app.get("/health", async () => {
    // Touch the database so this is a real readiness check rather than a
    // liveness check that passes while Postgres is unreachable.
    await sql`SELECT 1`;
    return { status: "ok", uptime: process.uptime() };
  });

  const bc = blobConfig(config);
  const blobs = bc ? new BlobStore(bc) : null;
  if (!blobs) {
    app.log.warn("object storage not configured — payloads stay inline in Postgres");
  }

  registerIngestRoutes(app, sql, config, blobs);
  registerQueryRoutes(app, sql, blobs);

  return app;
}
