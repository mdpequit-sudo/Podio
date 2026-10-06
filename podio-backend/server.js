require("dotenv").config();
// Reservation times are wall-clock strings (e.g. "15:30"). Render runs in UTC,
// so pin the timezone or a 3:30 PM booking would fire at 11:30 PM Manila time.
process.env.TZ = process.env.TZ || "Asia/Manila";

const express = require("express");
const cors = require("cors");
const db = require("./db");
const { requireStaff } = require("./auth");
const { sendReservationConfirmation } = require("./emailer");
const {
  isKnownStation,
  getStationCapacity,
  getStationRate,
  uid,
  getBookedCount,
  performCheckIn,
  autoCheckInDueReservations,
} = require("./logic");

const app = express();
const isProd = process.env.NODE_ENV === "production";

// ---------- CORS ----------
// Allow the deployed frontend (from FRONTEND_URL) plus any localhost page for development.
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
const allowedOrigins = [
  originOf(process.env.FRONTEND_URL),
  ...(process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()),
].filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      const ok =
        !origin ||
        allowedOrigins.includes(origin) ||
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      cb(null, ok);
    },
  }),
);

// Keep the raw body so webhook signatures can be verified.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// ---------- Public routes ----------
app.get("/", (req, res) => res.send("Podio backend is running."));
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------- Staff PIN for everything under /api (except the webhook) ----------
app.use("/api", (req, res, next) => {
  if (req.method === "POST" && req.path === "/payments/webhook") return next();
  return requireStaff(req, res, next);
});

app.use("/api/payments", require("./payments"));
app.use("/api/feedback", require("./feedback"));

