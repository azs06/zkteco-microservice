// Builders for device commands (queued without the "C:<id>:" prefix); port of ../src/commands.js.
// deviceType "acc" is the Security PUSH protocol (e.g. SenseFace 2A); anything else is att/ADMS.
import { HttpError } from "../types";
import { encodeDeviceSeconds } from "./format";

const isAcc = (deviceType: string | null): boolean => deviceType === "acc";

const invalid = (message: string): HttpError => new HttpError(400, message);

// Values are tab-separated on the wire, so tabs and newlines can't appear inside them.
const value = (input: unknown): string => String(input ?? "").replace(/[\t\r\n]+/g, " ").trim();

const requirePin = (pin: unknown): string => {
  const clean = value(pin);
  if (!clean) throw invalid("User PIN is required");
  if (/[\s=]/.test(clean)) throw invalid("User PIN must not contain spaces or '='");
  return clean;
};

const requirePrivilege = (privilege: unknown): number => {
  const level = privilege === undefined || privilege === null || privilege === "" ? 0 : Number(privilege);
  if (!Number.isInteger(level) || level < 0) throw invalid("Privilege must be a non-negative integer");
  return level;
};

const DATE_TIME = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;

const toDateTime = (input: unknown, endOfDay: boolean): string => {
  const text = value(input);
  if (!DATE_TIME.test(text)) {
    throw invalid(`Invalid date "${String(input)}", expected YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`);
  }
  return text.length === 10 ? `${text} ${endOfDay ? "23:59:59" : "00:00:00"}` : text;
};

export function addUser(
  deviceType: string | null,
  u: { pin: string; name?: string; cardNo?: string; privilege?: number; password?: string }
): string[] {
  const id = requirePin(u.pin);
  const level = requirePrivilege(u.privilege);
  if (isAcc(deviceType)) {
    return [
      `DATA UPDATE user CardNo=${value(u.cardNo)}\tPin=${id}\tPassword=${value(u.password)}\tGroup=0\tStartTime=0\tEndTime=0\tName=${value(u.name)}\tPrivilege=${level}`,
      // Without an authorization the device recognises the user but denies access.
      `DATA UPDATE userauthorize Pin=${id}\tAuthorizeTimezoneId=1\tAuthorizeDoorId=1`,
    ];
  }
  return [
    `DATA UPDATE USERINFO PIN=${id}\tName=${value(u.name)}\tPri=${level}\tPasswd=${value(u.password)}\tCard=${value(u.cardNo)}\tGrp=1`,
  ];
}

export function deleteUser(deviceType: string | null, pin: string): string[] {
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
}

export function queryUsers(deviceType: string | null): string[] {
  if (isAcc(deviceType)) return ["DATA QUERY tablename=user,fielddesc=*,filter=*"];
  // Unverified on real att hardware (taken from s0x90/zkteco-adms); users come back as OPERLOG/USERINFO.
  return ["DATA QUERY USERINFO"];
}

const MAX_MONTHS = 12;
const pad = (n: number): string => String(n).padStart(2, "0");

// Splits a range into calendar-month pieces; one huge query can stall the device.
const monthlyRanges = (start: string, end: string): [string, string][] => {
  const ranges: [string, string][] = [];
  let from = start;
  while (from <= end) {
    const year = parseInt(from.slice(0, 4), 10);
    const month = parseInt(from.slice(5, 7), 10);
    const next = month === 12 ? `${year + 1}-01-01 00:00:00` : `${year}-${pad(month + 1)}-01 00:00:00`;
    const lastSecond = new Date(Date.parse(next.replace(" ", "T") + "Z") - 1000).toISOString().replace("T", " ").slice(0, 19);
    ranges.push([from, lastSecond < end ? lastSecond : end]);
    if (ranges.length > MAX_MONTHS) throw invalid(`Date range is too long: fetch at most ${MAX_MONTHS} months at a time`);
    from = next;
  }
  return ranges;
};

export function queryAttendance(deviceType: string | null, range: { from: string; to: string }): string[] {
  const { from, to } = range ?? {};
  if (!from || !to) throw invalid("'from' and 'to' are required to fetch attendance from this device");
  const start = toDateTime(from, false);
  const end = toDateTime(to, true);
  if (start > end) throw invalid("'from' must not be after 'to'");
  if (isAcc(deviceType)) {
    // filter=* (and very long ranges) on transaction can hang SenseFace firmware, so a
    // range is required and split by month. The StartTime/EndTime filter syntax is taken
    // from jose-cleiton/zekateco-web and is unverified on the SenseFace 2A.
    return monthlyRanges(start, end).map(
      ([first, last]) => `DATA QUERY tablename=transaction,fielddesc=*,filter=StartTime=${first},EndTime=${last}`
    );
  }
  return [`DATA QUERY ATTLOG StartTime=${start}\tEndTime=${end}`];
}

// DateTime is interpreted by the device as UTC; it applies its own timezone setting.
export function syncTime(deviceType: string | null, at: Date = new Date()): string[] {
  if (!isAcc(deviceType)) throw invalid("Time sync is not supported for this device type");
  if (Number.isNaN(at.getTime())) throw invalid("Invalid date for time sync");
  return [`SET OPTIONS DateTime=${encodeDeviceSeconds(at)}`];
}

// CONTROL DEVICE AABBCCDD: 01 = output, BB = door 1, CC = 01 lock, DD = open seconds (hex byte).
export function openDoor(deviceType: string | null, seconds: number = 5): string[] {
  if (!isAcc(deviceType)) throw invalid("Remote door opening is not supported for this device type");
  const duration = Number(seconds);
  if (!Number.isInteger(duration) || duration < 1 || duration > 254) {
    throw invalid("Door open duration must be a whole number of seconds between 1 and 254");
  }
  return [`CONTROL DEVICE 010101${duration.toString(16).toUpperCase().padStart(2, "0")}`];
}

// Security PUSH devices restart with CONTROL DEVICE 03000000; REBOOT is the att/ADMS command.
export function reboot(deviceType: string | null): string[] {
  return isAcc(deviceType) ? ["CONTROL DEVICE 03000000"] : ["REBOOT"];
}

// Hides user passwords when commands are shown or logged.
export function redact(command: string): string {
  return String(command || "").replace(/((?:Password|Passwd)=)[^\t]+/g, "$1***");
}
