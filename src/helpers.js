const crypto = require("crypto");

// Handshake response for GET /iclock/cdata. Lines must not be indented.
// Delay/ErrorDelay are seconds; TransFlag=1000000000 pushes attendance logs only.
const getConfig = (req, offsetHours) => {
  return [
    `GET OPTION FROM: ${req.query.SN}`,
    "ATTLOGStamp=9999",
    "OPERLOGStamp=9999",
    "ATTPHOTOStamp=9999",
    "ErrorDelay=60",
    "Delay=30",
    "TransTimes=00:00;14:05",
    "TransInterval=1",
    "TransFlag=1000000000",
    `TimeZone=${offsetHours}`,
    "Realtime=1",
    "Encrypt=0",
  ].join("\n") + "\n";
};

// Parses an ATTLOG body: one record per line, tab-separated
// PIN, time, status, verify type, ... Newer firmware (e.g. SenseFace 2A) uses CRLF
// and ends each record with a trailing tab, so both are tolerated.
const parseAttendanceLog = (body, deviceSN) => {
  return (body || "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length)
    .map((line) => {
      const [pin, activityTime, stateId] = line.split("\t").map((field) => field.trim());
      if (!pin || !activityTime || pin.includes("LOG") || stateId == 255) return null;
      return { pin, activityTime, stateId: parseInt(stateId, 10) || 0, deviceSN };
    })
    .filter(Boolean);
};

// Access-control devices (DeviceType=acc, e.g. SenseFace 2A) use the "Security PUSH"
// protocol: they register at /iclock/registry, fetch these options from /iclock/push
// and upload punches as table=rtlog.
const getRegistryCode = (serial) =>
  crypto.createHash("sha1").update(`zk-acc-${serial}`).digest("hex").slice(0, 10);

const getAccConfig = (serial, offsetHours) => {
  return [
    "registry=ok",
    `RegistryCode=${getRegistryCode(serial)}`,
    "ServerVersion=3.1.2",
    "ServerName=ADMS",
    "PushProtVer=3.1.2",
    "ErrorDelay=30",
    "RequestDelay=2",
    "TransTimes=00:00;14:00",
    "TransInterval=1",
    "TransTables=User Transaction",
    `TimeZone=${offsetHours}`,
    "Realtime=1",
    `SessionID=${getRegistryCode(`session-${serial}`)}`,
    "TimeoutSec=10",
  ].join("\n");
};

// Parses an rtlog body: one event per line, tab-separated key=value pairs, e.g.
// time=2026-10-17 14:00:00  pin=1  cardno=0  eventaddr=1  event=0  inoutstatus=0  verifytype=15
// Event codes below 20 are successful verifications; higher codes are denials,
// alarms and door events, which aren't attendance.
const parseRealtimeLog = (body, deviceSN) => {
  return (body || "")
    .split("\n")
    .filter((line) => line.trim().length)
    .map((line) => {
      const fields = {};
      for (const pair of line.trim().split("\t")) {
        const i = pair.indexOf("=");
        if (i > 0) fields[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      return fields;
    })
    .filter(({ pin, time, event }) => pin && pin !== "0" && time && parseInt(event, 10) < 20)
    .map(({ pin, time, inoutstatus }) => {
      // inoutstatus: 0 = entry, 1 = exit, anything else = no direction
      const status = parseInt(inoutstatus, 10);
      return { pin, activityTime: time, stateId: status === 0 || status === 1 ? status : -1, deviceSN };
    });
};

// Security PUSH time encoding: seconds since 2000 with every month counted as 31 days.
const encodeDeviceSeconds = (date) => {
  const days = (date.getUTCFullYear() - 2000) * 12 * 31 + date.getUTCMonth() * 31 + date.getUTCDate() - 1;
  return days * 86400 + date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
};

// Decodes a time_second value (device local time) to "YYYY-MM-DD HH:mm:ss", no timezone shift.
const decodeDeviceSeconds = (value) => {
  let t = parseInt(value, 10);
  if (!Number.isFinite(t) || t < 0) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const sec = t % 60; t = Math.floor(t / 60);
  const min = t % 60; t = Math.floor(t / 60);
  const hour = t % 24; t = Math.floor(t / 24);
  const day = (t % 31) + 1; t = Math.floor(t / 31);
  const month = (t % 12) + 1;
  const year = Math.floor(t / 12) + 2000;
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}:${pad(sec)}`;
};

// Time sync reply for GET /iclock/rtdata?type=time. DateTime is UTC.
const getDeviceTime = (date, serverTZ) => `DateTime=${encodeDeviceSeconds(date)},ServerTZ=${serverTZ}`;

// Parses comma-separated key=value bodies (registry, table=OPTIONS). Values may contain
// commas, so only split where a comma is followed by another (~)key=.
const parseKeyValues = (body) => {
  const fields = {};
  for (const part of (body || "").trim().replace(/\s*[\r\n]+\s*/g, ",").split(/,(?=~?[\w.]+=)/)) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return fields;
};

// Parses one tab-separated data line such as "user uid=1\tpin=1\tname=Alice" or
// "USER PIN=1\tName=X". The first field starts with the table name; keys are lowercased.
const parseTabLine = (line) => {
  const parts = (line || "").replace(/\r$/, "").split("\t");
  let table = "";
  const first = parts[0] || "";
  const space = first.indexOf(" ");
  if (space > 0 && !first.slice(0, space).includes("=")) {
    table = first.slice(0, space).trim();
    parts[0] = first.slice(space + 1);
  }
  const fields = {};
  for (const pair of parts) {
    const i = pair.indexOf("=");
    if (i > 0) fields[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
  }
  return { table, fields };
};

const toLines = (body) => (body || "").split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.trim());

// Device user records: Security PUSH "user ..." lines and att OPERLOG/USERINFO "USER ..." lines.
const parseUserLines = (body) => {
  return toLines(body)
    .map(parseTabLine)
    .filter(({ table }) => !table || table.toLowerCase() === "user")
    .map(({ fields }) => ({
      pin: fields.pin,
      name: fields.name || "",
      cardNo: fields.cardno || fields.card || "",
      privilege: parseInt(fields.privilege ?? fields.pri, 10) || 0,
      password: fields.password || fields.passwd || "",
    }))
    .filter(({ pin }) => pin);
};

// querydata tablename=transaction lines, e.g.
// transaction cardno=0  pin=1  verified=15  doorid=1  eventtype=0  inoutstate=0  time_second=861178800
const parseTransactionLines = (body, deviceSN) => {
  return toLines(body)
    .map((line) => parseTabLine(line).fields)
    .filter(({ pin, time_second, eventtype }) =>
      pin && pin !== "0" && parseInt(time_second, 10) > 0 && !(parseInt(eventtype, 10) >= 20))
    .map(({ pin, time_second, inoutstate }) => {
      const status = parseInt(inoutstate, 10);
      return {
        pin,
        activityTime: decodeDeviceSeconds(time_second),
        stateId: status === 0 || status === 1 ? status : -1,
        deviceSN,
      };
    })
    .filter(({ activityTime }) => activityTime);
};

const getStateById = (stateId) => {
  let state = "clock-in";
  switch (parseInt(stateId, 10)) {
    case 0:
      state = "clock-in";
      break;
    case 1:
      state = "clock-out";
      break;
    case 2:
      state = "break-in";
      break;
    case 3:
      state = "break-out";
      break;
    case 4:
      state = "overtime-in";
      break;
    case 5:
      state = "overtime-out";
      break;
    default:
      state = "unknown";  
  }

  return state;
};

function logger(req, res, next) {
  console.log(req.method, req.url);
  next();
}

function log(data){
  if(process.env.NODE_ENV === 'production') return;
  console.log(data);
}

module.exports = {
  getConfig,
  parseAttendanceLog,
  getRegistryCode,
  getAccConfig,
  parseRealtimeLog,
  getDeviceTime,
  encodeDeviceSeconds,
  decodeDeviceSeconds,
  parseKeyValues,
  parseTabLine,
  parseUserLines,
  parseTransactionLines,
  toLines,
  getStateById,
  logger,
  log
};
