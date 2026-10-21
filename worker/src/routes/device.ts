import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv, NewPunch, ParsedPunch } from "../types";
import { isAdmitted, recordSeen } from "../db/devices";
import { pruneDeviceUsers, listDeviceUsers, upsertDeviceUsers } from "../db/users";
import {
  completeCommand,
  getCommand,
  getSentQueryStart,
  isAttendanceQueryActive,
  recordQueryPacket,
  takeNextCommand,
} from "../db/commands";
import { insertPunches } from "../db/punches";
import { scheduleDelivery } from "../delivery";
import {
  encodeDeviceSeconds,
  getAccConfig,
  getConfig,
  getDeviceTime,
  getRegistryCode,
  parseAttendanceLog,
  parseKeyValues,
  parseRealtimeLog,
  parseTransactionLines,
  parseUserLines,
  toLines,
} from "../protocol/format";
import { redact } from "../protocol/commands";
import { formatOffset, offsetMinutes } from "../lib/time";
import {
  SN_PATTERN,
  allowedSerials,
  background,
  enqueueDeviceUsers,
  errorMessage,
  executionCtx,
  inferDeviceType,
  isRecent,
  loadDevice,
  loadDeviceContext,
  query,
  redactBody,
  timezoneFor,
  toNewPunches,
  type DeviceContext,
} from "./deviceHelpers";

type Ctx = Context<AppEnv>;

export const deviceRoutes = new Hono<AppEnv>();

const offsetHours = (timeZone: string) => offsetMinutes(timeZone) / 60;
const requestDelay = (c: Ctx) => parseInt(c.env.REQUEST_DELAY, 10) || 15;
const plain = (c: Ctx, withDate = false) => {
  c.header("Content-Type", "text/plain");
  if (withDate) c.header("Date", new Date().toUTCString());
};

// A device is accepted when its SN is allowlisted (ALLOWED_SERIALS) or approved (claimed or
// assigned). Requests with a valid SN are recorded, so rejected devices show up as pending;
// only admitted ones update the stored details.
deviceRoutes.use("/iclock/*", async (c, next) => {
  const sn = query(c, "SN");
  const userAgent = c.req.header("User-Agent") || "";
  let admitted = false;
  try {
    admitted = !!sn && (await isAdmitted(c.env.DB, sn, allowedSerials(c)));
  } catch (error) {
    console.error("Error checking device approval:", errorMessage(error));
  }
  if (SN_PATTERN.test(sn)) background(c, recordRequest(c, sn, userAgent, admitted), "recording device");
  if (admitted) return next();
  console.warn("Rejected device request:", { path: c.req.path, SN: sn, userAgent });
  return c.json({ message: "Authentication failed." }, 200);
});

async function recordRequest(c: Ctx, sn: string, userAgent: string, admitted: boolean): Promise<void> {
  const device = await loadDevice(c, sn);
  // Unknown or unadmitted: never overwrite what an admitted device reported, just bump last_seen.
  if (!admitted && device) return recordSeen(c.env.DB, { sn });
  await recordSeen(c.env.DB, {
    sn,
    ip: c.req.header("CF-Connecting-IP") || null,
    userAgent: userAgent || null,
    // The query-string type is easy to fake: only fill it in when unknown (registry data replaces it).
    deviceType: device?.deviceType ? null : inferDeviceType(c),
    pushVersion: query(c, "pushver") || null,
  });
}

// Registry and table=OPTIONS bodies describe the device (comma-separated key=value).
function recordDeviceInfo(c: Ctx, sn: string, body: string): void {
  const info = parseKeyValues(body);
  if (!sn || !Object.keys(info).length) return;
  const firmware = info.FirmVer || info.FWVersion || null;
  background(c, recordSeen(c.env.DB, { sn, deviceType: info.DeviceType || null, firmware, info }), "recording device info");
}

deviceRoutes.get("/iclock/cdata", async (c) => {
  const sn = query(c, "SN");
  if (!sn) return c.json({ message: "Missing required parameter: SN" }, 400);
  const timeZone = await timezoneFor(c, sn);
  // As in Express: only the query decides. The stored type may be inferred (e.g. from ping),
  // and a legacy device given the Security PUSH block would stop uploading ATTLOG.
  const body =
    query(c, "DeviceType") === "acc"
      ? await getAccConfig(sn, offsetHours(timeZone), requestDelay(c))
      : getConfig(sn, offsetHours(timeZone));
  plain(c, true);
  return c.body(body);
});

