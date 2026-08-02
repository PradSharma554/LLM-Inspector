import type { Span, Trace } from "@llm-inspector/protocol";
import { PROTOCOL_VERSION } from "@llm-inspector/protocol";
import { runDetached } from "./context.js";

export interface ExporterOptions {
  endpoint: string;
  apiKey: string;
  /** Flush when this many spans are buffered. */
  batchSize?: number;
  /** Flush at least this often, even if the batch is not full. */
  flushIntervalMs?: number;
  /**
   * Hard cap on buffered spans. On overflow the OLDEST are dropped and counted.
   *
   * Bounded on purpose: an unbounded buffer in a library turns a collector
   * outage into an OOM in the host application, which is far worse than losing
   * observability data.
   */
  maxBufferSize?: number;
  /** Called on export failure. Defaults to silence — never throws into user code. */
  onError?: (err: unknown) => void;
}

/**
 * Buffers spans and ships them to the collector in batches.
 *
 * Two invariants this class exists to guarantee:
 *
 *   1. NEVER THROW into user code. An observability tool that can break the
 *      application it observes is worse than no observability at all. Every
 *      public method swallows its errors.
 *   2. NEVER BLOCK the caller. `record()` is a synchronous array push; the
 *      network happens on a timer, off the caller's critical path.
 */
export class Exporter {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #batchSize: number;
  readonly #maxBufferSize: number;
  readonly #onError: (err: unknown) => void;

  #spans: Span[] = [];
  #traces = new Map<string, Trace>();
  #dropped = 0;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #closed = false;

  constructor(opts: ExporterOptions) {
    this.#endpoint = opts.endpoint.replace(/\/+$/, "");
    this.#apiKey = opts.apiKey;
    this.#batchSize = opts.batchSize ?? 128;
    this.#maxBufferSize = opts.maxBufferSize ?? 4096;
    this.#onError = opts.onError ?? (() => {});

    const interval = opts.flushIntervalMs ?? 2000;
    this.#timer = setInterval(() => void this.flush(), interval);
    // Do not hold the process open just to flush telemetry. A CLI that finishes
    // its work should exit; `shutdown()` handles the final drain explicitly.
    this.#timer.unref?.();
  }

  /** Buffer a trace. Cheap and synchronous. */
  recordTrace(trace: Trace): void {
    if (this.#closed) return;
    this.#traces.set(trace.id, trace);
  }

  /** Buffer a span. Cheap and synchronous. */
  recordSpan(span: Span): void {
    if (this.#closed) return;

    if (this.#spans.length >= this.#maxBufferSize) {
      // Drop oldest rather than newest: recent spans are more likely to be the
      // ones a developer is currently debugging.
      this.#spans.shift();
      this.#dropped++;
    }
    this.#spans.push(span);

    if (this.#spans.length >= this.#batchSize) void this.flush();
  }

  /**
   * Ship buffered spans. Safe to call concurrently — overlapping calls
   * serialise behind the in-flight request rather than double-sending.
   */
  async flush(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    if (this.#spans.length === 0 && this.#dropped === 0) return;

    const spans = this.#spans;
    const traces = [...this.#traces.values()];
    const dropped = this.#dropped;
    this.#spans = [];
    this.#traces.clear();
    this.#dropped = 0;

    this.#inFlight = this.#send(traces, spans, dropped).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #send(traces: Trace[], spans: Span[], dropped: number): Promise<void> {
    const body = JSON.stringify({ v: PROTOCOL_VERSION, traces, spans, droppedSpans: dropped });

    try {
      // Detached: without this, wrapping a client that the exporter itself uses
      // would trace this very request, generating a span, triggering an export.
      const res = await runDetached(() =>
        fetch(`${this.#endpoint}/v1/traces`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        }),
      );

      if (!res.ok) {
        // 503 means the collector is shedding load. Re-buffer so the data
        // survives a transient outage; anything else is likely permanent
        // (bad key, malformed batch) and retrying would just loop.
        if (res.status === 503) this.#requeue(spans, traces);
        this.#onError(new Error(`export failed: HTTP ${res.status}`));
      }
    } catch (err) {
      // Network error — re-buffer and let the next tick retry.
      this.#requeue(spans, traces);
      this.#onError(err);
    }
  }

  /** Return spans to the buffer after a retryable failure, respecting the cap. */
  #requeue(spans: Span[], traces: Trace[]): void {
    if (this.#closed) return;
    for (const t of traces) if (!this.#traces.has(t.id)) this.#traces.set(t.id, t);

    const room = this.#maxBufferSize - this.#spans.length;
    if (room <= 0) {
      this.#dropped += spans.length;
      return;
    }
    if (spans.length > room) {
      this.#dropped += spans.length - room;
      spans = spans.slice(spans.length - room);
    }
    this.#spans.unshift(...spans);
  }

  /** Final drain. Call before process exit so the last batch is not lost. */
  async shutdown(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush().catch(() => {});
    this.#closed = true;
  }

  /** Introspection, for tests and for surfacing loss in the UI. */
  get stats(): { buffered: number; dropped: number } {
    return { buffered: this.#spans.length, dropped: this.#dropped };
  }
}
