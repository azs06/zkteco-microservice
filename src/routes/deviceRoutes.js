const express = require("express");
const moment = require("moment-timezone");
const getRawBody = require("raw-body");
const NodeCache = require("node-cache");
const { insertAttendance } = require("../database/dbService");
const deviceService = require("../database/deviceService");
const { postAttendance } = require("../services/apiService");
const {
  getConfig,
  parseAttendanceLog,
  getRegistryCode,
  getAccConfig,
  parseRealtimeLog,
  getDeviceTime,
  parseKeyValues,
  parseUserLines,
  parseTransactionLines,
  toLines,
  log,
} = require("../helpers");
const { redact } = require("../commands");
const { TIMEZONE, API_INTEGRATION_ENABLED } = require("../constants");

const { authenticate } = require("../middleware/auth");

const router = express.Router();
// Devices send each query parameter once; collapse repeats (?table=A&table=B) to the first
// value so handlers can treat every parameter as a string.
router.use((req, _, next) => {
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) req.query[key] = value[0];
    if (typeof req.query[key] !== "string") req.query[key] = "";
  }
  next();
});
router.use(authenticate);
const configCache = new NodeCache({ stdTTL: 600 });
const offsetMinutes = moment.tz(TIMEZONE).utcOffset();
const offsetHours = offsetMinutes / 60;

// Stores attendance records (duplicates skipped) one at a time and, when `forward` says so,
// posts new ones to the API. The API takes no timestamp, so fetched history must not be
// forwarded: it would arrive as punches at the current time.
const saveAttendance = async (records, forward = () => true) => {
  const results = [];
  for (const record of records) {
    const saved = await insertAttendance(record);
    if (saved.inserted && API_INTEGRATION_ENABLED && forward(record)) await postAttendance(record);
    results.push(saved);
  }
  return results;
};

const LIVE_WINDOW_MINUTES = 10;
const isRecent = ({ activityTime }) => {
  const time = moment.tz(activityTime, "YYYY-MM-DD HH:mm:ss", TIMEZONE);
  return time.isValid() && Math.abs(moment().diff(time, "minutes")) <= LIVE_WINDOW_MINUTES;
};

// att devices answer DATA QUERY ATTLOG with ordinary ATTLOG uploads. While such a query is
// active only recent punches are forwarded; otherwise everything is, as before.
const attlogForwarding = async (SN) => {
  try {
    if (SN && (await deviceService.isAttendanceQueryActive(SN))) return isRecent;
  } catch (error) {
    console.error("Error checking attendance queries:", error.message);
  }
  return () => true;
};

// Device bookkeeping must never break the device conversation.
const track = (promise, what) => promise.catch((error) => console.error(`Error ${what}:`, error.message));

// Registry and table=OPTIONS bodies describe the device (comma-separated key=value).
const recordDeviceInfo = (SN, body) => {
  const info = parseKeyValues(body);
  if (!SN || !Object.keys(info).length) return Promise.resolve();
  return track(
    deviceService.upsertDeviceSeen({
      sn: SN,
      deviceType: info.DeviceType,
      firmware: info.FirmVer || info.FWVersion,
      info,
    }),
    "recording device info"
  );
};

const saveUsers = (SN, body) => {
  const users = parseUserLines(body);
  if (!SN || !users.length) return Promise.resolve(users);
  return track(deviceService.upsertDeviceUsers(SN, users), "saving device users").then(() => users);
};

router.use((req, _, next) => {
  getRawBody(
    req,
    { length: req.headers["content-length"], limit: "1mb", encoding: "utf8" },
    (err, string) => {
      if (err) return next(err);
      req.text = string;
      next();
    }
  );
});

router.get("/iclock/cdata", async (req, res) => {
  if (!req.query.SN) {
    return res.status(400).json({ message: "Missing required parameter: SN" });
  }
  res.set("Content-Type", "text/plain").set("Date", new Date().toUTCString());
  let SN = req.query.SN;
  if (req.query.DeviceType === "acc") return res.send(getAccConfig(SN, offsetHours));
  let cachedConfig = configCache.get(SN);
  if (cachedConfig) return res.send(cachedConfig);

  let configuration = getConfig(req, offsetHours);
  configCache.set(SN, configuration);
  res.send(configuration);
});

// Delivers commands queued from the admin UI as "C:<id>:<command>" lines; "OK" when
// there are none. One command per poll, as the reference implementations do. (Never queue DATA QUERY ATTLOG on every poll: devices then re-upload
// their recent logs.)
router.get("/iclock/getrequest", async (req, res) => {
  res.set("Content-Type", "text/plain").set("Date", new Date().toUTCString());
  let commands = [];
  try {
    if (req.query.SN) commands = await deviceService.takePendingCommands(req.query.SN, 1);
  } catch (error) {
    console.error("Error loading device commands:", error.message);
  }
  if (!commands.length) return res.send("OK");
  log({ SN: req.query.SN, commands: commands.map(({ id, command }) => `C:${id}:${redact(command)}`) });
  res.send(commands.map(({ id, command }) => `C:${id}:${command}\n`).join(""));
});

router.post("/iclock/registry", async (req, res) => {
  await recordDeviceInfo(req.query.SN, req.text);
  res.set("Content-Type", "text/plain");
  res.send(`RegistryCode=${getRegistryCode(req.query.SN)}`);
});

router.all("/iclock/push", (req, res) => {
  res.set("Content-Type", "text/plain");
  res.send(getAccConfig(req.query.SN, offsetHours));
});

router.get("/iclock/ping", (_, res) => {
  res.set("Content-Type", "text/plain").send("OK");
});

