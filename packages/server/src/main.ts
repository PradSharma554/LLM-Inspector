import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const sql = createDb(config);
const { app, log, bus } = buildApp(config, sql);

const server = app.listen(config.PORT, config.HOST, () => {
  log.info({ port: config.PORT, host: config.HOST }, "collector listening");
});

/**
 * Graceful shutdown.
 *
 * Render and Railway send SIGTERM before killing the container. Draining
 * in-flight requests and closing the pool cleanly avoids both dropped ingest
 * batches and connection-slot leaks against Neon, which has a modest pooled
 * connection ceiling on the free plan.
 *
 * `server.close()` stops accepting new connections and fires its callback once
 * the in-flight ones finish. It will not, on its own, hang up an idle
 * keep-alive connection, so a client holding one open would stall the drain
 * indefinitely — `closeIdleConnections()` handles exactly that case, and the
 * timeout below is the backstop for a request that never completes.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info({ signal }, "shutting down");

    // Backstop: if the drain has not finished in 10s, stop waiting. A stuck
    // request must not keep the container alive past the platform's own kill
    // timer, which would turn a clean exit into a SIGKILL.
    const forceExit = setTimeout(() => {
      log.error("shutdown timed out — exiting anyway");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.closeIdleConnections();
    server.close((err) => {
      if (err) {
        log.error({ err }, "error during shutdown");
        process.exit(1);
      }
      void Promise.resolve(bus?.close())
        .catch(() => {}) // a stuck Redis must not block the pool close
        .then(() => sql.end({ timeout: 5 }))
        .then(() => process.exit(0))
        .catch((closeErr) => {
          log.error({ err: closeErr }, "error closing database pool");
          process.exit(1);
        });
    });
  });
}

/**
 * A port clash is the single most common local failure, and it is almost
 * always a stale process from an earlier run. A 20-line stack trace buries
 * that; say what happened and how to fix it.
 */
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${config.PORT} is already in use — most likely a collector from an earlier run.\n\n` +
        `  Find it:  lsof -nP -iTCP:${config.PORT} -sTCP:LISTEN\n` +
        `  Stop it:  kill $(lsof -ti:${config.PORT})\n` +
        `  Or use a different port:  PORT=4001 pnpm server\n`,
    );
    process.exit(1);
  }
  log.error({ err }, "failed to start");
  process.exit(1);
});
