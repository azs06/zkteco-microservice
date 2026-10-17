const db = require("./db");

const now = () => new Date().toISOString();

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

const all = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

const parseInfo = (value) => {
  try {
    const info = JSON.parse(value || "{}");
    return info && typeof info === "object" ? info : {};
  } catch (_) {
    return {};
  }
};

const toDevice = (row) => row && { ...row, approved: !!row.approved, info: parseInfo(row.info) };

const clean = (value) => (value === undefined || value === null ? null : String(value).trim() || null);

// Records that a device talked to us. Only non-empty values overwrite stored ones;
// info is merged into the stored JSON object. With keepType, deviceType is only filled in
// when unknown (the query-string DeviceType is easy to fake; registry data replaces it).
const upsertDeviceSeen = async ({ sn, ip, userAgent, deviceType, firmware, pushVersion, info, keepType } = {}) => {
  if (!sn) return;
  const timestamp = now();
  const infoJson = info && Object.keys(info).length ? JSON.stringify(info) : null;
  await run(
    `INSERT INTO devices (sn, deviceType, firmware, pushVersion, ip, userAgent, approved, lastSeen, info, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(sn) DO UPDATE SET
       deviceType = CASE WHEN ? THEN COALESCE(deviceType, excluded.deviceType) ELSE COALESCE(excluded.deviceType, deviceType) END,
       firmware = COALESCE(excluded.firmware, firmware),
       pushVersion = COALESCE(excluded.pushVersion, pushVersion),
       ip = COALESCE(excluded.ip, ip),
       userAgent = COALESCE(excluded.userAgent, userAgent),
       lastSeen = excluded.lastSeen,
       info = CASE WHEN excluded.info IS NULL THEN info ELSE json_patch(COALESCE(info, '{}'), excluded.info) END`,
    [sn, clean(deviceType), clean(firmware), clean(pushVersion), clean(ip), clean(userAgent), timestamp, infoJson, timestamp, keepType ? 1 : 0]
  );
  if (infoJson) {
    await run(
      `UPDATE devices SET name = json_extract(info, '$."~DeviceName"')
       WHERE sn = ? AND (name IS NULL OR name = '') AND json_extract(info, '$."~DeviceName"') IS NOT NULL`,
      [sn]
    );
  }
};

// Unadmitted requests: create a pending row (capped, so strangers can't flood the table)
// or bump lastSeen, but never overwrite what an admitted device reported.
const MAX_PENDING_DEVICES = 100;

const recordUnadmittedDevice = async ({ sn, ip, userAgent, deviceType, pushVersion } = {}) => {
  if (!sn) return;
  const timestamp = now();
  const { changes } = await run("UPDATE devices SET lastSeen = ? WHERE sn = ?", [timestamp, sn]);
  if (changes) return;
  await run(
    `INSERT INTO devices (sn, deviceType, pushVersion, ip, userAgent, approved, lastSeen, createdAt)
     SELECT ?, ?, ?, ?, ?, 0, ?, ? WHERE (SELECT COUNT(*) FROM devices WHERE approved = 0) < ?
     ON CONFLICT(sn) DO UPDATE SET lastSeen = excluded.lastSeen`,
    [sn, clean(deviceType), clean(pushVersion), clean(ip), clean(userAgent), timestamp, timestamp, MAX_PENDING_DEVICES]
  );
};

const getDevice = async (sn) => toDevice(await get("SELECT * FROM devices WHERE sn = ?", [sn]));

const listDevices = async () => {
  const rows = await all(
    `SELECT d.*, (SELECT COUNT(*) FROM device_users u WHERE u.deviceSN = d.sn) AS userCount
     FROM devices d ORDER BY d.lastSeen DESC`
  );
  return rows.map(toDevice);
};

// Insert or update a device from the admin side; undefined fields are left unchanged.
const saveDevice = async ({ sn, name, approved } = {}) => {
  if (!sn) throw new Error("Missing device serial number");
  const approvedValue = approved === undefined ? null : approved ? 1 : 0;
  await run(
    `INSERT INTO devices (sn, name, approved, createdAt) VALUES (?, ?, COALESCE(?, 0), ?)
     ON CONFLICT(sn) DO UPDATE SET
       name = CASE WHEN ? THEN excluded.name ELSE name END,
       approved = COALESCE(?, approved)`,
    [sn, name === undefined ? null : name, approvedValue, now(), name === undefined ? 0 : 1, approvedValue]
  );
  return getDevice(sn);
};

const deleteDevice = async (sn) => {
  await run("DELETE FROM device_users WHERE deviceSN = ?", [sn]);
  await run("DELETE FROM commands WHERE deviceSN = ?", [sn]);
  await run("DELETE FROM devices WHERE sn = ?", [sn]);
};

const isDeviceApproved = async (sn) => {
  if (!sn) return false;
  const row = await get("SELECT approved FROM devices WHERE sn = ?", [sn]);
  return !!(row && row.approved);
};

const comparePins = (a, b) => String(a.pin).localeCompare(String(b.pin), undefined, { numeric: true });

