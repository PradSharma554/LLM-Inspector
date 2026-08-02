import { randomUUID } from "node:crypto";
import type { Span, SpanKind, SpanPayload, Trace } from "@llm-inspector/protocol";
import { computeCostUsd } from "@llm-inspector/protocol";
import { Exporter, type ExporterOptions } from "./exporter.js";
import { elapsedNs, getContext, runWithContext, type ActiveContext } from "./context.js";
import { StreamObserver, observeStream } from "./stream.js";

export interface InspectorOptions extends ExporterOptions {
  /** Skip instrumentation entirely — for disabling in tests or by env flag. */
  enabled?: boolean;
}

/** Handle given to a span callback, for attaching data as work proceeds. */
export interface SpanHandle {
  setPayload(key: string, data: unknown): void;
  setAttribute(key: string, value: unknown): void;
  setUsage(usage: Span["usage"]): void;
}

export class Inspector {
  readonly #exporter: Exporter;
  readonly #enabled: boolean;

  constructor(opts: InspectorOptions) {
    this.#enabled = opts.enabled ?? true;
    this.#exporter = new Exporter(opts);
  }

  /**
   * Start a new trace. Everything instrumented inside `fn` nests beneath it.
   */
  async trace<T>(name: string, fn: () => Promise<T>, metadata: Record<string, unknown> = {}): Promise<T> {
    if (!this.#enabled) return fn();

    const traceId = randomUUID();
    const originNs = process.hrtime.bigint();
    const startedAt = new Date().toISOString();

    const trace: Trace = {
      id: traceId,
      projectId: "00000000-0000-0000-0000-000000000000", // server derives from API key
      name,
      startedAt,
      endedAt: null,
      status: "in_progress",
      metadata,
    };
    this.#exporter.recordTrace(trace);

    // Emit a root span for the trace itself, so everything inside has a common
    // parent. Without this the waterfall renders as a flat list of siblings
    // with no single bar spanning the whole request.
    const rootSpanId = randomUUID();
    const ctx: ActiveContext = { traceId, spanId: rootSpanId, originNs };

    const emitRoot = (status: "ok" | "error", err?: unknown) => {
      this.#emit({
        id: rootSpanId, traceId, parentSpanId: null,
        kind: "agent_step", name,
        startNs: 0, endNs: elapsedNs(originNs),
        status, error: err ? toSpanError(err) : null, attempt: 1,
        usage: null, timing: null, costUsd: null,
        attributes: {}, payloads: {},
      });
    };