// Delivers queued commands as "C:<id>:<command>" lines; "OK" when there are none.
// One command per poll, as the reference implementations do.
deviceRoutes.get("/iclock/getrequest", async (c) => {
  const sn = query(c, "SN");
  plain(c, true);
  let command = null;
  try {
    if (sn) command = await takeNextCommand(c.env.DB, sn);
  } catch (error) {
    console.error("Error loading device commands:", errorMessage(error));
  }
  if (!command) return c.body("OK");
  // The time is taken now, not when queued: commands can wait minutes behind a DATA QUERY.
  if (command.kind === "sync-time") {
    command.command = command.command.replace(/DateTime=\d+/, `DateTime=${encodeDeviceSeconds(new Date())}`);
  }
  console.log({ SN: sn, commands: [`C:${command.id}:${redact(command.command)}`] });
  return c.body(`C:${command.id}:${command.command}\n`);
});

deviceRoutes.post("/iclock/registry", async (c) => {
  const sn = query(c, "SN");
  recordDeviceInfo(c, sn, await c.req.text());
  plain(c);
  return c.body(`RegistryCode=${await getRegistryCode(sn)}`);
});

deviceRoutes.all("/iclock/push", async (c) => {
  const sn = query(c, "SN");
  const body = await getAccConfig(sn, offsetHours(await timezoneFor(c, sn)), requestDelay(c));
  plain(c);
  return c.body(body);
});

deviceRoutes.get("/iclock/ping", (c) => {
  plain(c);
  return c.body("OK");
});

deviceRoutes.get("/iclock/rtdata", async (c) => {
  plain(c);
  if (query(c, "type") !== "time") return c.body("OK");
  const timeZone = await timezoneFor(c, query(c, "SN"));
  return c.body(getDeviceTime(new Date(), formatOffset(offsetMinutes(timeZone))));
});

// Stores punches before the device is acked; returns how many were new. Throws on DB error.
async function storePunches(c: Ctx, ctx: DeviceContext, punches: NewPunch[]): Promise<number> {
  if (!punches.length) return 0;
  const { inserted } = await insertPunches(c.env.DB, punches);
  const execCtx = executionCtx(c);
  if (inserted && execCtx) scheduleDelivery(c.env, execCtx, ctx.device?.tenantId ?? null);
  return inserted;
}

// The source rule for each upload type, in one place.
async function toPunchList(
  c: Ctx,
  ctx: DeviceContext,
  parsed: ParsedPunch[],
  kind: "attlog" | "rtlog" | "transaction"
): Promise<NewPunch[]> {
  if (kind === "transaction") return toNewPunches(parsed, ctx, () => "history");
  if (kind === "rtlog") return toNewPunches(parsed, ctx, () => "live");
  let queryActive = false;
  try {
    queryActive = await isAttendanceQueryActive(c.env.DB, ctx.sn);
  } catch (error) {
    console.error("Error checking attendance queries:", errorMessage(error));
  }
  const now = Date.now();
  return toNewPunches(parsed, ctx, (utc) => (queryActive && !isRecent(utc, now) ? "history" : "live"));
}

// Users enrolled or edited on the device itself: a partial update for the POS.
async function storeUploadedUsers(c: Ctx, sn: string, body: string): Promise<void> {
  const users = parseUserLines(body);
  if (!sn || !users.length) return;
  await upsertDeviceUsers(c.env.DB, sn, users);
  await enqueueDeviceUsers(c, await loadDeviceContext(c, sn), users, false);
}

deviceRoutes.post("/iclock/cdata", async (c) => {
  const sn = query(c, "SN");
  const tablename = query(c, "tablename");
  const table = (query(c, "table") || "ATTLOG").toUpperCase();
  const body = await c.req.text();
  plain(c, true);

  // Attendance devices send ATTLOG; access-control devices (SenseFace 2A) send rtlog.
  // Everything else (OPTIONS, OPERLOG, USER, BIODATA, tabledata, rtstate, ...) is
  // acknowledged so it isn't re-sent; only device info and users are kept.
  if (table !== "ATTLOG" && table !== "RTLOG") {
    console.log({ SN: sn, table, tablename, body: redactBody(body) });
    if (table === "OPTIONS") recordDeviceInfo(c, sn, body);
    const isUserTable = table === "TABLEDATA" && tablename.toLowerCase() === "user";
    try {
      if (isUserTable || table === "OPERLOG" || table === "USERINFO") await storeUploadedUsers(c, sn, body);
    } catch (error) {
      console.error("Error saving device users:", errorMessage(error));
      return c.body("FAIL");
    }
    if (table === "TABLEDATA") return c.body(`${tablename}=${toLines(body).length}`);
    return c.body("OK");
  }

  if (table === "RTLOG") console.log({ SN: sn, table, body });
  const parsed = table === "RTLOG" ? parseRealtimeLog(body) : parseAttendanceLog(body);
  try {
    if (parsed.length) {
      const ctx = await loadDeviceContext(c, sn);
      await storePunches(c, ctx, await toPunchList(c, ctx, parsed, table === "RTLOG" ? "rtlog" : "attlog"));
    }
    return c.body(table === "RTLOG" ? "OK" : `OK:${parsed.length}`);
  } catch (error) {
    console.error("Error inserting attendance:", errorMessage(error));
    return c.body("FAIL");
  }
});

