import postgres from "postgres";
import type { Config } from "../config.js";

export type Sql = postgres.Sql<{}>;

/**
 * A queryable handle: either the pool or an open transaction.
 *
 * Repository functions take this rather than `Sql` so they compose inside
 * `sql.begin()`. Using `Sql` there would be wrong in both directions — it
 * fails to typecheck against a transaction, and it would advertise
 * connection-lifecycle methods (`END`, `CLOSE`) that a repository must never
 * call.
 */
export type Queryable = Sql | postgres.TransactionSql<{}>;

/**
 * Create the Postgres client.
 *
 * `postgres.js` over `pg`: it pipelines queries, uses prepared statements by
 * default, and its tagged-template API produces parameterised queries — there
 * is no code path where a value is concatenated into SQL.
 *
 * Neon note: use the POOLED connection string (hostname contains "-pooler").
 * Neon scales compute to zero after ~5 minutes idle, so the first query after
 * an idle period pays a cold start. Keep `idle_timeout` well below that so we
 * are not holding connections open against a suspended compute.
 */
export function createDb(config: Config): Sql {
  const isNeon = config.DATABASE_URL.includes("neon.tech");

  return postgres(config.DATABASE_URL, {
    max: isNeon ? 10 : 20,
    idle_timeout: 30,
    connect_timeout: 15,
    // Neon requires TLS. `sslmode=require` in the URL covers it, but being
    // explicit means a URL missing the parameter still connects securely.
    ssl: isNeon ? "require" : false,
    // Silence postgres.js's own notice logging; Fastify's logger owns output.
    onnotice: () => {},
  });
}
