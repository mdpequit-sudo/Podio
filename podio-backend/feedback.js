const express = require("express");
const db = require("./db");
const { uid } = require("./logic");

// Mounted at /api/feedback. The staff PIN check is applied in server.js.
const router = express.Router();

// Submit feedback, optionally tied to a completed session (one per session).
router.post("/", async (req, res) => {
  const { sessionId, customerName, rating, comment } = req.body;

  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5)
    return res
      .status(400)
      .json({ error: "Rating must be a whole number from 1 to 5." });

  let name = customerName?.trim() || null;

  if (sessionId) {
    const session = await db.get(`SELECT * FROM sessions WHERE id = $1`, [
      sessionId,
    ]);
    if (!session) return res.status(404).json({ error: "Session not found." });
    if (session.status !== "completed")
      return res
        .status(409)
        .json({ error: "Feedback opens once the session has ended." });
    name = name || session.customerName;
  }

  const entry = {
    id: uid(),
    sessionId: sessionId || null,
    customerName: name,
    rating: r,
    comment: comment?.trim().slice(0, 1000) || null,
    createdAt: Date.now(),
  };

  try {
    await db.run(
      `INSERT INTO feedback (id, "sessionId", "customerName", rating, comment, "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.id,
        entry.sessionId,
        entry.customerName,
        entry.rating,
        entry.comment,
        entry.createdAt,
      ],
    );
  } catch (err) {
    // Unique index on sessionId: feedback already exists for this session.
    if (err.code === "23505")
      return res
        .status(409)
        .json({ error: "Feedback already submitted for this session." });
    throw err;
  }

  res.status(201).json(entry);
});

// All feedback plus the average rating.
router.get("/", async (req, res) => {
  const items = await db.all(
    `SELECT * FROM feedback ORDER BY "createdAt" DESC`,
  );
  const count = items.length;
  const average = count
    ? Math.round((items.reduce((sum, f) => sum + f.rating, 0) / count) * 100) /
      100
    : null;
  res.json({ count, average, items });
});

router.delete("/:id", async (req, res) => {
  await db.run(`DELETE FROM feedback WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

module.exports = router;
