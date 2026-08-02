import type { TokenUsage } from "@llm-inspector/protocol";

/**
 * What we learn by watching a stream go past.
 *
 * Everything here is observable ONLY from the event sequence. A wrapper that
 * awaits the final message object cannot produce any of it.
 */
export interface StreamObservation {
  ttftNs: number | null;
  chunkCount: number;
  /** Sampled offsets, capped — a long completion emits thousands of deltas. */
  chunkOffsetsNs: number[];
  usage: TokenUsage | null;
  responseModel: string | null;
  finishReason: string | null;
}

const MAX_SAMPLED_OFFSETS = 256;

/**
 * Accumulates timing and usage from provider stream events.
 *
 * Handles both Anthropic and OpenAI event shapes, because the SDK wraps either.
 * Deliberately duck-typed rather than importing provider SDK types: this
 * package must not depend on `@anthropic-ai/sdk` or `openai`, since the user
 * may have only one of them installed (or a different version).
 */
export class StreamObserver {
  #startNs: bigint;
  #ttftNs: number | null = null;
  #chunkCount = 0;
  #offsets: number[] = [];
  #usage: Partial<TokenUsage> = {};
  #responseModel: string | null = null;
  #finishReason: string | null = null;

  constructor(startNs?: bigint) {
    this.#startNs = startNs ?? process.hrtime.bigint();
  }

  /** Feed one raw stream event. Never throws — a malformed chunk is ignored. */
  observe(event: unknown): void {
    try {
      this.#observeInner(event);
    } catch {
      // An unrecognised or malformed event must not break the user's stream.
    }
  }

  #observeInner(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const e = event as Record<string, any>;

    // ---- Anthropic ------------------------------------------------------
    switch (e.type) {
      case "message_start": {
        // Input tokens (including the cache breakdown) arrive HERE, at the
        // start — not on the final message. Missing this is why naive wrappers
        // cannot price a cached request correctly.
        const u = e.message?.usage;
        if (u) {
          this.#usage.inputTokens = u.input_tokens ?? 0;
          this.#usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          this.#usage.cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
          this.#usage.outputTokens = u.output_tokens ?? 0;
        }
        if (e.message?.model) this.#responseModel = e.message.model;
        return;
      }
      case "content_block_delta": {
        // First content delta defines time-to-first-token. Note we do NOT
        // count `message_start` as the first token — it carries metadata, not
        // content, and treating it as TTFT would understate latency.
        this.#markChunk();
        return;
      }
      case "message_delta": {
        // Running output-token count is updated here, not at message_stop.
        if (e.usage?.output_tokens != null) this.#usage.outputTokens = e.usage.output_tokens;
        if (e.delta?.stop_reason) this.#finishReason = e.delta.stop_reason;
        return;
      }
      case "content_block_start":
      case "content_block_stop":
      case "message_stop":
        return;
    }

    // ---- OpenAI ---------------------------------------------------------
    // Chat completion chunks: { choices: [{ delta, finish_reason }], usage? }
    if (Array.isArray(e.choices)) {
      const choice = e.choices[0];
      const delta = choice?.delta;
      if (delta && (delta.content || delta.tool_calls || delta.refusal)) this.#markChunk();
      if (choice?.finish_reason) this.#finishReason = choice.finish_reason;
      if (e.model) this.#responseModel = e.model;
      if (e.usage) {
        this.#usage.inputTokens = e.usage.prompt_tokens ?? 0;
        this.#usage.outputTokens = e.usage.completion_tokens ?? 0;
        this.#usage.cacheReadTokens = e.usage.prompt_tokens_details?.cached_tokens ?? 0;
        this.#usage.cacheCreationTokens = 0;
      }
      return;
    }
  }

  #markChunk(): void {
    const offset = Number(process.hrtime.bigint() - this.#startNs);
    if (this.#ttftNs === null) this.#ttftNs = offset;
    this.#chunkCount++;
    // Sample rather than store every delta: a long completion emits thousands,
    // and the shape of the curve is what matters, not each point.
    if (this.#offsets.length < MAX_SAMPLED_OFFSETS) this.#offsets.push(offset);
  }

  /**
   * Fold in usage from a final message object, when the caller has one.
   *
   * Non-streaming calls go straight here. For streams this is a safety net:
   * if the provider only reports usage at the end, we still capture it.
   */
  observeFinalUsage(usage: unknown, model?: string): void {
    try {
      if (model) this.#responseModel = model;
      if (typeof usage !== "object" || usage === null) return;
      const u = usage as Record<string, any>;

      // Anthropic shape
      if (u.input_tokens != null || u.output_tokens != null) {
        this.#usage.inputTokens = u.input_tokens ?? this.#usage.inputTokens ?? 0;
        this.#usage.outputTokens = u.output_tokens ?? this.#usage.outputTokens ?? 0;
        this.#usage.cacheReadTokens =
          u.cache_read_input_tokens ?? this.#usage.cacheReadTokens ?? 0;
        this.#usage.cacheCreationTokens =
          u.cache_creation_input_tokens ?? this.#usage.cacheCreationTokens ?? 0;
        return;
      }
      // OpenAI shape
      if (u.prompt_tokens != null || u.completion_tokens != null) {
        this.#usage.inputTokens = u.prompt_tokens ?? 0;
        this.#usage.outputTokens = u.completion_tokens ?? 0;
        this.#usage.cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
        this.#usage.cacheCreationTokens = 0;
      }
    } catch {
      /* ignore */
    }
  }

  result(): StreamObservation {
    const hasUsage =
      this.#usage.inputTokens !== undefined || this.#usage.outputTokens !== undefined;

    return {
      ttftNs: this.#ttftNs,
      chunkCount: this.#chunkCount,
      chunkOffsetsNs: this.#offsets,
      usage: hasUsage
        ? {
            inputTokens: this.#usage.inputTokens ?? 0,
            outputTokens: this.#usage.outputTokens ?? 0,
            cacheReadTokens: this.#usage.cacheReadTokens ?? 0,
            cacheCreationTokens: this.#usage.cacheCreationTokens ?? 0,
          }
        : null,
      responseModel: this.#responseModel,
      finishReason: this.#finishReason,
    };
  }
}

/**
 * Wrap an async iterable so events are observed as they pass through.
 *
 * Critically a PASSTHROUGH: each chunk is yielded to the caller immediately,
 * with observation happening on the same tick. The consumer sees no added
 * latency, which matters because the whole point of streaming is perceived
 * responsiveness — an observability layer that delayed tokens would defeat it.
 */
export async function* observeStream<T>(
  source: AsyncIterable<T>,
  observer: StreamObserver,
): AsyncGenerator<T> {
  for await (const chunk of source) {
    observer.observe(chunk);
    yield chunk;
  }
}
