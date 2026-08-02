import { z } from "zod";

/**
 * The kind of work a span represents.
 *
 * These are the node types in the execution tree. `llm_call` is the only kind
 * that carries token usage and TTFT; everything else is timing + payload.
 */
export const SpanKind = z.enum([
  "llm_call", // a single model request (one attempt — retries are separate spans)
  "retrieval", // vector / keyword search
  "tool_call", // function the model asked to run
  "agent_step", // one iteration of an agent loop
  "prompt_assembly", // building the final prompt from templates + context
  "embedding", // embedding generation
  "guardrail", // moderation / validation pass
  "custom", // user-defined via inspector.span()
]);
export type SpanKind = z.infer<typeof SpanKind>;

export const SpanStatus = z.enum(["ok", "error", "cancelled", "in_progress"]);
export type SpanStatus = z.infer<typeof SpanStatus>;

/**
 * OpenTelemetry GenAI semantic convention attributes.
 *
 * These conventions are IN DEVELOPMENT (not stable) and live in their own repo:
 * https://github.com/open-telemetry/semantic-conventions-genai
 *
 * Note `gen_ai.provider.name` — this was renamed from `gen_ai.system` in
 * semconv v1.37.0, and the old name is deprecated. Do not reintroduce it.
 *
 * `gen_ai.usage.input_tokens` INCLUDES cached tokens per the spec, which is why
 * we track the cache breakdown separately in TokenUsage below — you cannot
 * compute cost from the spec field alone.
 */
export const GenAiAttributes = z
  .object({
    "gen_ai.provider.name": z.string().optional(),
    "gen_ai.operation.name": z.string().optional(),
    "gen_ai.request.model": z.string().optional(),
    "gen_ai.response.model": z.string().optional(),
    "gen_ai.request.max_tokens": z.number().int().nonnegative().optional(),
    "gen_ai.request.temperature": z.number().optional(),
    "gen_ai.response.finish_reasons": z.array(z.string()).optional(),
    "gen_ai.usage.input_tokens": z.number().int().nonnegative().optional(),
    "gen_ai.usage.output_tokens": z.number().int().nonnegative().optional(),
  })
  .loose(); // allow provider-specific extras without losing them

export type GenAiAttributes = z.infer<typeof GenAiAttributes>;

/**
 * Token usage, with the cache breakdown kept separate.
 *
 * This split is not cosmetic. Cache reads bill at roughly 0.1x the base input
 * rate and cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL). A cost
 * figure computed from a single "input tokens" number is simply wrong on any
 * cached workload — often by an order of magnitude.
 *
 * `inputTokens` here is the UNCACHED remainder, matching the Anthropic
 * `usage.input_tokens` field. Total prompt size is:
 *   inputTokens + cacheCreationTokens + cacheReadTokens
 */
export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** Structured error detail. Kept small — stack traces go in the payload. */
export const SpanError = z.object({
  type: z.string(),
  message: z.string(),
  /** HTTP status, if the failure came from a provider API. */
  statusCode: z.number().int().optional(),
  /** True when the SDK retried after this failure. */
  retried: z.boolean().default(false),
});
export type SpanError = z.infer<typeof SpanError>;

/**
 * Timing observed from a streaming response.
 *
 * TTFT is the headline number and is ONLY observable from the stream: it is the
 * gap between `message_start` and the first `content_block_delta`. A wrapper
 * that reads only the final message cannot compute it at all.
 */
export const StreamTiming = z.object({
  /** ns from span start to first content token. */
  ttftNs: z.number().int().nonnegative().optional(),
  /** Number of streamed chunks observed. */
  chunkCount: z.number().int().nonnegative().optional(),
  /**
   * ns offsets from span start for each chunk. Sampled, not exhaustive —
   * a long completion can emit thousands of deltas and we do not want to
   * store them all. The collector caps this array.
   */
  chunkOffsetsNs: z.array(z.number().int().nonnegative()).optional(),
});
export type StreamTiming = z.infer<typeof StreamTiming>;

/**
 * A payload attached to a span: prompts, completions, retrieved chunks, tool IO.
 *
 * Discriminated on where the bytes live. The SDK always emits `inline`; the
 * collector decides whether to promote it to `external` (R2) based on size.
 * The UI treats both identically apart from needing a fetch for `external`.
 */
export const SpanPayload = z.discriminatedUnion("storage", [
  z.object({
    storage: z.literal("inline"),
    /** Arbitrary JSON — prompt text, chunk array, tool arguments, etc. */
    data: z.unknown(),
  }),
  z.object({
    storage: z.literal("external"),
    /** R2 object key, content-addressed: payloads/<sha[0:2]>/<sha>.gz */
    ref: z.string(),
    sha256: z.string().length(64),
    /** Uncompressed byte length, so the UI can warn before fetching. */
    sizeBytes: z.number().int().nonnegative(),
  }),
]);
export type SpanPayload = z.infer<typeof SpanPayload>;

/**
 * A single node in the execution tree.
 *
 * Timing note: `startNs` and `endNs` are offsets from the TRACE's start, not
 * wall-clock timestamps. Waterfall rendering needs offsets, and a single
 * monotonic origin per trace avoids clock-skew producing negative durations
 * when spans are created across processes.
 */
export const Span = z.object({
  id: z.uuid(),
  traceId: z.uuid(),
  parentSpanId: z.uuid().nullable().default(null),

  kind: SpanKind,
  name: z.string().min(1).max(512),

  startNs: z.number().int().nonnegative(),
  endNs: z.number().int().nonnegative().nullable().default(null),

  status: SpanStatus.default("ok"),
  error: SpanError.nullable().default(null),

  /**
   * Retry attempt number, 1-based. Retries are FIRST-CLASS SPANS rather than
   * being hidden inside the SDK: seeing attempt 1 fail and attempt 2 succeed
   * in the waterfall is a real debugging feature, and hiding it would make the
   * timeline lie about where the latency went.
   */
  attempt: z.number().int().positive().default(1),

  /** Present on llm_call and embedding spans. */
  usage: TokenUsage.nullable().default(null),
  /** Present on streamed llm_call spans. */
  timing: StreamTiming.nullable().default(null),
  /**
   * Computed cost in USD. Nullable because pricing for an unknown model is
   * unknowable — better an explicit null than a confidently wrong 0.
   */
  costUsd: z.number().nonnegative().nullable().default(null),

  attributes: GenAiAttributes.default({}),
  payloads: z.record(z.string(), SpanPayload).default({}),
});
export type Span = z.infer<typeof Span>;

/** A complete top-level AI request. */
export const Trace = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string().min(1).max(512),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable().default(null),
  status: SpanStatus.default("ok"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Trace = z.infer<typeof Trace>;

/**
 * Rollups denormalised onto the trace row.
 *
 * The trace list is the hottest query in the app. Aggregating over spans on
 * every list request would be the obvious performance mistake, so the collector
 * computes these once at ingest.
 */
export const TraceRollup = z.object({
  durationMs: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});
export type TraceRollup = z.infer<typeof TraceRollup>;
