import { Redis, type RedisOptions } from "ioredis";
import { LIVE_CHANNEL, LiveEvent } from "@llm-inspector/protocol";
import type { Logger } from "pino";

/**
 * Live-event fanout over Redis pub/sub.
 *
 * Optional by design. Redis is not provisioned in production (see story.md),
 * so a missing REDIS_URL must degrade to "no live updates", never to a broken
 * collector — the same posture object storage already takes when the S3_* vars
 * are absent.
 *
 * Pub/sub, not a stream or a list: this is fanout to whoever is watching right
 * now. There is no replay and no delivery guarantee, and that is the correct
 * trade here because the durable copy is already in Postgres. A subscriber
 * that missed an event re-reads `GET /v1/traces`.
 *
 * Two connections rather than one, because a Redis client in subscriber mode
 * cannot issue ordinary commands. Sharing one would make the publish path fail
 * the moment the first SSE client connected.
 */
export class LiveBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly listeners = new Set<(e: LiveEvent) => void>();
  private closed = false;

  constructor(url: string, private readonly log: Logger) {
    const opts: RedisOptions = {
      // Bounded, so a request never queues behind a dead Redis waiting to
      // reconnect. Publish failures are logged and dropped: a live view is a
      // convenience, and it must not add latency to ingest.
      maxRetriesPerRequest: 1,
      // Do not buffer commands while disconnected; fail fast instead.
      enableOfflineQueue: false,
      /**
       * Give up after a bounded number of attempts rather than retrying for
       * the life of the process.
       *
       * Returning null stops reconnection. That matters beyond tidiness: an
       * unbounded retry keeps a libuv timer alive forever, so `quit()` on a
       * client that never connected does not settle and the process cannot
       * exit. A collector whose Redis is unreachable would then hang on
       * SIGTERM until the shutdown backstop killed it.
       */
      retryStrategy: (times: number) => (times > 10 ? null : Math.min(times * 200, 5_000)),
    };

    this.pub = new Redis(url, opts);
    // The subscriber keeps its offline queue. Unlike a publish, SUBSCRIBE is
    // issued once at startup and must survive the gap before the socket is
    // ready; rejecting it there would leave the client permanently silent.
    this.sub = new Redis(url, { ...opts, enableOfflineQueue: true });

    for (const [name, client] of [["pub", this.pub], ["sub", this.sub]] as const) {
      // Without an error listener an ioredis connection failure becomes an
      // unhandled 'error' event and takes the process down — exactly the
      // outcome "optional dependency" is supposed to prevent.
      client.on("error", (err: Error) => {
        if (this.closed) return;
        this.log.warn({ err, client: name }, "redis error — live updates degraded");
      });
    }

    /**
     * Subscribe once the connection is up, and again after every reconnect.
     *
     * Not in the constructor body: the socket is still connecting there, so
     * the command is issued against a stream that is not writeable yet. The
     * subscription is also per-connection state that Redis forgets on a drop,
     * so re-issuing it on each `ready` is what makes the feed survive a
     * restart of Redis rather than going quietly dead.
     */
    const subscribe = () => {
      this.sub.subscribe(LIVE_CHANNEL).catch((err: unknown) => {
        if (this.closed) return;
        this.log.warn({ err }, "redis subscribe failed — live updates unavailable");
      });
    };
    this.sub.on("ready", subscribe);

    this.sub.on("message", (_channel: string, raw: string) => {
      // Anything on this channel is untrusted input: another process, an older
      // deploy mid-rollout, or a stray publisher could put malformed JSON here.
      // Parse through the shared schema and drop what does not fit rather than
      // forwarding it to every connected browser.
      const parsed = LiveEvent.safeParse(safeJson(raw));
      if (!parsed.success) {
        this.log.warn({ issues: parsed.error.issues.slice(0, 3) }, "dropped malformed live event");
        return;
      }
      for (const fn of this.listeners) {
        try {
          fn(parsed.data);
        } catch (err) {
          this.log.error({ err }, "live listener threw");
        }
      }
    });
  }

  /**
   * Publish an event. Never throws and never blocks the caller: ingest must
   * not fail, or slow down, because the live bus is unhealthy.
   */
  publish(event: LiveEvent): void {
    this.pub.publish(LIVE_CHANNEL, JSON.stringify(event)).catch((err: unknown) => {
      this.log.warn({ err }, "live publish failed — event dropped");
    });
  }

  /** Register a listener. Returns its unsubscribe function. */
  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Current subscriber count, for the stats surface. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Release both connections.
   *
   * `quit()` is a command, so it only completes on a live connection; against
   * a Redis that was never reachable it would wait indefinitely. Race it
   * against a short deadline and fall back to `disconnect()`, which tears the
   * socket down locally and cannot block. Shutdown must be bounded whatever
   * state Redis is in.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();

    await Promise.allSettled(
      [this.pub, this.sub].map(async (client) => {
        try {
          await Promise.race([
            client.quit(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("quit timeout")), 1_000)),
          ]);
        } catch {
          // quit() did not land; fall through to the forced teardown below.
        } finally {
          // Always disconnect, even after a clean quit. A pending reconnect
          // timer is not cancelled by quit(), and a stray libuv timer keeps
          // the process alive: verified with getActiveResourcesInfo(), which
          // showed four live Timeouts surviving close() without this.
          client.disconnect();
        }
      }),
    );
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
