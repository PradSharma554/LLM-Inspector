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

await app.listen({ port: config.PORT, host: config.HOST });