    try {
      const result = await runWithContext(ctx, fn);
      emitRoot("ok");
      this.#exporter.recordTrace({ ...trace, endedAt: new Date().toISOString(), status: "ok" });
      return result;
    } catch (err) {
      emitRoot("error", err);
      this.#exporter.recordTrace({ ...trace, endedAt: new Date().toISOString(), status: "error" });
      throw err; // never swallow the USER's error — only our own
    } finally {
      void this.#exporter.flush();
    }
  }

  /**
   * Record an explicit span for work no proxy can infer — retrieval, tool
   * execution, prompt assembly.
   */
  async span<T>(
    name: string,
    fn: (handle: SpanHandle) => Promise<T>,
    opts: { kind?: SpanKind } = {},
  ): Promise<T> {
    const parent = getContext();
    if (!this.#enabled || !parent) {
      // Outside a trace there is nothing to attach to. Run the work anyway —
      // an un-instrumented call must still execute correctly.
      return fn(noopHandle());
    }

    const spanId = randomUUID();
    const startNs = elapsedNs(parent.originNs);
    const payloads: Record<string, SpanPayload> = {};
    const attributes: Record<string, unknown> = {};
    let usage: Span["usage"] = null;

    const handle: SpanHandle = {
      setPayload: (key, data) => {
        payloads[key] = { storage: "inline", data };
      },
      setAttribute: (key, value) => {
        attributes[key] = value;
      },
      setUsage: (u) => {
        usage = u;
      },
    };

    const childCtx: ActiveContext = { ...parent, spanId };

    try {
      const result = await runWithContext(childCtx, () => fn(handle));
      this.#emit({
        id: spanId, traceId: parent.traceId, parentSpanId: parent.spanId,
        kind: opts.kind ?? "custom", name,
        startNs, endNs: elapsedNs(parent.originNs),
        status: "ok", error: null, attempt: 1,
        usage, timing: null, costUsd: null,
        attributes: attributes as Span["attributes"], payloads,
      });
      return result;
    } catch (err) {
      this.#emit({
        id: spanId, traceId: parent.traceId, parentSpanId: parent.spanId,
        kind: opts.kind ?? "custom", name,
        startNs, endNs: elapsedNs(parent.originNs),
        status: "error", error: toSpanError(err), attempt: 1,
        usage, timing: null, costUsd: null,
        attributes: attributes as Span["attributes"], payloads,
      });
      throw err;
    }
  }

  /**
   * Wrap a provider client so its calls are traced automatically.
   *
   * Returns a Proxy rather than a hand-written facade. Two reasons that matter:
   * the wrapper survives provider SDK upgrades without re-declaring method
   * signatures, and any method we do not instrument passes straight through
   * unchanged — so wrapping can never remove functionality.
   */
  wrap<T extends object>(client: T): T {
    if (!this.#enabled) return client;
    return this.#wrapNode(client, []) as T;
  }

  /** Recursively proxy, instrumenting known terminal methods. */
  #wrapNode(target: any, path: string[]): any {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) {
      return target;
    }

    return new Proxy(target, {
      get: (obj, prop, receiver) => {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof prop === "symbol") return value;

        const nextPath = [...path, prop];
        const dotted = nextPath.join(".");

        // Terminal call sites we instrument.
        if (typeof value === "function") {
          if (dotted === "messages.create" || dotted === "chat.completions.create") {
            return (...args: unknown[]) => this.#instrumentCall(obj, value, args, false);
          }
          if (dotted === "messages.stream") {
            return (...args: unknown[]) => this.#instrumentCall(obj, value, args, true);
          }
          // Any other function: bind and pass through untouched.
          return value.bind(obj);
        }

        // Namespace object (client.messages, client.chat) — keep descending.
        if (value && typeof value === "object" && nextPath.length < 3) {
          return this.#wrapNode(value, nextPath);
        }
        return value;
      },
    });
  }

  /** Instrument one model call: timing, streaming, usage, cost. */
  #instrumentCall(thisArg: unknown, fn: Function, args: unknown[], isStreamHelper: boolean): unknown {
    const ctx = getContext();
    if (!ctx) return fn.apply(thisArg, args); // untraced — call through

    const params = (args[0] ?? {}) as Record<string, any>;
    const model: string | undefined = params.model;
    const wantsStream = isStreamHelper || params.stream === true;

    const spanId = randomUUID();
    const startNs = elapsedNs(ctx.originNs);
    const observer = new StreamObserver();

    const attributes: Record<string, unknown> = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": detectProvider(thisArg, model),
    };
    if (model) attributes["gen_ai.request.model"] = model;
    if (params.max_tokens) attributes["gen_ai.request.max_tokens"] = params.max_tokens;

    const finish = (status: "ok" | "error", err?: unknown) => {
      const obs = observer.result();
      if (obs.responseModel) attributes["gen_ai.response.model"] = obs.responseModel;
      if (obs.usage) {
        attributes["gen_ai.usage.input_tokens"] =
          obs.usage.inputTokens + obs.usage.cacheReadTokens + obs.usage.cacheCreationTokens;
        attributes["gen_ai.usage.output_tokens"] = obs.usage.outputTokens;
      }
      if (obs.finishReason) attributes["gen_ai.response.finish_reasons"] = [obs.finishReason];

      this.#emit({
        id: spanId, traceId: ctx.traceId, parentSpanId: ctx.spanId,
        kind: "llm_call",
        // Span naming follows the OTel GenAI convention:
        // "{gen_ai.operation.name} {gen_ai.request.model}"
        name: model ? `chat ${model}` : "chat",
        startNs, endNs: elapsedNs(ctx.originNs),
        status, error: err ? toSpanError(err) : null, attempt: 1,
        usage: obs.usage,
        timing: obs.ttftNs === null
          ? null
          : { ttftNs: obs.ttftNs, chunkCount: obs.chunkCount, chunkOffsetsNs: obs.chunkOffsetsNs },
        costUsd: computeCostUsd(obs.responseModel ?? model, obs.usage),
        attributes: attributes as Span["attributes"],
        payloads: {
          request: { storage: "inline", data: redactRequest(params) },
        },
      });
    };

    let out: unknown;
    try {
      out = fn.apply(thisArg, args);
    } catch (err) {
      finish("error", err);
      throw err;
    }

    // messages.stream() returns a stream helper object, not a promise.
    if (isStreamHelper && out && typeof (out as any)[Symbol.asyncIterator] === "function") {
      return wrapStreamHelper(out as AsyncIterable<unknown> & object, observer, finish);
    }

    if (out instanceof Promise) {
      return out.then(
        (resolved: any) => {
          // stream:true resolves to an async iterable of chunks.
          if (wantsStream && resolved && typeof resolved[Symbol.asyncIterator] === "function") {
            return wrapAsyncIterable(resolved, observer, finish);
          }
          observer.observeFinalUsage(resolved?.usage, resolved?.model);
          finish("ok");
          return resolved;
        },
        (err: unknown) => {
          finish("error", err);
          throw err;
        },
      );
    }

    finish("ok");
    return out;
  }

  #emit(span: Span): void {
    try {
      this.#exporter.recordSpan(span);
    } catch {
      // Recording telemetry must never break the caller.
    }
  }

  /** Flush and stop. Call before process exit. */
  async shutdown(): Promise<void> {
    await this.#exporter.shutdown();
  }

  get stats() {
    return this.#exporter.stats;
  }
}

