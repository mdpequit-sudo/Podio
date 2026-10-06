require("dotenv").config();
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

function fmtResDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// Fire-and-forget: logs errors but never throws, so a broken email
// integration can never block or fail a reservation.
async function sendReservationConfirmation(reservation) {
  if (!resend || !reservation.email) {
    console.log(
      `[email] Skipped (no API key or no email provided) for reservation ${reservation.id}`,
    );
    return { sent: false };
  }

  const total =
    Math.round(reservation.ratePerHour * reservation.hours * 100) / 100;

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "Podio <onboarding@resend.dev>",
      to: reservation.email,
      subject: `Reservation confirmed: ${reservation.station}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#3a4e1d;">Podio Co-Working Space</h2>
          <p>Hi ${reservation.customerName}, your reservation is confirmed:</p>
          <table style="width:100%; border-collapse: collapse; margin: 16px 0;">
            <tr><td style="padding:6px 0; color:#666;">Station</td><td style="padding:6px 0;"><b>${reservation.station}</b></td></tr>
            <tr><td style="padding:6px 0; color:#666;">Date</td><td style="padding:6px 0;">${fmtResDate(reservation.date)}</td></tr>
            <tr><td style="padding:6px 0; color:#666;">Time</td><td style="padding:6px 0;">${reservation.time}</td></tr>
            <tr><td style="padding:6px 0; color:#666;">Duration</td><td style="padding:6px 0;">${reservation.hours} hr</td></tr>
            <tr><td style="padding:6px 0; color:#666;">Total</td><td style="padding:6px 0;"><b>₱${total.toFixed(2)}</b></td></tr>
          </table>
          <p style="color:#888; font-size:12px;">See you then! — Podio</p>
        </div>
      `,
    });
    console.log(`[email] Sent confirmation to ${reservation.email}`);
    return { sent: true };
  } catch (err) {
    console.error(
      `[email] Failed to send for reservation ${reservation.id}:`,
      err.message,
    );
    return { sent: false, error: err.message };
  }
}

module.exports = { sendReservationConfirmation };
