const crypto = require("crypto");

// Simple shared staff PIN, sent by the dashboard in the x-staff-key header.
// If STAFF_PIN isn't set, auth is skipped (handy for local development).
function requireStaff(req, res, next) {
  const pin = process.env.STAFF_PIN;
  if (!pin) return next();

  const given = Buffer.from(req.get("x-staff-key") || "");
  const expected = Buffer.from(pin);
  if (
    given.length === expected.length &&
    crypto.timingSafeEqual(given, expected)
  ) {
    return next();
  }
  res.status(401).json({ error: "Staff PIN required." });
}

module.exports = { requireStaff };
