const db = require("./db");

// Source of truth for capacity AND price. The server never trusts a rate sent
// by the browser. Capacities below match what your dashboard was showing
// (Pod 6, Nook 1, Solo 3, Quad 1). Change them here if that's wrong.
const STATIONS = {
  "Podio Pod": { capacity: 6, ratePerHour: 50 },
  "Podio Nook": { capacity: 1, ratePerHour: 50 },
  "Podio Solo": { capacity: 3, ratePerHour: 50 },
  "Podio Quad": { capacity: 1, ratePerHour: 50 },
};

function isKnownStation(station) {
  return Object.prototype.hasOwnProperty.call(STATIONS, station);
}

function getStationCapacity(station) {
  return isKnownStation(station) ? STATIONS[station].capacity : 0;
}

function getStationRate(station) {
  return isKnownStation(station) ? STATIONS[station].ratePerHour : undefined;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function getSessionRange(s) {
  const end =
    s.status === "completed"
      ? s.endTime
      : s.startTime + (s.plannedHours || 1) * 3600000;
  return [s.startTime, end];
}

// Reservation date/time are wall-clock strings in the business's timezone.
// server.js pins the process timezone to Asia/Manila so this parses correctly
// even when the server (e.g. Render) runs in UTC.
function getReservationRange(r) {
  const start = new Date(`${r.date}T${r.time}`).getTime();
  const end = start + (r.hours || 1) * 3600000;
  return [start, end];
}

// Counts active sessions + reservations of `station` overlapping a time window.
async function getBookedCount(
  station,
  rangeStart,
  rangeEnd,
  excludeReservationId,
) {
  let count = 0;

  const activeSessions = await db.all(
    `SELECT * FROM sessions WHERE station = $1 AND status = 'active'`,
    [station],
  );
  for (const s of activeSessions) {
    const [sStart, sEnd] = getSessionRange(s);
    if (overlaps(sStart, sEnd, rangeStart, rangeEnd)) count++;
  }

  const reservations = await db.all(
    `SELECT * FROM reservations WHERE station = $1`,
    [station],
  );
  for (const r of reservations) {
    if (excludeReservationId && r.id === excludeReservationId) continue;
    const [rStart, rEnd] = getReservationRange(r);
    if (overlaps(rStart, rEnd, rangeStart, rangeEnd)) count++;
  }

  return count;
}

// Converts a pending reservation into an active session. The session clock
// starts at the BOOKED time, and the session keeps the reservation's id so
// online payments made against the reservation still count toward the bill.
// The delete+insert runs in one transaction, and the DELETE "claims" the
// reservation so the 5-second sweep and a manual check-in can't both win.
async function performCheckIn(r) {
  const [schedStart] = getReservationRange(r);
  const capacity = getStationCapacity(r.station);
  const booked = await getBookedCount(
    r.station,
    schedStart,
    schedStart + (r.hours || 1) * 3600000,
    r.id,
  );

  if (booked >= capacity) {
    return {
      ok: false,
      reason: `${r.station} is fully occupied for that reserved slot (${booked}/${capacity}).`,
    };
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `DELETE FROM reservations WHERE id = $1 RETURNING id`,
      [r.id],
    );
    if (claimed.rowCount === 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "That reservation was already checked in or removed.",
      };
    }

    const session = {
      id: r.id,
      customerName: r.customerName,
      station: r.station,
      ratePerHour: r.ratePerHour,
      plannedHours: r.hours,
      startTime: schedStart,
      status: "active",
      source: "reservation",
    };

    await client.query(
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
    await client.query("COMMIT");
    return { ok: true, session };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Auto check-in any reservation whose scheduled time has arrived. Runs on a
// timer AND whenever the dashboard polls, so a sleeping free-tier server
// catches up as soon as it wakes. Overlapping runs are skipped.
let sweeping = false;
let lastSweepAt = 0;
async function autoCheckInDueReservations() {
  if (sweeping || Date.now() - lastSweepAt < 2000) return;
  sweeping = true;
  try {
    const now = Date.now();
    const reservations = await db.all(`SELECT * FROM reservations`);
    for (const r of reservations) {
      const [schedStart] = getReservationRange(r);
      if (schedStart > now) continue;
      try {
        await performCheckIn(r);
      } catch (err) {
        console.error(`[sweep] check-in failed for ${r.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[sweep] failed:", err.message);
  } finally {
    lastSweepAt = Date.now();
    sweeping = false;
  }
}

module.exports = {
  STATIONS,
  isKnownStation,
  getStationCapacity,
  getStationRate,
  uid,
  overlaps,
  getSessionRange,
  getReservationRange,
  getBookedCount,
  performCheckIn,
  autoCheckInDueReservations,
};
