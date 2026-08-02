import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const sql = createDb(config);
const app = await buildApp(config, sql);

/**
 * Graceful shutdown.
 *
 * Render and Railway send SIGTERM before killing the container. Draining
 * in-flight requests and closing the pool cleanly avoids both dropped ingest
 * batches and connection-slot leaks against Neon, which has a modest pooled
 * connection ceiling on the free plan.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app
      .close()
      .then(() => sql.end({ timeout: 5 }))
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      });
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  // A port clash is the single most common local failure, and it is almost
  // always a stale process from an earlier run. A 20-line stack trace buries
  // that; say what happened and how to fix it.
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(
      `\nPort ${config.PORT} is already in use — most likely a collector from an earlier run.\n\n` +
        `  Find it:  lsof -nP -iTCP:${config.PORT} -sTCP:LISTEN\n` +
        `  Stop it:  kill $(lsof -ti:${config.PORT})\n` +
        `  Or use a different port:  PORT=4001 pnpm server\n`,
    );
    process.exit(1);
  }
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
