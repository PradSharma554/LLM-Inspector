import type { Express } from "express";
import type { LiveBus } from "../live/bus.js";
import type { Config } from "../config.js";

/**
 * How often to send a comment frame when nothing is happening.
 *
 * Proxies and load balancers close idle connections; Render's edge gives up at
 * around 100 seconds. A periodic no-op keeps the socket alive and, more
 * usefully, surfaces a dead connection to the server promptly rather than
 * leaving a listener registered for a browser that has gone away.
 */
const HEARTBEAT_MS = 25_000;

export function registerLiveRoutes(app: Express, bus: LiveBus | null, config: Config): void {
  /**
   * Live trace feed (SSE).
   *
   * SSE rather than WebSocket: the traffic is one-directional (collector to
   * browser), it survives ordinary HTTP proxies with no upgrade handshake, and
   * EventSource reconnects on its own. A socket would add a second protocol to
   * operate for no capability this view needs.
   *
   * Returns 503 when Redis is not configured. That is a real state in
   * production rather than a hypothetical — the collector runs there without
   * Redis — so it is reported explicitly instead of holding a connection open
   * that can never produce an event.
   */
  app.get("/v1/live", (req, res) => {
    if (!bus) {
      res.status(503).json({
        error: "live_unavailable",
        message: "Live updates require REDIS_URL. Poll /v1/traces instead.",
      });
      return;
    }

    if (bus.listenerCount >= config.MAX_LIVE_CLIENTS) {
      // Each subscriber holds a socket for as long as it likes, so this is the
      // one endpoint where an unauthenticated client can pin a resource
      // indefinitely. Cap it.
      res.status(503).set("Retry-After", "30").json({
        error: "too_many_clients",
        message: "Live feed is at capacity.",
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and several PaaS edges buffer responses by default, which turns
      // a stream into one long-delayed blob. This opts out.
      "x-accel-buffering": "no",
    });

    // Flush the headers immediately. Without this the browser's EventSource
    // stays in CONNECTING until the first event, so a quiet feed looks broken.
    res.flushHeaders();
    res.write(": connected\n\n");

    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;

    const unsubscribe = bus.subscribe((event) => {
      if (projectId && event.projectId !== projectId) return;
      // `event:` names the type so a client can addEventListener per kind
      // rather than switching on a parsed field.
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

    // Clean up on ANY termination, not just a polite close: a browser tab that
    // is killed, a dropped network, or a proxy timeout all land on one of
    // these. Leaking a listener per disconnect would grow the set forever.
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  });
}
