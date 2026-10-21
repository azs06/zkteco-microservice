// Device protocol formatting and parsing; port of ../src/helpers.js. Replies must stay
// byte-identical to the Express service, which was verified on a real SenseFace 2A.
import type { Direction, ParsedPunch, ParsedUser, VerifyMode } from "../types";

// Handshake response for GET /iclock/cdata. Lines must not be indented.
// Delay/ErrorDelay are seconds; TransFlag=1000000000 pushes attendance logs only.
export function getConfig(sn: string, offsetHours: number): string {
  return (
    [
      `GET OPTION FROM: ${sn}`,
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
    ].join("\n") + "\n"
  );
}

// Access-control devices (DeviceType=acc) register at /iclock/registry and must get the
// same code back on every registration, so it is derived from the serial.
export async function getRegistryCode(sn: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`zk-acc-${sn}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 10);
}

// Options for /iclock/registry and /iclock/push (Security PUSH). No trailing newline.
export async function getAccConfig(sn: string, offsetHours: number, requestDelay: number): Promise<string> {
  const [registryCode, sessionId] = await Promise.all([getRegistryCode(sn), getRegistryCode(`session-${sn}`)]);
  return [
    "registry=ok",
    `RegistryCode=${registryCode}`,
    "ServerVersion=3.1.2",
    "ServerName=ADMS",
    "PushProtVer=3.1.2",
    "ErrorDelay=30",
    `RequestDelay=${requestDelay}`,
    "TransTimes=00:00;14:00",
    "TransInterval=1",
    "TransTables=User Transaction",
    `TimeZone=${offsetHours}`,
    "Realtime=1",
    `SessionID=${sessionId}`,
    "TimeoutSec=10",
  ].join("\n");
}

// Security PUSH time encoding: seconds since 2000 with every month counted as 31 days.
export function encodeDeviceSeconds(date: Date): number {
  const days = (date.getUTCFullYear() - 2000) * 12 * 31 + date.getUTCMonth() * 31 + date.getUTCDate() - 1;
  return days * 86400 + date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
}

const pad = (n: number): string => String(n).padStart(2, "0");

// Decodes a time_second value (device local time) to "YYYY-MM-DD HH:mm:ss", no timezone shift.
export function decodeDeviceSeconds(value: string | number): string | null {
  let t = parseInt(String(value), 10);
  if (!Number.isFinite(t) || t < 0) return null;
  const sec = t % 60; t = Math.floor(t / 60);
  const min = t % 60; t = Math.floor(t / 60);
  const hour = t % 24; t = Math.floor(t / 24);
  const day = (t % 31) + 1; t = Math.floor(t / 31);
  const month = (t % 12) + 1;
  const year = Math.floor(t / 12) + 2000;
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}:${pad(sec)}`;
}

// Time sync reply for GET /iclock/rtdata?type=time. DateTime is UTC; serverTZ like "+0600".
export function getDeviceTime(date: Date, serverTZ: string): string {
  return `DateTime=${encodeDeviceSeconds(date)},ServerTZ=${serverTZ}`;
}

// Parses comma-separated key=value bodies (registry, table=OPTIONS). Values may contain
// commas, so only split where a comma is followed by another (~)key=.
export function parseKeyValues(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of (body || "").trim().replace(/\s*[\r\n]+\s*/g, ",").split(/,(?=~?[\w.]+=)/)) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return fields;
}

// Parses one tab-separated data line such as "user uid=1\tpin=1\tname=Alice" or
// "USER PIN=1\tName=X". The first field starts with the table name; keys are lowercased.
export function parseTabLine(line: string): { table: string; fields: Record<string, string> } {
  const parts = (line || "").replace(/\r$/, "").split("\t");
  let table = "";
  const first = parts[0] ?? "";
  const space = first.indexOf(" ");
  if (space > 0 && !first.slice(0, space).includes("=")) {
    table = first.slice(0, space).trim();
    parts[0] = first.slice(space + 1);
  }
  const fields: Record<string, string> = {};
  for (const pair of parts) {
    const i = pair.indexOf("=");
    if (i > 0) fields[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
  }
  return { table, fields };
}

// Newer firmware (e.g. SenseFace 2A) uses CRLF, so a trailing \r is dropped.
export function toLines(body: string): string[] {
  return (body || "").split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.trim());
}

