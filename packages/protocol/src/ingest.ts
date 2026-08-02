import { z } from "zod";
import { Span, Trace } from "./span.js";

/** Wire format version. Bump on breaking changes; the collector rejects unknown majors. */
export const PROTOCOL_VERSION = 1;

/**
 * A batch of spans sent from SDK to collector.
 *
 * Spans for one trace may arrive across several batches — a long agent run
 * flushes incrementally rather than buffering the whole trace in the client.
 * The collector therefore upserts the trace row and recomputes rollups on
 * every batch, rather than assuming a batch is complete.
 */
export const IngestBatch = z.object({
  v: z.literal(PROTOCOL_VERSION),
  /** Traces referenced by the spans in this batch. Upserted. */
  traces: z.array(Trace).max(256),
  spans: z.array(Span).max(2048),
  /**
   * Spans the SDK dropped because its buffer was full, since the last batch.
   * Surfaced so silent data loss is visible in the UI rather than looking like
   * the application simply did less work.
   */
  droppedSpans: z.number().int().nonnegative().default(0),
});
export type IngestBatch = z.infer<typeof IngestBatch>;

export const IngestResponse = z.object({
  accepted: z.number().int().nonnegative(),
  /** Set when the collector is shedding load; SDK should back off. */
  retryAfterMs: z.number().int().positive().optional(),
});
export type IngestResponse = z.infer<typeof IngestResponse>;

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  /** Per-field validation failures, when the batch was malformed. */
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