const listDeviceUsers = async (sn) => {
  const rows = await all(
    "SELECT pin, name, cardNo, privilege, updatedAt FROM device_users WHERE deviceSN = ?",
    [sn]
  );
  return rows.sort(comparePins);
};

const upsertDeviceUsers = async (sn, users = []) => {
  const timestamp = now();
  for (const user of users) {
    if (!user || !user.pin) continue;
    await run(
      `INSERT INTO device_users (deviceSN, pin, name, cardNo, privilege, password, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(deviceSN, pin) DO UPDATE SET
         name = excluded.name, cardNo = excluded.cardNo, privilege = excluded.privilege,
         password = excluded.password, updatedAt = excluded.updatedAt`,
      [sn, String(user.pin), user.name || "", user.cardNo || "", parseInt(user.privilege, 10) || 0, user.password || "", timestamp]
    );
  }
};

const deleteDeviceUser = (sn, pin) => run("DELETE FROM device_users WHERE deviceSN = ? AND pin = ?", [sn, String(pin)]);

// Removes users not touched since `since` (used after a complete user query from the device).
const pruneDeviceUsers = (sn, since) => run("DELETE FROM device_users WHERE deviceSN = ? AND updatedAt < ?", [sn, since]);

const queueCommands = async (sn, kind, commands = []) => {
  const created = [];
  for (const command of commands) {
    const { lastID } = await run(
      "INSERT INTO commands (deviceSN, kind, command, status, createdAt) VALUES (?, ?, ?, 'pending', ?)",
      [sn, kind, command, now()]
    );
    created.push(await get("SELECT * FROM commands WHERE id = ?", [lastID]));
  }
  return created;
};

const SENT_TIMEOUT_MS = 10 * 60 * 1000;
const TIMED_OUT = "No reply from device (timed out)";
const ATTENDANCE_QUERY_WINDOW_MS = 10 * 60 * 1000;

// Atomically claims the oldest pending commands for delivery via /iclock/getrequest.
// Commands left 'sent' too long are marked failed; while a DATA QUERY is still in flight
// nothing else is sent, so the device finishes uploading before it gets more work.
const takePendingCommands = async (sn, limit = 10) => {
  await run(
    `UPDATE commands SET status = 'failed', result = COALESCE(result, ?), completedAt = ?
     WHERE deviceSN = ? AND status = 'sent' AND sentAt < ?`,
    [TIMED_OUT, now(), sn, new Date(Date.now() - SENT_TIMEOUT_MS).toISOString()]
  );
  const busy = await get(
    "SELECT id FROM commands WHERE deviceSN = ? AND status = 'sent' AND command LIKE 'DATA QUERY%' LIMIT 1",
    [sn]
  );
  if (busy) return [];
  const rows = await all(
    `UPDATE commands SET status = 'sent', sentAt = ?
     WHERE id IN (SELECT id FROM commands WHERE deviceSN = ? AND status = 'pending' ORDER BY id LIMIT ?)
     RETURNING *`,
    [now(), sn, limit]
  );
  return rows.sort((a, b) => a.id - b.id);
};

// Only the device a command was sent to can complete it. A late reply to a timed-out
// command (failed without a return code) is still accepted.
// A null/undefined result keeps whatever querydata already recorded for the command.
const completeCommand = (id, returnCode, result, sn) => {
  const code = parseInt(returnCode, 10);
  return run(
    `UPDATE commands SET status = ?, returnCode = ?, result = COALESCE(?, NULLIF(result, ?)), completedAt = ?
     WHERE id = ? AND deviceSN = ? AND (status = 'sent' OR (status = 'failed' AND returnCode IS NULL))`,
    [code >= 0 ? "success" : "failed", Number.isNaN(code) ? null : code, result === undefined ? null : result, TIMED_OUT, now(), id, sn]
  );
};

// The data may arrive before or after the device's devicecmd reply, so status isn't checked.
const setCommandResult = (id, result, sn) =>
  run("UPDATE commands SET result = ? WHERE id = ? AND deviceSN = ? AND status != 'pending'", [result, id, sn]);

// True while an attendance history query for this device is in flight or just finished;
// ATTLOG uploads in that window are (mostly) answers to it rather than live punches.
const isAttendanceQueryActive = async (sn) => {
  const since = new Date(Date.now() - ATTENDANCE_QUERY_WINDOW_MS).toISOString();
  const row = await get(
    `SELECT id FROM commands WHERE deviceSN = ? AND kind = 'fetch-attendance'
     AND (status = 'sent' OR completedAt > ?) LIMIT 1`,
    [sn, since]
  );
  return !!row;
};

const listCommands = (sn, limit = 50) =>
  all("SELECT * FROM commands WHERE deviceSN = ? ORDER BY id DESC LIMIT ?", [sn, parseInt(limit, 10) || 50]);

module.exports = {
  upsertDeviceSeen,
  recordUnadmittedDevice,
  getDevice,
  listDevices,
  saveDevice,
  deleteDevice,
  isDeviceApproved,
  listDeviceUsers,
  upsertDeviceUsers,
  deleteDeviceUser,
  pruneDeviceUsers,
  queueCommands,
  takePendingCommands,
  completeCommand,
  setCommandResult,
  isAttendanceQueryActive,
  listCommands,
};
