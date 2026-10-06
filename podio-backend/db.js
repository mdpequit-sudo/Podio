require("dotenv").config();
const { Pool, types } = require("pg");

// Postgres returns BIGINT (our millisecond timestamps) and NUMERIC as strings.
// Convert them to plain JS numbers so the rest of the code works unchanged.
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1700, (v) => parseFloat(v));

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Add your Supabase connection string to .env (local) or to Render's environment variables.",
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL. Set DATABASE_SSL=false only for a local Postgres.
  ssl:
    process.env.DATABASE_SSL === "false"
      ? false
      : { rejectUnauthorized: false },
  max: 5,
});

pool.on("error", (err) =>
  console.error("[db] idle client error:", err.message),
);

// Helpers: all(sql, params) -> rows, get(sql, params) -> first row, run(sql, params)
async function all(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}
async function get(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0];
}
async function run(sql, params = []) {
  return pool.query(sql, params);
}

// Creates the tables on first start. Safe to run every time.
// camelCase column names are quoted because Postgres lowercases unquoted names.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      "customerName" TEXT NOT NULL,
      station TEXT NOT NULL,
      "ratePerHour" DOUBLE PRECISION NOT NULL,
      "plannedHours" DOUBLE PRECISION,
      "startTime" BIGINT NOT NULL,
      "endTime" BIGINT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'walkin',
      total DOUBLE PRECISION
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      "customerName" TEXT NOT NULL,
      email TEXT,
      station TEXT NOT NULL,
      "ratePerHour" DOUBLE PRECISION NOT NULL,
      hours DOUBLE PRECISION NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      "refId" TEXT NOT NULL,
      "providerRef" TEXT,
      "checkoutUrl" TEXT,
      amount DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      "createdAt" BIGINT NOT NULL,
      "paidAt" BIGINT
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      "sessionId" TEXT,
      "customerName" TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      "createdAt" BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
    CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments ("refId");
    CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments ("providerRef");
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_session
      ON feedback ("sessionId") WHERE "sessionId" IS NOT NULL;
  `);
}

module.exports = { pool, all, get, run, init };
