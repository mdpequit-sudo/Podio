// Backend address. On your own computer it talks to localhost; once deployed,
// set PROD_API_BASE to your Render backend URL (e.g. https://podio-backend.onrender.com).
const PROD_API_BASE = "https://podio-7fkz.onrender.com";
const IS_LOCAL = ["localhost", "127.0.0.1", ""].includes(
  window.location.hostname,
);
const API_BASE = IS_LOCAL ? "http://localhost:3001" : PROD_API_BASE;

const STATIONS = ["Podio Pod", "Podio Nook", "Podio Solo", "Podio Quad"];

// Cached copy of the last state fetched from the server, so DOM handlers
// (like the timer tick) don't need to hit the network every second.
let latestState = {
  active: [],
  reservations: [],
  completed: [],
  paid: {}, // refId -> total pesos paid online
  rated: [], // session ids that already have feedback
};
let latestAvailability = {}; // station -> { capacity, booked, full }

// ---------- Toasts ----------
function toast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

// ---------- Confirm modal ----------
function showConfirm(title, body) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirmOverlay");
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmBody").textContent = body;
    overlay.classList.add("show");

    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

    function cleanup(result) {
      overlay.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() {
      cleanup(true);
    }
    function onCancel() {
      cleanup(false);
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// ---------- Connection banner ----------
let connectionLost = false;
function setConnectionStatus(ok) {
  const banner = document.getElementById("connBanner");
  if (ok && connectionLost) {
    connectionLost = false;
    banner.classList.remove("show");
    toast("Reconnected to server.");
  } else if (!ok && !connectionLost) {
    connectionLost = true;
    banner.classList.add("show");
  }
}

// ---------- Staff PIN ----------
// When STAFF_PIN is set on the server, every request must carry it in the
// x-staff-key header. The PIN is remembered for this browser tab only.
let pinPrompt = null;
let pinDeclined = false;

function askForPin() {
  if (pinDeclined) return Promise.resolve(false);
  if (!pinPrompt) {
    pinPrompt = new Promise((resolve) => {
      setTimeout(() => {
        const pin = window.prompt("Enter the staff PIN:");
        pinPrompt = null;
        if (pin) {
          sessionStorage.setItem("staffKey", pin);
          resolve(true);
        } else {
          pinDeclined = true;
          toast("Staff PIN required. Reload the page to enter it.", "error");
          resolve(false);
        }
      }, 0);
    });
  }
  return pinPrompt;
}

async function apiFetch(path, options = {}, retried = false) {
  const key = sessionStorage.getItem("staffKey");
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(key ? { "x-staff-key": key } : {}),
    },
  });
  if (res.status === 401 && !retried) {
    const current = sessionStorage.getItem("staffKey");
    if (current && current !== key) return apiFetch(path, options, true); // PIN changed meanwhile
    sessionStorage.removeItem("staffKey"); // wrong or missing PIN: ask again
    if (await askForPin()) return apiFetch(path, options, true);
  }
  return res;
}

function httpError(res, data) {
  const err = new Error(data.error || "Request failed.");
  err.status = res.status;
  return err;
}

