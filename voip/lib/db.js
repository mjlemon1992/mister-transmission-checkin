// Single pg pool for the voip module. Nothing outside voip/ imports this.
const { Pool } = require("pg");

let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString,
      max: 5,
      // Railway internal Postgres doesn't need SSL; public proxy URLs do.
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(connectionString)
        ? false
        : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => console.error("[voip] pg pool error:", err.message));
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { getPool, query };
