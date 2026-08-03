import { z } from "zod";

/**
 * Environment config, validated at startup.
 *
 * Deliberately fail-fast: a missing DATABASE_URL should crash the process on
 * boot with a clear message, not surface as a confusing connection error on the
 * first ingest request minutes later.
 */
const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /**
   * Payloads at or below this size stay inline in Postgres; larger ones are
   * promoted to object storage. 4 KB balances avoiding an R2 round-trip for
   * small prompts against keeping Postgres rows narrow — Neon free is 0.5 GB.
   */
  PAYLOAD_INLINE_LIMIT_BYTES: z.coerce.number().int().positive().default(4096),

  /**
   * Max spans buffered in the write queue before the collector sheds load.
   * Bounded on purpose: an unbounded queue converts backpressure into an OOM.
   */
  MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(10_000),

  /** Max ingest body size. Fastify defaults to 1 MB, which batched spans exceed. */
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  // --- Object storage (payload offload) ------------------------------------
  // Optional: without these the collector keeps every payload inline in
  // Postgres, which is fine for local development but will exhaust a 0.5 GB
  // free tier in production.
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default("auto"),

  // --- Abuse limits ---------------------------------------------------------
  // A public collector on a free tier needs a ceiling. Without one, a leaked
  // ingest key lets someone exhaust Neon's 0.5 GB and take the demo down.

  /** Ingest requests per minute, per API key. */
  RATE_LIMIT_INGEST_PER_MIN: z.coerce.number().int().positive().default(120),

  /** Read requests per minute, per IP. The UI is public and unauthenticated. */
  RATE_LIMIT_READ_PER_MIN: z.coerce.number().int().positive().default(300),

  /**
   * Hard ceiling on stored spans per project. Past this, ingest is refused with
   * 429 rather than silently filling the database.
   *
   * At ~1-2 KB per span row, 500k spans is roughly Neon's 0.5 GB free tier.
   * Default is deliberately well below that.
   */
  MAX_SPANS_PER_PROJECT: z.coerce.number().int().positive().default(250_000),

  /**
   * Hard ceiling on bytes written to object storage, across all projects.
   *
   * This is the quota that actually caps the bill, and it is separate from the
   * span count on purpose: the span quota bounds ROWS, not BYTES. An attacker
   * sending 250k spans each carrying a unique 100 KB payload defeats
   * content-addressed dedup completely (different content, different hash) and
   * would write ~24 GB — well past R2's 10 GB free tier — while staying inside
   * the row quota.
   *
   * Default 5 GB: half the free tier, so there is headroom before any charge.
   */
  MAX_STORAGE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024 * 1024),

  /**
   * Largest single payload accepted for offload. Bigger ones are truncated
   * with a marker rather than stored.
   *
   * A prompt or completion beyond this is not useful to read in a UI anyway,
   * and refusing it removes the cheapest way to inflate storage per request.
   */
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Object storage is configured only if every required field is present. */
export function blobConfig(c: Config) {
  if (!c.S3_ENDPOINT || !c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY) {
    return null;
  }
  return {
    endpoint: c.S3_ENDPOINT,
    bucket: c.S3_BUCKET,
    accessKeyId: c.S3_ACCESS_KEY_ID,
    secretAccessKey: c.S3_SECRET_ACCESS_KEY,
    region: c.S3_REGION,
    inlineLimitBytes: c.PAYLOAD_INLINE_LIMIT_BYTES,
    maxPayloadBytes: c.MAX_PAYLOAD_BYTES,
    maxStorageBytes: c.MAX_STORAGE_BYTES,
  };
}
