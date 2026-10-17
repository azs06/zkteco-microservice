const crypto = require("crypto");
const { ADMIN_USER, ADMIN_PASSWORD } = require("../constants");

// Hashing first gives equal-length buffers, so timingSafeEqual never throws or leaks length.
const safeEqual = (a, b) => {
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
};

const parseBasic = (header) => {
  const match = /^Basic\s+(.+)$/i.exec(header || "");
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index === -1) return null;
  return { user: decoded.slice(0, index), password: decoded.slice(index + 1) };
};

// Failed logins per IP: after MAX_FAILURES within the window, further attempts get 429.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

const isLockedOut = (ip) => {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
};

const recordFailure = (ip) => {
  const entry = failures.get(ip);
  if (entry && Date.now() - entry.first <= FAILURE_WINDOW_MS) entry.count += 1;
  else failures.set(ip, { first: Date.now(), count: 1 });
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
};

const securityHeaders = (res) =>
  res.set({
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });

// HTTP Basic auth for the admin UI and API. Disabled entirely when ADMIN_PASSWORD is unset.
const adminAuth = function (req, res, next) {
  securityHeaders(res);
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ message: "Admin UI disabled: set ADMIN_PASSWORD" });
  }

  const ip = req.ip || "";
  if (isLockedOut(ip)) {
    return res.status(429).json({ message: "Too many failed logins, try again later" });
  }

  const credentials = parseBasic(req.header("Authorization"));
  if (credentials) {
    const userOk = safeEqual(credentials.user, ADMIN_USER);
    const passwordOk = safeEqual(credentials.password, ADMIN_PASSWORD);
    if (userOk && passwordOk) return next();
    recordFailure(ip);
  }

  res.set("WWW-Authenticate", 'Basic realm="ZKTeco Admin", charset="UTF-8"');
  return res.status(401).json({ message: "Authentication required" });
};

module.exports = {
  adminAuth,
};