function isToday(ts) {
  const d = new Date(Number(ts));
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

// ---------- State ----------
// Everything the frontend needs: active sessions, pending reservations,
// today's completed log, which items are paid online, and which sessions have feedback.
app.get("/api/state", async (req, res) => {
  // Catch up on any reservation that came due (e.g. while a free-tier server slept).
  await autoCheckInDueReservations();

  const [active, reservations, completedAll, paidRows, ratedRows] =
    await Promise.all([
      db.all(`SELECT * FROM sessions WHERE status = 'active'`),
      db.all(`SELECT * FROM reservations`),
      db.all(`SELECT * FROM sessions WHERE status = 'completed'`),
      db.all(
        `SELECT "refId", SUM(amount) AS paid FROM payments WHERE status = 'paid' GROUP BY "refId"`,
      ),
      db.all(`SELECT "sessionId" FROM feedback WHERE "sessionId" IS NOT NULL`),
    ]);

  const completed = completedAll.filter((s) => isToday(s.endTime));
  const paid = Object.fromEntries(
    paidRows.map((p) => [p.refId, Number(p.paid)]),
  );
  const rated = ratedRows.map((f) => f.sessionId);

  res.json({ active, reservations, completed, paid, rated });
});

// ---------- Availability ----------
app.get("/api/availability", async (req, res) => {
  const { station, start, end, excludeReservationId } = req.query;
  const capacity = getStationCapacity(station);
  const booked = await getBookedCount(
    station,
    Number(start),
    Number(end),
    excludeReservationId,
  );
  res.json({ capacity, booked, full: booked >= capacity });
});

// ---------- Walk-ins ----------
app.post("/api/sessions/walkin", async (req, res) => {
  const { customerName, station, plannedHours } = req.body;
  if (!customerName?.trim())
    return res.status(400).json({ error: "Customer name required." });
  if (!isKnownStation(station))
    return res.status(400).json({ error: "Unknown station." });

  const now = Date.now();
  const hours = Number(plannedHours) > 0 ? Number(plannedHours) : 1;
  const capacity = getStationCapacity(station);
  const booked = await getBookedCount(station, now, now + hours * 3600000);

  if (booked >= capacity) {
    return res
      .status(409)
      .json({ error: `${station} is fully booked (${booked}/${capacity}).` });
  }

  const session = {
    id: uid(),
    customerName: customerName.trim(),
    station,
    ratePerHour: getStationRate(station), // price comes from the server, not the browser
    plannedHours: hours,
    startTime: now,
    status: "active",
    source: "walkin",
  };

  await db.run(
    `INSERT INTO sessions (id, "customerName", station, "ratePerHour", "plannedHours", "startTime", status, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      session.id,
      session.customerName,
      session.station,
      session.ratePerHour,
      session.plannedHours,
      session.startTime,
      session.status,
      session.source,
    ],
  );

  res.status(201).json(session);
});

app.post("/api/sessions/:id/end", async (req, res) => {
  const session = await db.get(`SELECT * FROM sessions WHERE id = $1`, [
    req.params.id,
  ]);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status === "completed")
    return res.status(409).json({ error: "Session already ended." });

  const endTime = Date.now();
  const hours = (endTime - session.startTime) / 3600000;
  const total = Math.round(session.ratePerHour * hours * 100) / 100;

  await db.run(
    `UPDATE sessions SET status = 'completed', "endTime" = $1, total = $2 WHERE id = $3`,
    [endTime, total, session.id],
  );

  res.json({ ...session, status: "completed", endTime, total });
});

// ---------- Reservations ----------
app.post("/api/reservations", async (req, res) => {
  const { customerName, email, station, hours, date, time } = req.body;
  if (!customerName?.trim())
    return res.status(400).json({ error: "Customer name required." });
  if (!isKnownStation(station))
    return res.status(400).json({ error: "Unknown station." });
  if (!DATE_RE.test(date || "") || !TIME_RE.test(time || ""))
    return res.status(400).json({ error: "Date and time required." });

  const h = Number(hours) > 0 ? Number(hours) : 1;
  const start = new Date(`${date}T${time}`).getTime();
  if (Number.isNaN(start))
    return res.status(400).json({ error: "Invalid date or time." });
  const end = start + h * 3600000;
  const capacity = getStationCapacity(station);
  const booked = await getBookedCount(station, start, end);

  if (booked >= capacity) {
    return res.status(409).json({
      error: `${station} is fully booked for that time slot (${booked}/${capacity}).`,
    });
  }

  const reservation = {
    id: uid(),
    customerName: customerName.trim(),
    email: email?.trim() || null,
    station,
    ratePerHour: getStationRate(station), // price comes from the server, not the browser
    hours: h,
    date,
    time,
  };
  await db.run(
    `INSERT INTO reservations (id, "customerName", email, station, "ratePerHour", hours, date, time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      reservation.id,
      reservation.customerName,
      reservation.email,
      reservation.station,
      reservation.ratePerHour,
      reservation.hours,
      reservation.date,
      reservation.time,
    ],
  );

  // Fire-and-forget: email sending never blocks or fails the reservation itself.
  sendReservationConfirmation(reservation);

  res.status(201).json(reservation);
});

app.post("/api/reservations/:id/checkin", async (req, res) => {
  const r = await db.get(`SELECT * FROM reservations WHERE id = $1`, [
    req.params.id,
  ]);
  if (!r) return res.status(404).json({ error: "Reservation not found." });

  const result = await performCheckIn(r);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result.session);
});

app.delete("/api/reservations/:id", async (req, res) => {
  await db.run(`DELETE FROM reservations WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

// ---------- Errors ----------
// Express 5 forwards errors from async routes here. Real messages are shown
// outside production; in production the details stay in the server log.
app.use((err, req, res, next) => {
  console.error("[server error]", err);
  const status = err.status || err.statusCode || 500;
  const message =
    status < 500
      ? err.message
      : isProd
        ? "Server error. Please try again."
        : err.message || "Server error.";
  res.status(status).json({ error: message });
});

process.on("unhandledRejection", (err) =>
  console.error("[unhandledRejection]", err),
);

// ---------- Start ----------
async function main() {
  await db.init();

  // Sweep for due reservations every 5 seconds (the dashboard also triggers
  // a catch-up sweep on each poll, so nothing is missed after a server sleep).
  setInterval(autoCheckInDueReservations, 5000);

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () =>
    console.log(
      `Podio backend running on port ${PORT} (timezone ${process.env.TZ})`,
    ),
  );
}

main().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
