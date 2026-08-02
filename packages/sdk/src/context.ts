import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The active trace/span, carried implicitly through async call stacks.
 *
 * This is what lets `inspector.wrap(anthropic)` produce a correctly nested tree
 * without the user threading a context argument through every function. A model
 * call three frames deep inside a retrieval helper still knows its parent.
 *
 * AsyncLocalStorage is the right primitive here rather than a module-level
 * variable: concurrent requests in the same process each get their own store,
 * so two users' traces cannot interleave into one tree.
 */
export interface ActiveContext {
  traceId: string;
  /** Parent for any span created while this context is active. */
  spanId: string | null;
  /**
   * Monotonic origin for this trace, from `process.hrtime.bigint()`.
   *
   * All span timings are offsets from here rather than wall-clock timestamps.
   * hrtime is monotonic — unlike Date.now(), it cannot jump backwards when NTP
   * adjusts the clock, which would otherwise produce negative durations.
   */
  originNs: bigint;
}

const storage = new AsyncLocalStorage<ActiveContext>();

export function getContext(): ActiveContext | undefined {
  return storage.getStore();
}

/** Run `fn` with `ctx` active. Nested calls see the innermost context. */
export function runWithContext<T>(ctx: ActiveContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Nanoseconds elapsed since a trace's origin. */
export function elapsedNs(originNs: bigint): number {
  return Number(process.hrtime.bigint() - originNs);
}

/**
 * Run `fn` with no active context.
 *
 * Used to wrap the exporter's own HTTP calls. Without this, wrapping a client
 * that the exporter itself uses would trace the export request, which would
 * generate a span, which would trigger an export — an infinite loop.
 */
export function runDetached<T>(fn: () => T): T {
  return storage.exit(fn);
}
