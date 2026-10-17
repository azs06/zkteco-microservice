const express = require("express");
const deviceService = require("../database/deviceService");
const { queryAttendance } = require("../database/dbService");
const commands = require("../commands");
const { ALLOWED_AGENTS, ALLOWED_SERIALS, TIMEZONE, SN_PATTERN } = require("../constants");

const router = express.Router();

// CSRF guard: browsers resend cached Basic credentials on cross-site form posts, so
// state-changing requests must be JSON (forms can't send it without a CORS preflight)
// and must not come from another origin.
router.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const site = req.header("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") {
    return res.status(403).json({ message: "Cross-site request refused" });
  }
  const origin = req.header("Origin");
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch (_) {}
    const allowed = [req.header("Host"), req.header("X-Forwarded-Host")].filter(Boolean);
    if (!allowed.includes(host)) return res.status(403).json({ message: "Cross-origin request refused" });
  }
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ message: "Content-Type must be application/json" });
  }
  next();
});
router.use(express.json({ limit: "100kb" }));

const ONLINE_WINDOW_MS = 120 * 1000;
const PIN_PATTERN = /^\d{1,24}$/;
// What the device itself may report (see commands.requirePin); used to find existing users.
const DEVICE_PIN_PATTERN = /^[^\s=]{1,24}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;
const CSV_PAGE = 5000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const accessOf = (device) => {
  if (device.approved) return "approved";
  if (ALLOWED_SERIALS.includes(device.sn)) return "allowlist";
  const agent = device.userAgent || "";
  if (ALLOWED_AGENTS.some((allowed) => agent.includes(allowed))) return "user-agent";
  return "pending";
};

const isOnline = (lastSeen) => {
  const time = Date.parse(lastSeen || "");
  return !Number.isNaN(time) && Date.now() - time <= ONLINE_WINDOW_MS;
};

const present = (device, withInfo = false) => {
  const result = {
    sn: device.sn,
    name: device.name,
    deviceType: device.deviceType,
    firmware: device.firmware,
    pushVersion: device.pushVersion,
    ip: device.ip,
    userAgent: device.userAgent,
    approved: Boolean(device.approved),
    access: accessOf(device),
    online: isOnline(device.lastSeen),
    lastSeen: device.lastSeen,
    createdAt: device.createdAt,
    userCount: device.userCount || 0,
  };
  if (withInfo) result.info = device.info || {};
  return result;
};

const checkSn = (value) => {
  const sn = typeof value === "string" ? value.trim() : "";
  if (!SN_PATTERN.test(sn)) throw new HttpError(400, "Invalid serial number");
  return sn;
};

const checkPin = (value, pattern = PIN_PATTERN) => {
  const pin = value === undefined || value === null ? "" : String(value).trim();
  if (!pattern.test(pin)) {
    throw new HttpError(400, pattern === PIN_PATTERN ? "Invalid pin: use 1-24 digits" : "Invalid pin");
  }
  return pin;
};

const checkDate = (value, field) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new HttpError(400, `Invalid ${field}: use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`);
  }
  return value;
};

const checkText = (value, field, max = 64) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") throw new HttpError(400, `Invalid ${field}`);
  const text = String(value).trim();
  if (text.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return text;
};

const toInt = (value, fallback, min, max) => {
  const number = parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(Math.max(number, min), max);
};

// Command builders throw on invalid input or unsupported device types; those are client errors.
const build = (fn) => {
  try {
    return fn();
  } catch (error) {
    throw new HttpError(400, error.message);
  }
};

// Looked up as given (not checkSn) so rows recorded before SN validation can still be removed.
const loadDevice = async (sn) => {
  if (typeof sn !== "string" || !sn || sn.length > 5000) throw new HttpError(400, "Invalid serial number");
  const device = await deviceService.getDevice(sn);
  if (!device) throw new HttpError(404, "Device not found");
  return device;
};

const loadPresented = async (sn) => {
  const device = await deviceService.getDevice(sn);
  if (!device) throw new HttpError(404, "Device not found");
  const users = await deviceService.listDeviceUsers(sn);
  return present({ ...device, userCount: users.length }, true);
};

const redactRow = (row) => ({ ...row, command: commands.redact(row.command) });

const queue = async (sn, kind, list) => {
  const created = await deviceService.queueCommands(sn, kind, list);
  return { commands: created.map(redactRow) };
};

router.get("/devices", asyncRoute(async (_, res) => {
  const devices = await deviceService.listDevices();
  res.json(devices.map((device) => present(device)));
}));

router.post("/devices", asyncRoute(async (req, res) => {
  const body = req.body || {};
  const sn = checkSn(body.sn);
  const name = checkText(body.name, "name");
  await deviceService.saveDevice({ sn, name: name || undefined, approved: true });
  res.status(201).json(await loadPresented(sn));
}));

router.get("/devices/:sn", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  res.json(await loadPresented(device.sn));
}));

