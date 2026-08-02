import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";

/**
 * Minimal forward-only migration runner.
 *
 * A tracking table plus lexicographically-ordered .sql files. No down
 * migrations: rolling a schema change backwards in production is almost always
 * worse than rolling forward with a corrective migration, and pretending
 * otherwise invites a false sense of safety.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

const config = loadConfig();
const sql = createDb(config);

const target = new URL(config.DATABASE_URL.replace(/^postgres/, "http")).host;
console.log(`Running migrations against ${target}`);

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

const applied = new Set(
  (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`  skip  ${file} (already applied)`);
    continue;
  }
  const content = await readFile(join(migrationsDir, file), "utf8");
  // Each migration runs in its own transaction: a failure leaves the database
  // at the last good migration rather than half-applied.
  await sql.begin(async (tx) => {
    await tx.unsafe(content);
    await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
  });
  console.log(`  apply ${file}`);
  count++;
}

console.log(count === 0 ? "Already up to date." : `Applied ${count} migration(s).`);

// Seed a development project if none exists, so ingest is usable immediately.
const [existing] = await sql<{ count: string }[]>`SELECT COUNT(*)::text FROM projects`;
if (existing?.count === "0") {
  const key = `insp_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (name, api_key_hash) VALUES ('Development', ${hash}) RETURNING id
  `;
  console.log("\nCreated development project.");
  console.log(`  PROJECT_ID: ${project!.id}`);
  console.log(`  INGEST_KEY: ${key}`);
  console.log("\nStore the key now — only its hash is persisted.");
}

await sql.end();
