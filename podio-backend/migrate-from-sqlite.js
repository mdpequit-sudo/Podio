// One-time script: copies your existing podio.db (SQLite) into Postgres/Supabase.
// Run it once from this folder AFTER setting DATABASE_URL in .env:
//   npm run migrate
// It is safe to re-run: rows that already exist are skipped.
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const db = require("./db");

async function main() {
  const file = path.join(__dirname, "podio.db");
  if (!fs.existsSync(file)) {
    console.log("No podio.db found next to this script. Nothing to migrate.");
    return;
  }

  await db.init();
  const sqlite = new DatabaseSync(file);

  const sessions = sqlite.prepare("SELECT * FROM sessions").all();
  let s = 0;
  for (const r of sessions) {
    const res = await db.run(
      `INSERT INTO sessions (id, "customerName", station, "ratePerHour", "plannedHours", "startTime", "endTime", status, source, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id,
        r.customerName,
        r.station,
        r.ratePerHour,
        r.plannedHours ?? null,
        r.startTime,
        r.endTime ?? null,
        r.status || "active",
        r.source || "walkin",
        r.total ?? null,
      ],
    );
    s += res.rowCount;
  }

  // Older databases may not have an email column on reservations.
  const reservations = sqlite.prepare("SELECT * FROM reservations").all();
  let v = 0;
  for (const r of reservations) {
    const res = await db.run(
      `INSERT INTO reservations (id, "customerName", email, station, "ratePerHour", hours, date, time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        r.id,
        r.customerName,
        r.email ?? null,
        r.station,
        r.ratePerHour,
        r.hours,
        r.date,
        r.time,
      ],
    );
    v += res.rowCount;
  }

  console.log(
    `Migrated ${s} of ${sessions.length} sessions and ${v} of ${reservations.length} reservations.`,
  );
}

main()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