router.get("/iclock/rtdata", (req, res) => {
  res.set("Content-Type", "text/plain");
  if (req.query.type !== "time") return res.send("OK");
  res.send(getDeviceTime(new Date(), moment.tz(TIMEZONE).format("ZZ")));
});

router.post("/iclock/cdata", async (req, res) => {
  res.set("Content-Type", "text/plain").set("Date", new Date().toUTCString());
  const table = (req.query.table || "ATTLOG").toUpperCase();

  // Attendance devices send ATTLOG; access-control devices (SenseFace 2A) send rtlog.
  // Everything else (OPTIONS, OPERLOG, USER, BIODATA, tabledata, rtstate, ...) is
  // acknowledged so it isn't re-sent, but not stored.
  if (table !== "ATTLOG" && table !== "RTLOG") {
    log({ SN: req.query.SN, table, tablename: req.query.tablename, body: req.text });
    if (table === "OPTIONS") await recordDeviceInfo(req.query.SN, req.text);
    // Users enrolled on the device: Security PUSH tabledata, att OPERLOG "USER PIN=..." lines.
    const isUserTable = table === "TABLEDATA" && (req.query.tablename || "").toLowerCase() === "user";
    if (isUserTable || table === "OPERLOG" || table === "USERINFO") await saveUsers(req.query.SN, req.text);
    if (table === "TABLEDATA") {
      const count = (req.text || "").split("\n").filter((line) => line.trim()).length;
      return res.send(`${req.query.tablename}=${count}`);
    }
    return res.send("OK");
  }

  if (table === "RTLOG") log({ SN: req.query.SN, table, body: req.text });
  const records =
    table === "RTLOG" ? parseRealtimeLog(req.text, req.query.SN) : parseAttendanceLog(req.text, req.query.SN);

  try {
    await saveAttendance(records, table === "RTLOG" ? undefined : await attlogForwarding(req.query.SN));
    res.send(table === "RTLOG" ? "OK" : "OK:" + records.length);
  } catch (error) {
    console.error("Error inserting attendance:", error.message);
    res.send("FAIL");
  }
});

// Command results, one per line: ID=<id>&Return=<code>&CMD=<cmd> (Return < 0 = error).
// The spec mostly writes "return" in lowercase, so keys are matched case-insensitively.
router.post("/iclock/devicecmd", async (req, res) => {
  log({ SN: req.query.SN, devicecmd: req.text });
  for (const line of (req.text || "").split("\n")) {
    const params = {};
    for (const [key, value] of new URLSearchParams(line.trim())) params[key.toLowerCase()] = value;
    const id = parseInt(params.id, 10);
    if (!id || params.return === undefined || !req.query.SN) continue;
    await track(deviceService.completeCommand(id, params.return, undefined, req.query.SN), "completing device command");
  }
  res.set("Content-Type", "text/plain");
  res.send("OK");
});

// Answers to DATA QUERY commands, possibly split into packets (packidx of packcnt).
const userSyncStarts = new Map();
const querySummaries = new Map();

router.post("/iclock/querydata", async (req, res) => {
  res.set("Content-Type", "text/plain");
  const { SN, cmdid } = req.query;
  const tablename = (req.query.tablename || "").toLowerCase();
  const packidx = parseInt(req.query.packidx, 10) || 1;
  const packcnt = parseInt(req.query.packcnt, 10) || 1;
  log({ SN, querydata: tablename, cmdid, count: req.query.count, packidx, packcnt, body: req.text });

  let summary = null;
  try {
    if (tablename === "user") {
      if (packidx === 1) userSyncStarts.set(SN, new Date().toISOString());
      const users = await saveUsers(SN, req.text);
      summary = { label: "users", count: users.length };
      // A complete answer to an unfiltered query: drop local users the device no longer has.
      const since = userSyncStarts.get(SN);
      if (packidx === packcnt && since && req.query.count !== undefined) {
        userSyncStarts.delete(SN);
        await track(deviceService.pruneDeviceUsers(SN, since), "pruning device users");
      }
    } else if (tablename === "transaction") {
      const records = parseTransactionLines(req.text, SN);
      const saved = await saveAttendance(records, () => false);
      summary = { label: "attendance records", count: records.length, inserted: saved.filter((row) => row.inserted).length };
    }
  } catch (error) {
    console.error(`Error storing querydata ${tablename}:`, error.message);
  }

  if (cmdid && summary) {
    const key = `${SN}:${cmdid}`;
    const total = (querySummaries.get(key) || { count: 0, inserted: 0 });
    total.count += summary.count;
    total.inserted += summary.inserted || 0;
    if (packidx >= packcnt) querySummaries.delete(key);
    else querySummaries.set(key, total);
    const text = `${total.count} ${summary.label}` +
      (summary.inserted !== undefined ? ` (${total.inserted} new)` : "") +
      (packcnt > 1 ? `, packet ${packidx}/${packcnt}` : "");
    await track(deviceService.setCommandResult(parseInt(cmdid, 10), text, SN), "saving command result");
  }
  // Spec: "$(TableName)=$(count)" for the lines received (the references reply OK; both work).
  if (summary) return res.send(`${req.query.tablename}=${toLines(req.text).length}`);
  res.send("OK");
});

// Anything else the firmware calls (registry, ping, querydata, ...): log it so the
// device's traffic can be inspected, and acknowledge instead of returning a 404.
router.all("/iclock/*", (req, res) => {
  console.warn("Unhandled device request:", { method: req.method, path: req.path, query: req.query, userAgent: req.header("User-Agent"), body: req.text });
  res.set("Content-Type", "text/plain").send("OK");
});

module.exports = router;