// 0 => in, 1 => out; devices send 2/255 etc. when no direction was chosen.
const directionOf = (code: string | undefined): Direction => {
  const n = parseInt(code ?? "", 10);
  return n === 0 ? "in" : n === 1 ? "out" : null;
};

// ZKTeco verify type codes.
export function verifyModeOf(code: string | number | undefined): VerifyMode {
  switch (code === undefined || code === "" ? NaN : Number(code)) {
    case 0:
    case 3:
      return "password";
    case 1:
      return "fingerprint";
    case 2:
    case 4:
      return "card";
    case 15:
      return "face";
    case 25:
      return "palm";
    default:
      return "other";
  }
}

// ATTLOG body: one record per line, tab-separated PIN, time, status, verify type, ...
// SenseFace firmware ends each record with a trailing tab, which split tolerates.
export function parseAttendanceLog(body: string): ParsedPunch[] {
  const punches: ParsedPunch[] = [];
  for (const line of toLines(body)) {
    const [pin, time, status, verify] = line.split("\t").map((field) => field.trim());
    // Status 255 is the reference's "not an attendance record" marker; "LOG" lines are headers.
    if (!pin || !time || pin.includes("LOG") || Number(status) === 255) continue;
    punches.push({ pin, punchedAt: time, direction: directionOf(status), verifyMode: verifyModeOf(verify) });
  }
  return punches;
}

// Key=value fields of a tab-separated line without a table prefix (rtlog).
const tabFields = (line: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const pair of line.trim().split("\t")) {
    const i = pair.indexOf("=");
    if (i > 0) fields[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return fields;
};

// rtlog body, e.g. time=2026-10-17 14:00:00  pin=1  cardno=0  event=0  inoutstatus=0  verifytype=15
// Event codes below 20 are successful verifications; higher codes are denials,
// alarms and door events, which aren't attendance.
export function parseRealtimeLog(body: string): ParsedPunch[] {
  const punches: ParsedPunch[] = [];
  for (const line of toLines(body)) {
    const { pin, time, event, inoutstatus, verifytype } = tabFields(line);
    if (!pin || pin === "0" || !time || !(parseInt(event ?? "", 10) < 20)) continue;
    punches.push({ pin, punchedAt: time, direction: directionOf(inoutstatus), verifyMode: verifyModeOf(verifytype) });
  }
  return punches;
}

// querydata tablename=transaction lines, e.g.
// transaction cardno=0  pin=1  verified=15  doorid=1  eventtype=0  inoutstate=0  time_second=861178800
export function parseTransactionLines(body: string): ParsedPunch[] {
  const punches: ParsedPunch[] = [];
  for (const line of toLines(body)) {
    const { pin, time_second, eventtype, inoutstate, verified } = parseTabLine(line).fields;
    if (!pin || pin === "0" || !(parseInt(time_second ?? "", 10) > 0) || parseInt(eventtype ?? "", 10) >= 20) continue;
    const punchedAt = decodeDeviceSeconds(time_second ?? "");
    if (!punchedAt) continue;
    punches.push({ pin, punchedAt, direction: directionOf(inoutstate), verifyMode: verifyModeOf(verified) });
  }
  return punches;
}

// Device user records: Security PUSH "user ..." lines and att OPERLOG/USERINFO "USER ..." lines.
// Passwords are deliberately not returned (they are never stored).
export function parseUserLines(body: string): ParsedUser[] {
  const users: ParsedUser[] = [];
  for (const { table, fields } of toLines(body).map(parseTabLine)) {
    if (table && table.toLowerCase() !== "user") continue;
    if (!fields.pin) continue;
    users.push({
      pin: fields.pin,
      name: fields.name || "",
      cardNo: fields.cardno || fields.card || "",
      privilege: parseInt(fields.privilege ?? fields.pri ?? "", 10) || 0,
    });
  }
  return users;
}