// Command results, one per line: ID=<id>&Return=<code>&CMD=<cmd> (Return < 0 = error).
// The spec mostly writes "return" in lowercase, so keys are matched case-insensitively.
deviceRoutes.post("/iclock/devicecmd", async (c) => {
  const sn = query(c, "SN");
  const body = await c.req.text();
  console.log({ SN: sn, devicecmd: redactBody(body) });
  for (const line of body.split("\n")) {
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(line.trim())) params[key.toLowerCase()] = value;
    const id = parseInt(params.id ?? "", 10);
    // A Return that is present but not a number still completes the command (as failed).
    if (!id || params.return === undefined || !sn) continue;
    try {
      await completeCommand(c.env.DB, sn, id, parseInt(params.return, 10));
    } catch (error) {
      console.error("Error completing device command:", errorMessage(error));
    }
  }
  plain(c);
  return c.body("OK");
});

// After the last packet of a fetch-users answer: drop local users the device no longer has
// and send the POS the full list.
async function finishUserQuery(c: Ctx, sn: string, cmdid: number): Promise<void> {
  const command = await getCommand(c.env.DB, cmdid);
  if (!command || command.sn !== sn || command.kind !== "fetch-users") return;
  const since = await getSentQueryStart(c.env.DB, sn, cmdid);
  if (since) await pruneDeviceUsers(c.env.DB, sn, since);
  const ctx = await loadDeviceContext(c, sn);
  if (ctx.device?.tenantId) await enqueueDeviceUsers(c, ctx, await listDeviceUsers(c.env.DB, sn), true);
}

type Summary = { label: string; count: number; inserted?: number };

// Answers to DATA QUERY commands, possibly split into packets (packidx of packcnt).
deviceRoutes.post("/iclock/querydata", async (c) => {
  const sn = query(c, "SN");
  const rawTablename = query(c, "tablename");
  const tablename = rawTablename.toLowerCase();
  const cmdid = parseInt(query(c, "cmdid"), 10) || 0;
  const packidx = parseInt(query(c, "packidx"), 10) || 1;
  const packcnt = parseInt(query(c, "packcnt"), 10) || 1;
  const body = await c.req.text();
  plain(c);
  console.log({ SN: sn, querydata: tablename, cmdid, count: c.req.query("count"), packidx, packcnt, body: redactBody(body) });

  let summary: Summary | null = null;
  try {
    if (tablename === "user") {
      const users = parseUserLines(body);
      if (sn && users.length) await upsertDeviceUsers(c.env.DB, sn, users);
      summary = { label: "users", count: users.length };
      if (cmdid && sn && packidx >= packcnt) await finishUserQuery(c, sn, cmdid);
    } else if (tablename === "transaction") {
      const parsed = parseTransactionLines(body);
      let inserted = 0;
      if (parsed.length) {
        const ctx = await loadDeviceContext(c, sn);
        inserted = await storePunches(c, ctx, await toPunchList(c, ctx, parsed, "transaction"));
      }
      summary = { label: "attendance records", count: parsed.length, inserted };
    }
  } catch (error) {
    console.error(`Error storing querydata ${tablename}:`, errorMessage(error));
    return c.body("FAIL");
  }

  // Awaited (not backgrounded) so packets accumulate in order.
  if (cmdid && sn && summary) {
    await recordQueryPacket(c.env.DB, sn, cmdid, { ...summary, packidx, packcnt }).catch((error: unknown) =>
      console.error("Error saving command result:", errorMessage(error))
    );
  }
  // Spec: "$(TableName)=$(count)" for the lines received (the references reply OK; both work).
  if (summary) return c.body(`${rawTablename}=${toLines(body).length}`);
  return c.body("OK");
});

// Anything else the firmware calls: log it so the device's traffic can be inspected, and
// acknowledge instead of returning a 404.
deviceRoutes.all("/iclock/*", async (c) => {
  console.warn("Unhandled device request:", {
    method: c.req.method,
    path: c.req.path,
    query: c.req.query(),
    userAgent: c.req.header("User-Agent"),
    body: redactBody(await c.req.text()),
  });
  plain(c);
  return c.body("OK");
});
