// Timezone helpers built on Intl only (no tz database shipped with the Worker).
import { HttpError } from "../types";

const formatters = new Map<string, Intl.DateTimeFormat>();

// One formatter per zone; constructing Intl.DateTimeFormat is relatively expensive.
// hourCycle h23 avoids "24" at midnight, which hour12:false can produce.
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
};

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Wall-clock fields of `at` in the given zone.
const wallClock = (timeZone: string, at: Date): Fields => {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
};

const fieldsToUtcMs = (f: Fields): number => Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);

const pad = (n: number): string => String(n).padStart(2, "0");

const formatFields = (f: Fields): string =>
  `${f.year}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`;

/** UTC offset of the zone at `at`, in minutes east of UTC (Asia/Dhaka -> 360). */
export function offsetMinutes(timeZone: string, at: Date = new Date()): number {
  // Wall clock has whole seconds, so compare against `at` truncated to the second.
  const instant = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((fieldsToUtcMs(wallClock(timeZone, at)) - instant) / 60000);
}

/** 360 -> "+0600", -210 -> "-0330", 0 -> "+0000" (moment's "ZZ"). */
export function formatOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Device local "YYYY-MM-DD HH:mm:ss" in `timeZone` -> ISO 8601 UTC without milliseconds. */
export function localToUtcIso(local: string, timeZone: string): string {
  const m = LOCAL.exec(local);
  if (!m) throw new HttpError(400, `Invalid local time "${local}", expected YYYY-MM-DD HH:mm:ss`);
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls over out-of-range fields (Feb 30 -> Mar 2); reject those.
  if (formatFields(utcFields(wall)) !== local) throw new HttpError(400, `Invalid local time "${local}"`);
  if (!isValidTimeZone(timeZone)) throw new HttpError(400, `Invalid timezone "${timeZone}"`);
  // Two passes settle the offset across DST changes. In a gap or overlap the result is
  // deterministic (the offset in force at the first guess), never an error.
  const first = wall - offsetMinutes(timeZone, new Date(wall)) * 60000;
  const utc = wall - offsetMinutes(timeZone, new Date(first)) * 60000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const utcFields = (ms: number): Fields => {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
};

/** Current (or `at`) wall-clock time in the zone as "YYYY-MM-DD HH:mm:ss". */
export function nowLocal(timeZone: string, at: Date = new Date()): string {
  return formatFields(wallClock(timeZone, at));
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}