router.patch("/devices/:sn", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  const body = req.body || {};
  const update = { sn: device.sn };
  if (body.name !== undefined) update.name = checkText(body.name, "name");
  if (body.approved !== undefined) {
    if (typeof body.approved !== "boolean") throw new HttpError(400, "approved must be a boolean");
    update.approved = body.approved;
  }
  await deviceService.saveDevice(update);
  res.json(await loadPresented(device.sn));
}));

router.delete("/devices/:sn", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  await deviceService.deleteDevice(device.sn);
  res.status(204).end();
}));

router.get("/devices/:sn/users", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  res.json(await deviceService.listDeviceUsers(device.sn));
}));

router.post("/devices/:sn/users", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  const body = req.body || {};
  const user = {
    pin: checkPin(body.pin),
    name: checkText(body.name, "name", 24),
    cardNo: checkText(body.cardNo, "cardNo", 20),
    privilege: toInt(body.privilege, 0, 0, 14),
    password: checkText(body.password, "password", 8),
  };
  if (!user.name) throw new HttpError(400, "Missing name");
  if (user.cardNo && !/^\d+$/.test(user.cardNo)) throw new HttpError(400, "cardNo must be digits");

  const list = build(() => commands.addUser(device.deviceType, user));
  const result = await queue(device.sn, "add-user", list);
  await deviceService.upsertDeviceUsers(device.sn, [user]);
  res.status(202).json(result);
}));

router.delete("/devices/:sn/users/:pin", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  const pin = checkPin(req.params.pin, DEVICE_PIN_PATTERN);
  const list = build(() => commands.deleteUser(device.deviceType, pin));
  const result = await queue(device.sn, "delete-user", list);
  await deviceService.deleteDeviceUser(device.sn, pin);
  res.status(202).json(result);
}));

const actions = {
  "fetch-users": (device) => commands.queryUsers(device.deviceType),
  "fetch-attendance": (device, body) =>
    commands.queryAttendance(device.deviceType, {
      from: checkDate(body.from, "from"),
      to: checkDate(body.to, "to"),
    }),
  "sync-time": (device) => commands.syncTime(device.deviceType, new Date(), TIMEZONE),
  "open-door": (device, body) =>
    commands.openDoor(device.deviceType, body.seconds === undefined ? 5 : toInt(body.seconds, 5, 1, 254)),
  reboot: (device) => commands.reboot(device.deviceType),
};

router.post("/devices/:sn/actions/:action", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  if (!Object.prototype.hasOwnProperty.call(actions, req.params.action)) {
    throw new HttpError(400, `Unknown action: ${req.params.action}`);
  }
  const action = actions[req.params.action];
  const body = req.body || {};
  const list = build(() => action(device, body));
  res.status(202).json(await queue(device.sn, req.params.action, list));
}));

router.get("/devices/:sn/commands", asyncRoute(async (req, res) => {
  const device = await loadDevice(req.params.sn);
  const rows = await deviceService.listCommands(device.sn, toInt(req.query.limit, 50, 1, 500));
  res.json(rows.map(redactRow));
}));

const attendanceFilter = (query) => ({
  sn: query.sn ? checkSn(query.sn) : undefined,
  pin: query.pin ? checkPin(query.pin, DEVICE_PIN_PATTERN) : undefined,
  from: checkDate(query.from, "from"),
  to: checkDate(query.to, "to"),
});

router.get("/attendance", asyncRoute(async (req, res) => {
  const filter = attendanceFilter(req.query);
  const limit = toInt(req.query.limit, 100, 1, 1000);
  const offset = toInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  res.json(await queryAttendance({ ...filter, limit, offset }));
}));

const csvCell = (value) => {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

router.get("/attendance.csv", asyncRoute(async (req, res) => {
  const filter = attendanceFilter(req.query);
  const columns = ["id", "deviceSN", "pin", "activityTime", "stateId"];
  const lines = [columns.join(",")];
  for (let offset = 0; ; offset += CSV_PAGE) {
    const { rows } = await queryAttendance({ ...filter, limit: CSV_PAGE, offset });
    rows.forEach((row) => lines.push(columns.map((column) => csvCell(row[column])).join(",")));
    if (rows.length < CSV_PAGE) break;
  }
  res
    .set("Content-Type", "text/csv; charset=utf-8")
    .set("Content-Disposition", 'attachment; filename="attendance.csv"')
    .send(lines.join("\r\n") + "\r\n");
}));

router.use((_, res) => res.status(404).json({ message: "Not found" }));

router.use((error, _, res, __) => {
  if (error.status && error.status < 500) {
    const message = error.type === "entity.parse.failed" ? "Invalid JSON body" : error.message;
    return res.status(error.status).json({ message });
  }
  console.error("Admin API error:", error);
  return res.status(500).json({ message: "Internal server error" });
});

module.exports = router;