// ---------- API helpers ----------
async function apiGet(path) {
  const res = await apiFetch(path);
  setConnectionStatus(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

async function apiPost(path, body) {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  setConnectionStatus(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
}

async function apiDelete(path) {
  const res = await apiFetch(path, { method: "DELETE" });
  setConnectionStatus(true);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw httpError(res, data);
  }
}

async function refresh() {
  try {
    latestState = await apiGet("/api/state");
    await refreshSummary();
    render();
  } catch (e) {
    console.error("Backend request failed:", e);
    // Only show the "can't reach server" banner for real network failures,
    // not for HTTP errors such as a missing staff PIN (401).
    if (e.status === undefined) setConnectionStatus(false);
  }
}

// Fetches "now" occupancy for every station type, for the summary bar.
async function refreshSummary() {
  const now = Date.now();
  const soon = now + 3600000; // 1hr window, matches default hours field
  try {
    const results = await Promise.all(
      STATIONS.map((station) =>
        apiGet(
          `/api/availability?station=${encodeURIComponent(station)}&start=${now}&end=${soon}`,
        ).then((r) => [station, r]),
      ),
    );
    latestAvailability = Object.fromEntries(results);
  } catch (e) {
    // Silently skip; connection banner already handles the failure case.
  }
}

// ---------- Formatting helpers ----------
function money(n) {
  return (
    "₱" +
    n.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function pesoPlain(n) {
  return "₱" + Number(n).toLocaleString("en-PH", { maximumFractionDigits: 0 });
}

function fmtHours(h) {
  const n = Number(h);
  const rounded = Math.round(n * 100) / 100;
  return (rounded % 1 === 0 ? rounded.toFixed(0) : String(rounded)) + "hr";
}

function fmtRemaining(elapsedMs, plannedHours) {
  const plannedMs = plannedHours * 3600000;
  const diff = plannedMs - elapsedMs;
  if (diff <= 0) {
    return `<span class="overtime">+${fmtElapsed(-diff)} over</span>`;
  }
  return `${fmtElapsed(diff)} left`;
}

function fmtElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function fmtClockTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function fmtResDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function getStationRate(selectId) {
  const select = document.getElementById(selectId);
  const selectedOption = select.options[select.selectedIndex];
  const presetRate = selectedOption
    ? selectedOption.getAttribute("data-rate")
    : null;
  return parseFloat(presetRate) || 50;
}

function updateRateHint(selectId, hintId) {
  const rate = getStationRate(selectId);
  const hintEl = document.getElementById(hintId);
  if (hintEl) hintEl.textContent = pesoPlain(rate) + "/hr";
}

// ---------- Availability ----------
async function updateWalkInAvailability() {
  const station = document.getElementById("wiStation").value;
  const hoursRaw = parseFloat(document.getElementById("wiHours").value);
  const plannedHours = hoursRaw > 0 ? hoursRaw : 1;
  const now = Date.now();

  const avail = await apiGet(
    `/api/availability?station=${encodeURIComponent(station)}&start=${now}&end=${now + plannedHours * 3600000}`,
  ).catch(() => null);
  if (!avail) return;
  const { capacity, booked, full } = avail;

  const msgEl = document.getElementById("wiAvailMsg");
  const btn = document.getElementById("wiStartBtn");
  if (full) {
    msgEl.textContent = `⚠ ${station} is FULL (${booked}/${capacity} occupied). Please choose the other option or wait for one to free up.`;
    msgEl.style.display = "block";
    btn.disabled = true;
  } else {
    msgEl.style.display = "none";
    btn.disabled = false;
  }
}

async function updateResAvailability() {
  const station = document.getElementById("resStation").value;
  const date = document.getElementById("resDate").value;
  const time = document.getElementById("resTime").value;
  const hoursRaw = parseFloat(document.getElementById("resHours").value);
  const hours = hoursRaw > 0 ? hoursRaw : 1;

  const msgEl = document.getElementById("resAvailMsg");
  const btn = document.getElementById("resAddBtn");

  if (!date || !time) {
    msgEl.style.display = "none";
    btn.disabled = false;
    return;
  }

  const start = new Date(`${date}T${time}`).getTime();
  const end = start + hours * 3600000;
  const avail = await apiGet(
    `/api/availability?station=${encodeURIComponent(station)}&start=${start}&end=${end}`,
  ).catch(() => null);
  if (!avail) return;
  const { capacity, booked, full } = avail;

  if (full) {
    msgEl.textContent = `⚠ ${station} is FULL for that time slot (${booked}/${capacity} booked). Pick a different time or station.`;
    msgEl.style.display = "block";
    btn.disabled = true;
  } else {
    msgEl.style.display = "none";
    btn.disabled = false;
  }
}

// ---------- Actions ----------
async function startWalkIn() {
  const name = document.getElementById("wiName").value.trim();
  const station = document.getElementById("wiStation").value.trim();
  const rate = getStationRate("wiStation");
  const plannedHours =
    parseFloat(document.getElementById("wiHours").value) || 1;
  if (!name) {
    toast("Enter a customer name.", "error");
    return;
  }

  try {
    await apiPost("/api/sessions/walkin", {
      customerName: name,
      station,
      ratePerHour: rate,
      plannedHours,
    });
    document.getElementById("wiName").value = "";
    document.getElementById("wiStation").selectedIndex = 0;
    document.getElementById("wiHours").value = "";
    updateRateHint("wiStation", "wiRateHint");
    toast(`${name} checked in to ${station}.`);
    await refresh();
  } catch (e) {
    toast(e.message, "error");
    updateWalkInAvailability();
  }
}

async function endSession(id, customerName) {
  const ok = await showConfirm(
    "End this session?",
    `This will close out ${customerName}'s session and add it to today's log. This can't be undone.`,
  );
  if (!ok) return;

  try {
    const result = await apiPost(`/api/sessions/${id}/end`);
    toast(`Session ended. Total: ${money(result.total)}`);
    await refresh();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function addReservation() {
  const name = document.getElementById("resName").value.trim();
  const email = document.getElementById("resEmail").value.trim();
  const station = document.getElementById("resStation").value.trim();
  const date = document.getElementById("resDate").value;
  const time = document.getElementById("resTime").value;
  const rate = getStationRate("resStation");
  const hours = parseFloat(document.getElementById("resHours").value) || 1;
  if (!name || !date || !time) {
    toast("Enter a customer name, date, and time.", "error");
    return;
  }

  try {
    await apiPost("/api/reservations", {
      customerName: name,
      email,
      station,
      ratePerHour: rate,
      hours,
      date,
      time,
    });
    document.getElementById("resName").value = "";
    document.getElementById("resEmail").value = "";
    document.getElementById("resStation").selectedIndex = 0;
    document.getElementById("resDate").value = "";
    document.getElementById("resTime").value = "";
    document.getElementById("resHours").value = "";
    updateRateHint("resStation", "resRateHint");
    toast(`Reservation added for ${name}.`);
    await refresh();
  } catch (e) {
    toast(e.message, "error");
    updateResAvailability();
  }
}

async function checkIn(id) {
  try {
    await apiPost(`/api/reservations/${id}/checkin`);
    toast("Checked in.");
    await refresh();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function cancelReservation(id, customerName) {
  const ok = await showConfirm(
    "Cancel this reservation?",
    `${customerName}'s reservation will be removed. This can't be undone.`,
  );
  if (!ok) return;

  await apiDelete(`/api/reservations/${id}`);
  toast("Reservation cancelled.");
  await refresh();
}

// ---------- Online payments ----------
// kind is "reservation" or "session". Opens the PayMongo checkout page in a new tab.
// The tab is opened first (synchronously) so popup blockers don't stop it.
async function payOnline(kind, id) {
  const win = window.open("", "_blank");
  try {
    const { checkoutUrl } = await apiPost(`/api/payments/${kind}/${id}`);
    if (win) win.location.href = checkoutUrl;
    else window.location.href = checkoutUrl;
    toast("Payment page opened. It will show as Paid once confirmed.");
  } catch (e) {
    if (win) win.close();
    toast(e.message, "error");
  }
}

// Handles the redirect back from checkout (?payment=success&ref=...).
function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("payment");
  if (!result) return;
  if (result === "success") {
    toast("Payment submitted. Confirming with the payment provider...");
  } else {
    toast("Payment was cancelled.", "error");
  }
  history.replaceState(null, "", window.location.pathname);
}

// ---------- Feedback ----------
let feedbackSessionId = null;
let feedbackRating = 0;

function setFeedbackRating(n) {
  feedbackRating = n;
  document.querySelectorAll("#fbStars .star").forEach((el) => {
    el.classList.toggle("on", Number(el.dataset.value) <= n);
  });
}

function openFeedback(sessionId) {
  const s = latestState.completed.find((x) => x.id === sessionId);
  feedbackSessionId = sessionId;
  document.getElementById("fbTitle").textContent = s
    ? `How was ${s.customerName}'s visit?`
    : "How was your visit?";
  document.getElementById("fbComment").value = "";
  setFeedbackRating(0);
  document.getElementById("feedbackOverlay").classList.add("show");
}

function closeFeedback() {
  document.getElementById("feedbackOverlay").classList.remove("show");
  feedbackSessionId = null;
}

async function submitFeedback() {
  if (!feedbackRating) {
    toast("Pick a star rating first.", "error");
    return;
  }
  try {
    await apiPost("/api/feedback", {
      sessionId: feedbackSessionId,
      rating: feedbackRating,
      comment: document.getElementById("fbComment").value.trim(),
    });
    closeFeedback();
    toast("Thanks for the feedback!");
    await refresh();
  } catch (e) {
    toast(e.message, "error");
  }
}

function initFeedbackModal() {
  document.querySelectorAll("#fbStars .star").forEach((el) => {
    el.addEventListener("click", () =>
      setFeedbackRating(Number(el.dataset.value)),
    );
  });
  document
    .getElementById("fbCancelBtn")
    .addEventListener("click", closeFeedback);
  document
    .getElementById("fbSubmitBtn")
    .addEventListener("click", submitFeedback);
}

// ---------- Rendering ----------
function renderActiveTicket(s) {
  const elapsed = Date.now() - s.startTime;
  const isBooked = s.source === "reservation";
  const pillClass = isBooked ? "status-pending" : "status-active";
  const pillLabel = isBooked ? "Booked" : "Walk In";
  return `<div class="ticket">
        <div class="ticket-top">
          <div>
            <div class="ticket-name">${escapeHtml(s.customerName)}</div>
            <div class="ticket-station">${escapeHtml(s.station)}</div>
          </div>
          <div class="ticket-status ${pillClass}">${pillLabel}</div>
        </div>
        <div class="ticket-timer" data-start="${s.startTime}" data-rate="${s.ratePerHour}" data-planned="${s.plannedHours || ""}" data-id="${s.id}">${fmtElapsed(elapsed)}</div>
        ${
          s.plannedHours
            ? `<div class="ticket-planned">Hours Occupied: ${fmtHours(s.plannedHours)} <span class="muted">(${money(s.ratePerHour * s.plannedHours)})</span> · <span class="live-remaining">${fmtRemaining(elapsed, s.plannedHours)}</span></div>`
            : ""
        }
        ${
          (latestState.paid || {})[s.id] > 0
            ? `<div class="ticket-planned">Prepaid: ${money(latestState.paid[s.id])}</div>`
            : ""
        }
        <div class="ticket-actions">
          <button class="btn btn-end" onclick="endSession('${s.id}', '${escapeHtml(s.customerName)}')">End Session</button>
        </div>
      </div>`;
}

function renderSummaryBar() {
  const bar = document.getElementById("summaryBar");
  bar.innerHTML = STATIONS.map((station) => {
    const a = latestAvailability[station];
    if (!a) return "";
    const pct =
      a.capacity > 0 ? Math.min(100, (a.booked / a.capacity) * 100) : 0;
    const fullClass = a.full ? "full" : "";
    return `
      <div class="summary-card">
        <div class="s-label">${escapeHtml(station)}</div>
        <div class="s-value ${fullClass}">${a.booked}/${a.capacity}</div>
        <div class="s-bar"><div class="s-bar-fill ${fullClass}" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join("");
}

function render() {
  const { active, reservations, completed } = latestState;
  const paid = latestState.paid || {};
  const rated = latestState.rated || [];

  renderSummaryBar();

  const activeGrid = document.getElementById("activeGrid");
  document.getElementById("activeCount").textContent = active.length;
  activeGrid.innerHTML = active.length
    ? active.map(renderActiveTicket).join("")
    : '<div class="empty" style="grid-column:1/-1;">No active sessions.</div>';

  const resGrid = document.getElementById("resGrid");
  const pending = [...reservations].sort((a, b) => {
    const da = a.date || "";
    const db = b.date || "";
    if (da !== db) return da.localeCompare(db);
    return a.time.localeCompare(b.time);
  });
  document.getElementById("resCount").textContent = pending.length;
  resGrid.innerHTML = pending.length
    ? pending
        .map((r) => {
          const hours = r.hours || 1;
          const total = Math.round(r.ratePerHour * hours * 100) / 100;
          const paidAmt = paid[r.id] || 0;
          const balance = Math.round((total - paidAmt) * 100) / 100;
          const payLine =
            balance <= 0
              ? `<div class="pay-line"><span class="ticket-status status-active">Paid ${money(paidAmt)}</span></div>`
              : `<div class="pay-line"><button class="btn btn-primary btn-sm" onclick="payOnline('reservation','${r.id}')">Pay Online ${money(balance)}</button></div>`;
          return `
      <div class="ticket">
        <div class="ticket-top">
          <div>
            <div class="ticket-name">${escapeHtml(r.customerName)}</div>
            <div class="ticket-station">${escapeHtml(r.station)}</div>
          </div>
          <div class="ticket-status status-pending">Booked</div>
        </div>
        <div class="res-time">🗓️ ${fmtResDate(r.date)} · ⏱️ ${r.time}</div>
        <div class="ticket-cost">${pesoPlain(r.ratePerHour)} <span class="muted">× ${fmtHours(hours)}</span> = <b>${money(total)}</b></div>
        ${payLine}
        <div class="ticket-actions">
          <button class="btn btn-checkin" onclick="checkIn('${r.id}')">Check In</button>
          <button class="btn btn-ghost" onclick="cancelReservation('${r.id}', '${escapeHtml(r.customerName)}')">Cancel</button>
        </div>
      </div>
    `;
        })
        .join("")
    : '<div class="empty" style="grid-column:1/-1;">No reservations.</div>';

  const sortedCompleted = [...completed].sort((a, b) => b.endTime - a.endTime);
  document.getElementById("logCount").textContent = sortedCompleted.length;
  const logBody = document.getElementById("logBody");
  const logEmpty = document.getElementById("logEmpty");
  if (sortedCompleted.length === 0) {
    logBody.innerHTML = "";
    logEmpty.style.display = "block";
  } else {
    logEmpty.style.display = "none";
    logBody.innerHTML = sortedCompleted
      .map((s) => {
        const balance = Math.round((s.total - (paid[s.id] || 0)) * 100) / 100;
        let payCell;
        if (s.total <= 0) {
          payCell = '<span class="muted">-</span>';
        } else if (balance <= 0) {
          payCell = '<span class="ticket-status status-active">Paid</span>';
        } else {
          payCell = `<button class="btn btn-primary btn-xs" onclick="payOnline('session','${s.id}')">Pay ${money(balance)}</button>`;
        }
        const rateCell = rated.includes(s.id)
          ? '<span class="muted">★ Rated</span>'
          : `<button class="btn btn-outline btn-xs" onclick="openFeedback('${s.id}')">Rate</button>`;
        return `
      <tr>
        <td>${escapeHtml(s.customerName)}</td>
        <td class="muted">${escapeHtml(s.station)}</td>
        <td class="muted">${fmtClockTime(s.startTime)}</td>
        <td class="muted">${fmtClockTime(s.endTime)}</td>
        <td class="muted">${fmtElapsed(s.endTime - s.startTime)}</td>
        <td class="amount">${money(s.total)}</td>
        <td>${payCell}</td>
        <td>${rateCell}</td>
      </tr>
    `;
      })
      .join("");
  }
  const revenue = sortedCompleted.reduce((sum, s) => sum + s.total, 0);
  const revenueEl = document.getElementById("todayRevenue");
  if (revenueEl) revenueEl.textContent = money(revenue);

  updateWalkInAvailability();
  updateResAvailability();
}

function tickClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString(
    "en-US",
  );
}

function tickTimers() {
  document.querySelectorAll(".ticket-timer").forEach((el) => {
    const start = parseInt(el.getAttribute("data-start"));
    const planned = parseFloat(el.getAttribute("data-planned"));
    const elapsed = Date.now() - start;
    el.textContent = fmtElapsed(elapsed);
    const remainingEl = el.parentElement.querySelector(".live-remaining");
    if (remainingEl && !isNaN(planned) && planned > 0) {
      remainingEl.innerHTML = fmtRemaining(elapsed, planned);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  updateRateHint("wiStation", "wiRateHint");
  updateRateHint("resStation", "resRateHint");
  initFeedbackModal();
  handlePaymentReturn();

  setInterval(tickClock, 1000);
  setInterval(tickTimers, 1000);
  setInterval(refresh, 3000);
  tickClock();
  refresh();
});
