import { z } from "zod";
import { SpanStatus } from "./span.js";

/**
 * Live-view events, published by the collector and consumed over SSE.
 *
 * Deliberately a summary rather than the trace itself. Two reasons:
 *
 * 1. Redis is a fanout bus here, never a store (§1 of ARCHITECTURE.md), and
 *    putting payloads through it would fill a 256 MB free tier immediately.
 * 2. The list view renders exactly these columns. A client that wants spans
 *    already has `GET /v1/traces/:id`, so duplicating them on the bus would
 *    cost bandwidth for data most subscribers discard.
 *
 * Numbers are the post-ingest rollup, so a subscriber can render a row without
 * a follow-up query. `spanCount` grows as later batches arrive for the same
 * trace: a long agent run flushes incrementally, so one trace produces several
 * events and the last one wins.
 */
export const TraceUpdatedEvent = z.object({
  type: z.literal("trace_updated"),
  traceId: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  status: SpanStatus,
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative().nullable(),
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative().nullable(),
  /** Collector wall-clock at publish. Lets a client drop out-of-order events. */
  at: z.iso.datetime(),
});
export type TraceUpdatedEvent = z.infer<typeof TraceUpdatedEvent>;

export const LiveEvent = z.discriminatedUnion("type", [TraceUpdatedEvent]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** Redis pub/sub channel carrying {@link LiveEvent}. */
export const LIVE_CHANNEL = "llm-inspector:live";
