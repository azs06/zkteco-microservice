const { encodeDeviceSeconds } = require("./helpers");

// Builders for device commands (queued without the "C:<id>:" prefix). deviceType "acc"
// is the Security PUSH protocol (e.g. SenseFace 2A); anything else is the att/ADMS protocol.

const isAcc = (deviceType) => deviceType === "acc";

// Values are tab-separated on the wire, so tabs and newlines can't appear inside them.
const value = (input) => String(input ?? "").replace(/[\t\r\n]+/g, " ").trim();

const requirePin = (pin) => {
  const clean = value(pin);
  if (!clean) throw new Error("User PIN is required");
  if (/[\s=]/.test(clean)) throw new Error("User PIN must not contain spaces or '='");
  return clean;
};

const requirePrivilege = (privilege) => {
  const level = privilege === undefined || privilege === null || privilege === "" ? 0 : Number(privilege);
  if (!Number.isInteger(level) || level < 0) throw new Error("Privilege must be a non-negative integer");
  return level;
};

const DATE_TIME = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;

const toDateTime = (input, endOfDay) => {
  const text = value(input);
  if (!DATE_TIME.test(text)) throw new Error(`Invalid date "${input}", expected YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`);
  return text.length === 10 ? `${text} ${endOfDay ? "23:59:59" : "00:00:00"}` : text;
};

const addUser = (deviceType, { pin, name, cardNo, privilege, password } = {}) => {
  const id = requirePin(pin);
  const level = requirePrivilege(privilege);
  if (isAcc(deviceType)) {
    return [
      // Group 1 is the default access group. Group 0 makes the device treat the user as part of a
      // multi-user combination, so every verification fails with event 48 ("invalid combination").
      `DATA UPDATE user CardNo=${value(cardNo)}\tPin=${id}\tPassword=${value(password)}\tGroup=1\tStartTime=0\tEndTime=0\tName=${value(name)}\tPrivilege=${level}`,
      // Without an authorization the device recognises the user but denies access.
      `DATA UPDATE userauthorize Pin=${id}\tAuthorizeTimezoneId=1\tAuthorizeDoorId=1`,
    ];
  }
  return [`DATA UPDATE USERINFO PIN=${id}\tName=${value(name)}\tPri=${level}\tPasswd=${value(password)}\tCard=${value(cardNo)}\tGrp=1`];
};

const deleteUser = (deviceType, pin) => {
  const id = requirePin(pin);
  if (isAcc(deviceType)) {
    return [
      `DATA DELETE userauthorize Pin=${id}`,
      `DATA DELETE templatev10 Pin=${id}`,
      `DATA DELETE biophoto PIN=${id}\tType=9`,
      `DATA DELETE user Pin=${id}`,
    ];
  }
  return [`DATA DELETE USERINFO PIN=${id}`];
};

const queryUsers = (deviceType) => {
  if (isAcc(deviceType)) return ["DATA QUERY tablename=user,fielddesc=*,filter=*"];
  // Unverified on real att hardware (taken from s0x90/zkteco-adms); users come back as OPERLOG/USERINFO.
  return ["DATA QUERY USERINFO"];
};

const MAX_MONTHS = 12;
const pad = (n) => String(n).padStart(2, "0");

// Splits a range into calendar-month pieces; one huge query can stall the device.
const monthlyRanges = (start, end) => {
  const ranges = [];
  let from = start;
  while (from <= end) {
    const year = parseInt(from.slice(0, 4), 10);
    const month = parseInt(from.slice(5, 7), 10);
    const next = month === 12 ? `${year + 1}-01-01 00:00:00` : `${year}-${pad(month + 1)}-01 00:00:00`;
    const lastSecond = new Date(Date.parse(next.replace(" ", "T") + "Z") - 1000).toISOString().replace("T", " ").slice(0, 19);
    ranges.push([from, lastSecond < end ? lastSecond : end]);
    if (ranges.length > MAX_MONTHS) throw new Error(`Date range is too long: fetch at most ${MAX_MONTHS} months at a time`);
    from = next;
  }
  return ranges;
};

const queryAttendance = (deviceType, { from, to } = {}) => {
  if (isAcc(deviceType)) {
    // filter=* (and very long ranges) on transaction can hang SenseFace firmware, so a
    // range is required and split by month. The StartTime/EndTime filter syntax is taken
    // from jose-cleiton/zekateco-web and is unverified on the SenseFace 2A.
    if (!from || !to) throw new Error("'from' and 'to' are required to fetch attendance from this device");
    const start = toDateTime(from, false);
    const end = toDateTime(to, true);
    if (start > end) throw new Error("'from' must not be after 'to'");
    return monthlyRanges(start, end).map(
      ([first, last]) => `DATA QUERY tablename=transaction,fielddesc=*,filter=StartTime=${first},EndTime=${last}`
    );
  }
  if (!from || !to) throw new Error("'from' and 'to' are required to fetch attendance from this device");
  const start = toDateTime(from, false);
  const end = toDateTime(to, true);
  if (start > end) throw new Error("'from' must not be after 'to'");
  return [`DATA QUERY ATTLOG StartTime=${start}\tEndTime=${end}`];
};

// DateTime is interpreted by the device as UTC; it applies its own timezone setting.
const syncTime = (deviceType, date = new Date(), tz) => {
  if (!isAcc(deviceType)) throw new Error("Time sync is not supported for this device type");
  const when = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(when.getTime())) throw new Error("Invalid date for time sync");
  return [`SET OPTIONS DateTime=${encodeDeviceSeconds(when)}`];
};

// CONTROL DEVICE AABBCCDD: 01 = output, BB = door 1, CC = 01 lock, DD = open seconds (hex byte).
const openDoor = (deviceType, seconds = 5) => {
  if (!isAcc(deviceType)) throw new Error("Remote door opening is not supported for this device type");
  const duration = Number(seconds);
  if (!Number.isInteger(duration) || duration < 1 || duration > 254) {
    throw new Error("Door open duration must be a whole number of seconds between 1 and 254");
  }
  return [`CONTROL DEVICE 010101${duration.toString(16).toUpperCase().padStart(2, "0")}`];
};

// Security PUSH devices restart with CONTROL DEVICE 03000000; REBOOT is the att/ADMS command.
const reboot = (deviceType) => (isAcc(deviceType) ? ["CONTROL DEVICE 03000000"] : ["REBOOT"]);

// Hides user passwords when commands are shown or logged.
const redact = (command) => String(command || "").replace(/((?:Password|Passwd)=)[^\t]+/g, "$1***");

module.exports = {
  redact,
  addUser,
  deleteUser,
  queryUsers,
  queryAttendance,
  syncTime,
  openDoor,
  reboot,
};
