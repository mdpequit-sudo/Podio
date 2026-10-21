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

// PayMongo rejects very small checkouts (minimum is ₱20). Below this, staff
// should collect the balance in cash instead.
const MIN_ONLINE_AMOUNT = 20;
// Reuse a still-pending checkout link instead of creating a second one, so
// pressing Pay twice can't lead to the customer paying twice.
const PENDING_REUSE_MS = 30 * 60 * 1000;

async function findReusableCheckout(refId, amount) {
  return db.get(
    `SELECT id, "checkoutUrl" FROM payments
     WHERE "refId" = $1 AND status = 'pending' AND amount = $2 AND "createdAt" > $3
     ORDER BY "createdAt" DESC LIMIT 1`,
    [refId, amount, Date.now() - PENDING_REUSE_MS],
  );
}

// Shared by both pay routes: checks the amount, reuses a pending link if one
// exists, otherwise creates a new PayMongo checkout.
async function startPayment(res, info) {
  const { refId, amount } = info;

  if (!process.env.PAYMONGO_SECRET_KEY) {
    return res
      .status(503)
      .json({ error: "Online payments are not configured." });
  }

  if (amount < MIN_ONLINE_AMOUNT) {
    return res.status(409).json({
      error: `Balance is ₱${amount.toFixed(2)}. Online payment needs at least ₱${MIN_ONLINE_AMOUNT}, so please collect this one in cash.`,
    });
  }

  try {
    const existing = await findReusableCheckout(refId, amount);
    if (existing) {
      return res
        .status(200)
        .json({ paymentId: existing.id, checkoutUrl: existing.checkoutUrl });
    }
    const out = await createCheckout(info);
    return res.status(201).json(out);
  } catch (err) {
    console.error("[payments]", err.message);
    return res
      .status(502)
      .json({ error: "Could not start payment. Try again." });
  }
}

// Staff collected the balance in cash: record it as paid right away, and cancel
// any open online checkout link so the customer can't pay the same bill twice.
async function recordCash(res, info) {
  const { kind, refId, amount } = info;
  try {
    const now = Date.now();
    const paymentId = uid();
    await db.run(
      `UPDATE payments SET status = 'cancelled' WHERE "refId" = $1 AND status = 'pending'`,
      [refId],
    );
    await db.run(
      `INSERT INTO payments (id, kind, "refId", amount, status, method, "createdAt", "paidAt")
       VALUES ($1, $2, $3, $4, 'paid', 'cash', $5, $5)`,
      [paymentId, kind, refId, amount, now],
    );
    return res.status(201).json({ paymentId, method: "cash", amount });
  } catch (err) {
    console.error("[payments] cash:", err.message);
    return res.status(500).json({ error: "Could not record cash payment." });
  }
}

// Entry point for both pay routes. The request body picks how the customer
// pays: { "method": "cash" } or { "method": "online" } (online is the default,
// so the existing dashboard buttons keep working).
function collectPayment(req, res, info) {
  const method = req.body?.method === "cash" ? "cash" : "online";
  return method === "cash" ? recordCash(res, info) : startPayment(res, info);
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

// Pay for a reservation up front (full amount minus anything already paid).
router.post("/reservation/:id", async (req, res) => {
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

  await collectPayment(req, res, {
    kind: "reservation",
    refId: r.id,
    customerName: r.customerName,
    email: r.email,
    station: r.station,
    amount: balance,
  });
});

// Pay the balance for an ended session (total minus anything prepaid).
router.post("/session/:id", async (req, res) => {
  const s = await db.get(`SELECT * FROM sessions WHERE id = $1`, [
    req.params.id,
  ]);
  if (!s) return res.status(404).json({ error: "Session not found." });
  if (s.status !== "completed")
    return res.status(409).json({ error: "End the session before paying." });

  const paid = await paidSoFar(s.id);
  const balance = Math.round((s.total - paid) * 100) / 100;
  if (balance <= 0) {
    // The customer prepaid more than the final bill (e.g. left early).
    const overpaid = Math.round(-balance * 100) / 100;
    return res.status(409).json({
      error:
        overpaid > 0
          ? `Already paid. The customer prepaid ₱${overpaid.toFixed(2)} more than the final total; refund or credit that amount manually.`
          : "Already paid.",
      overpaid,
    });
  }

  await collectPayment(req, res, {
    kind: "session",
    refId: s.id,
    customerName: s.customerName,
    email: null,
    station: s.station,
    amount: balance,
  });
});

// Don't trust the success redirect alone; only the webhook marks payments paid.
router.get("/status/:refId", async (req, res) => {
  const payments = await db.all(
    `SELECT id, kind, method, amount, status, "createdAt", "paidAt" FROM payments WHERE "refId" = $1 ORDER BY "createdAt" DESC`,
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
    // If the reservation was cancelled while this checkout was open, the money
    // still arrived, so flag it for refund instead of counting it as paid.
    await db.run(
      `UPDATE payments
       SET status = CASE WHEN status = 'cancelled' THEN 'refund_due' ELSE 'paid' END,
           "paidAt" = $1
       WHERE "providerRef" = $2 AND status NOT IN ('paid', 'refund_due')`,
      [Date.now(), checkoutId],
    );
    console.log(`[payments] Marked paid: ${checkoutId}`);
  }
  // A thrown DB error above becomes a 500, so PayMongo retries the webhook.
  res.status(200).end();
});

module.exports = router;
