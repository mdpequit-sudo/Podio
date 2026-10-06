const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const { uid } = require("./logic");

// Mounted at /api/payments. Everything except /webhook needs the staff PIN
// (applied in server.js). The webhook is protected by PayMongo's signature.
const router = express.Router();
const PAYMONGO_URL = "https://api.paymongo.com/v1";

function authHeader() {
  return (
    "Basic " +
    Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString("base64")
  );
}

async function paidSoFar(refId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE "refId" = $1 AND status = 'paid'`,
    [refId],
  );
  return Number(row.paid);
}

async function createCheckout({
  kind,
  refId,
  customerName,
  email,
  station,
  amount,
}) {
  const paymentId = uid();
  const frontend = (
    process.env.FRONTEND_URL || "http://127.0.0.1:5500"
  ).replace(/\/$/, "");

  const attributes = {
    line_items: [
      {
        currency: "PHP",
        amount: Math.round(amount * 100), // centavos
        name: `Podio - ${station}`,
        quantity: 1,
      },
    ],
    payment_method_types: ["gcash", "paymaya", "card"],
    description: `${kind} payment for ${customerName}`,
    reference_number: paymentId,
    success_url: `${frontend}/?payment=success&ref=${refId}`,
    cancel_url: `${frontend}/?payment=cancelled&ref=${refId}`,
    metadata: { paymentId, refId, kind },
  };
  if (email) {
    attributes.billing = { name: customerName, email };
    attributes.send_email_receipt = true;
  }

  const resp = await fetch(`${PAYMONGO_URL}/checkout_sessions`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: authHeader(),
    },
    body: JSON.stringify({ data: { attributes } }),
  });
  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(
      json.errors?.[0]?.detail || `PayMongo error ${resp.status}`,
    );
  }

  const checkoutUrl = json.data.attributes.checkout_url;
  await db.run(
    `INSERT INTO payments (id, kind, "refId", "providerRef", "checkoutUrl", amount, status, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
    [paymentId, kind, refId, json.data.id, checkoutUrl, amount, Date.now()],
  );

  return { paymentId, checkoutUrl };
}

function guardConfigured(req, res, next) {
  if (!process.env.PAYMONGO_SECRET_KEY)
    return res
      .status(503)
      .json({ error: "Online payments are not configured." });
  next();
}

// Pay for a reservation up front (full amount minus anything already paid).
router.post("/reservation/:id", guardConfigured, async (req, res) => {
  const r = await db.get(`SELECT * FROM reservations WHERE id = $1`, [
    req.params.id,
  ]);
  if (!r)
    return res.status(404).json({
      error:
        "Reservation not found. If the customer already checked in, pay from Today's Log after the session ends.",
    });

  const balance =
    Math.round((r.ratePerHour * r.hours - (await paidSoFar(r.id))) * 100) / 100;
  if (balance <= 0) return res.status(409).json({ error: "Already paid." });

  try {
    const out = await createCheckout({
      kind: "reservation",
      refId: r.id,
      customerName: r.customerName,
      email: r.email,
      station: r.station,
      amount: balance,
    });
    res.status(201).json(out);
  } catch (err) {
    console.error("[payments]", err.message);
    res.status(502).json({ error: "Could not start payment. Try again." });
  }
});

// Pay the balance for an ended session (total minus anything prepaid).
router.post("/session/:id", guardConfigured, async (req, res) => {
  const s = await db.get(`SELECT * FROM sessions WHERE id = $1`, [
    req.params.id,
  ]);
  if (!s) return res.status(404).json({ error: "Session not found." });
  if (s.status !== "completed")
    return res.status(409).json({ error: "End the session before paying." });

  const balance = Math.round((s.total - (await paidSoFar(s.id))) * 100) / 100;
  if (balance <= 0) return res.status(409).json({ error: "Already paid." });

  try {
    const out = await createCheckout({
      kind: "session",
      refId: s.id,
      customerName: s.customerName,
      email: null,
      station: s.station,
      amount: balance,
    });
    res.status(201).json(out);
  } catch (err) {
    console.error("[payments]", err.message);
    res.status(502).json({ error: "Could not start payment. Try again." });
  }
});

// Don't trust the success redirect alone; only the webhook marks payments paid.
router.get("/status/:refId", async (req, res) => {
  const payments = await db.all(
    `SELECT id, kind, amount, status, "createdAt", "paidAt" FROM payments WHERE "refId" = $1 ORDER BY "createdAt" DESC`,
    [req.params.refId],
  );
  res.json({ paid: await paidSoFar(req.params.refId), payments });
});

// ---------- Webhook ----------
function verifySignature(req) {
  const header = req.get("Paymongo-Signature");
  if (!header || !req.rawBody || !process.env.PAYMONGO_WEBHOOK_SECRET)
    return false;

  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const isLive = process.env.PAYMONGO_SECRET_KEY?.startsWith("sk_live");
  const theirs = isLive ? parts.li : parts.te;
  if (!parts.t || !theirs) return false;

  const ours = crypto
    .createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET)
    .update(`${parts.t}.`)
    .update(req.rawBody)
    .digest("hex");

  const a = Buffer.from(ours);
  const b = Buffer.from(theirs);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) return res.status(401).end();

  const attrs = req.body?.data?.attributes;
  if (attrs?.type === "checkout_session.payment.paid") {
    const checkoutId = attrs.data?.id;
    await db.run(
      `UPDATE payments SET status = 'paid', "paidAt" = $1 WHERE "providerRef" = $2 AND status <> 'paid'`,
      [Date.now(), checkoutId],
    );
    console.log(`[payments] Marked paid: ${checkoutId}`);
  }
  // A thrown DB error above becomes a 500, so PayMongo retries the webhook.
  res.status(200).end();
});

module.exports = router;
