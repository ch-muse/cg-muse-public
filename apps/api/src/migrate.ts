import dotenv from "dotenv";
import { Client } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../migrations");

async function listMigrationFiles(): Promise<string[]> {
  const files = await fs.readdir(migrationsDir);
  return files
    .filter((file) => file.match(/^\d+_.+\.sql$/))
    .sort((a, b) => a.localeCompare(b));
}

async function ensureSchemaMigrations(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrations(client: Client): Promise<Set<string>> {
  const res = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  return new Set(res.rows.map((row) => row.filename));
}

async function applyMigration(client: Client, filename: string) {
  const filePath = path.join(migrationsDir, filename);
  const sql = await fs.readFile(filePath, "utf8");
  await client.query("BEGIN");
  try {
    if (sql.trim()) {
      await client.query(sql);
    }
    await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    await client.query("COMMIT");
    console.log(`Applied ${filename}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function main() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureSchemaMigrations(client);
    const files = await listMigrationFiles();
    const done = await appliedMigrations(client);
    for (const file of files) {
      if (!done.has(file)) {
        await applyMigration(client, file);
      } else {
        console.log(`Skipped ${file} (already applied)`);
      }
    }
    console.log("Migrations finished");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
