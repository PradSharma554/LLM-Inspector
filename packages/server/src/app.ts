import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pino from "pino";
import { pinoHttp } from "pino-http";
import type { Config } from "./config.js";
import type { Sql } from "./db/client.js";
import { BlobStore } from "./storage/blobs.js";
import { blobConfig } from "./config.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerQueryRoutes } from "./routes/query.js";

/**
 * The app plus the handles main.ts needs at shutdown.
 *
 * Express has no `app.close()` and no `app.log`, so both are returned
 * explicitly rather than hanging off the app object where a reader would have
 * to know they were monkey-patched on.
 */
export interface App {
  app: Express;
  log: pino.Logger;
}

/**
 * Build the Express app.
 *
 * Separated from main.ts so tests can construct an app against a test database
 * without binding a port or installing signal handlers.
 */
export function buildApp(config: Config, sql: Sql): App {
  const app = express();

  // Express advertises itself in an `X-Powered-By` header on every response.
  // Fastify sent nothing equivalent, so leaving it on would be a small
  // regression: free fingerprinting for anyone scanning the collector.
  app.disable("x-powered-by");

  /**
   * Logging.
   *
   * Express ships with none, so pino is wired up by hand: one logger instance
   * for application messages, and pino-http to attach a child logger with a
   * request id to every request as `req.log`. Auth headers are redacted so
   * ingest keys never reach the logs.
   */
  const log = pino({
    level: config.LOG_LEVEL,
    redact: ["req.headers.authorization"],
  });
  app.use(pinoHttp({ logger: log }));

  /**
   * Trust proxy headers: behind Render/Railway the real client IP is in
   * X-Forwarded-For, which matters for per-IP rate limiting.
   *
   * A hop COUNT, never `true`. `true` trusts the whole header, and since the
   * header is client-supplied that hands any caller a one-line rate-limit
   * bypass: prepend a forged address and every request looks like a new
   * client. Counting hops means only the addresses our own proxies appended
   * are believed.
   */
  app.set("trust proxy", config.TRUST_PROXY_HOPS);

  app.use(cors({ origin: true }));

  // Batched spans routinely exceed the 100 KB default of express.json.
  // Raised deliberately, but still bounded — an unbounded body limit lets one
  // malformed client OOM the process.
  app.use(express.json({ limit: config.BODY_LIMIT_BYTES }));

  /**
   * Liveness — is this process up? Deliberately does NOT touch the database.
   *
   * This is the endpoint a keep-alive pinger should hit. Render sleeps on HTTP
   * inactivity and does not care whether a request reached Postgres, so waking
   * the database on every ping would burn Neon compute hours for nothing: at a
   * 10-minute interval that is ~90 CU-hours/month against a 100-hour free
   * budget, purely to avoid a cold start.
   */
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  /**
   * Readiness — can this process actually serve traffic?
   *
   * Touches the database, so it fails when Postgres is unreachable. Use this
   * for deploy gates and real monitoring, not for keep-alive.
   */
  app.get("/ready", async (req, res) => {
    try {
      await sql`SELECT 1`;
      res.json({ status: "ok", database: "reachable", uptime: process.uptime() });
    } catch (err) {
      req.log.error({ err }, "readiness check failed");
      res.status(503).json({ status: "degraded", database: "unreachable" });
    }
  });

  const bc = blobConfig(config);
  const blobs = bc ? new BlobStore(bc) : null;
  if (!blobs) {
    log.warn("object storage not configured — payloads stay inline in Postgres");
  }

  registerIngestRoutes(app, sql, config, blobs);
  registerQueryRoutes(app, sql, blobs, config);

  /**
   * Error handler. Must be registered last, and must declare all four
   * parameters or Express treats it as ordinary middleware.
   *
   * Express 5 forwards a rejected async handler here automatically, which is
   * what makes the `async (req, res)` routes above safe to write without a
   * try/catch around every one.
   *
   * A body that fails to parse arrives here too, from express.json: that is a
   * malformed request, not a server fault, so it is reported as 400.
   */
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode;

    if (status === 400 && err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON." });
      return;
    }
    if (status === 413) {
      res.status(413).json({
        error: "payload_too_large",
        message: `Body exceeds the ${config.BODY_LIMIT_BYTES}-byte limit.`,
      });
      return;
    }

    req.log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal_error", message: "Unexpected server error." });
  });

  return { app, log };
}
