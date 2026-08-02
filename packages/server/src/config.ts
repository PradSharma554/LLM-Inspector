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
  };
}
