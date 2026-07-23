#!/usr/bin/env node
// Applies voip/migrations/*.sql in lexical order, once each.
// Usage: node voip/migrate.js   (needs DATABASE_URL)
const fs = require("fs");
const path = require("path");
const { getPool } = require("./lib/db");

async function migrate() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voip_schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM voip_schema_migrations WHERE filename = $1", [file]);
    if (rowCount > 0) continue;

    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO voip_schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log("[voip] applied migration", file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  migrate()
    .then(() => { console.log("[voip] migrations up to date"); process.exit(0); })
    .catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { migrate };