// ---------------------------------------------------------------------------

function noopHandle(): SpanHandle {
  return { setPayload: () => {}, setAttribute: () => {}, setUsage: () => {} };
}

function toSpanError(err: unknown): Span["error"] {
  const e = err as any;
  return {
    type: e?.constructor?.name ?? e?.type ?? "Error",
    message: String(e?.message ?? err).slice(0, 2000),
    statusCode: typeof e?.status === "number" ? e.status : undefined,
    retried: false,
  };
}

function detectProvider(client: unknown, model?: string): string {
  const name = (client as any)?.constructor?.name?.toLowerCase() ?? "";
  if (name.includes("anthropic")) return "anthropic";
  if (name.includes("openai")) return "openai";
  if (model?.startsWith("claude")) return "anthropic";
  if (model?.startsWith("gpt") || model?.startsWith("o1")) return "openai";
  return "unknown";
}

/**
 * Keep request payloads small and free of obvious secrets.
 *
 * Full prompt text is genuinely useful for debugging, so it is kept — but the
 * collector offloads anything large to object storage, and an API key that
 * wandered into the params never belongs in a trace.
 */
function redactRequest(params: Record<string, any>): Record<string, unknown> {
  const { apiKey, api_key, authorization, ...rest } = params;
  return rest;
}

/** Wrap a bare async iterable of chunks. */
async function* wrapAsyncIterable(
  source: AsyncIterable<unknown>,
  observer: StreamObserver,
  finish: (status: "ok" | "error", err?: unknown) => void,
): AsyncGenerator<unknown> {
  try {
    yield* observeStream(source, observer);
    finish("ok");
  } catch (err) {
    finish("error", err);
    throw err;
  }
}

/**
 * Wrap a stream-helper object (Anthropic's `messages.stream()`).
 *
 * Proxied rather than replaced so helper methods — `finalMessage()`, `on()`,
 * `abort()` — keep working. Replacing it with a bare generator would silently
 * break every consumer that uses those.
 */
function wrapStreamHelper(
  helper: AsyncIterable<unknown> & object,
  observer: StreamObserver,
  finish: (status: "ok" | "error", err?: unknown) => void,
): object {
  let settled = false;
  const settle = (status: "ok" | "error", err?: unknown) => {
    if (settled) return;
    settled = true;
    finish(status, err);
  };

  return new Proxy(helper, {
    get(target: any, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => {
          const inner = target[Symbol.asyncIterator]();
          return {
            async next(...a: unknown[]) {
              try {
                const r = await inner.next(...a);
                if (r.done) settle("ok");
                else observer.observe(r.value);
                return r;
              } catch (err) {
                settle("error", err);
                throw err;
              }
            },
            async return(v: unknown) {
              settle("ok"); // consumer broke out early
              return inner.return ? inner.return(v) : { done: true, value: v };
            },
            async throw(e: unknown) {
              settle("error", e);
              if (inner.throw) return inner.throw(e);
              throw e;
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;

      // finalMessage() carries authoritative usage — capture it, then settle.
      if (prop === "finalMessage") {
        return async (...a: unknown[]) => {
          try {
            const msg: any = await value.apply(target, a);
            observer.observeFinalUsage(msg?.usage, msg?.model);
            settle("ok");
            return msg;
          } catch (err) {
            settle("error", err);
            throw err;
          }
        };
      }
      return value.bind(target);
    },
  });
}
