import type { Context } from "hono";
import type { AppEnv, Device, DeviceUser, NewPunch, ParsedPunch, ParsedUser, PunchSource, Tenant } from "../types";
import { getDevice } from "../db/devices";
import { getTenant } from "../db/tenants";
import { enqueueWebhook } from "../db/outbox";
import { deliverWebhooks } from "../delivery";
import { localToUtcIso } from "../lib/time";
import { privilegeLabel } from "../services/actions";

type Ctx = Context<AppEnv>;

// Serial numbers accepted from devices (same as the Express SN_PATTERN).
export const SN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Devices send each query parameter once; Hono's query() already returns the first value.
export const query = (c: Ctx, key: string): string => c.req.query(key) ?? "";

// Endpoints and tables only Security PUSH (access-control) devices use. The handshake that
// carries DeviceType=acc only happens at boot, so this fills the type in for running devices.
const ACC_PATHS = ["/iclock/registry", "/iclock/push", "/iclock/ping", "/iclock/rtdata", "/iclock/querydata"];
const ACC_TABLES = ["rtlog", "rtstate"];
export function inferDeviceType(c: Ctx): string | null {
  const type = query(c, "DeviceType");
  if (type) return type;
  if (ACC_PATHS.includes(c.req.path) || ACC_TABLES.includes(query(c, "table").toLowerCase())) return "acc";
  return null;
}

export const allowedSerials = (c: Ctx): string[] =>
  (c.env.ALLOWED_SERIALS || "").split(",").map((s) => s.trim()).filter(Boolean);

// c.executionCtx throws outside a real Worker (e.g. some tests); fall back to letting the promise run.
export function executionCtx(c: Ctx): ExecutionContext | null {
  try {
    // Hono's own ExecutionContext type lags workers-types; at runtime it is the Worker's ctx.
    return c.executionCtx as unknown as ExecutionContext;
  } catch {
    return null;
  }
}

// Device bookkeeping must never break the device conversation.
export function background(c: Ctx, promise: Promise<unknown>, what: string): void {
  const tracked = promise.catch((error) => console.error(`Error ${what}:`, errorMessage(error)));
  executionCtx(c)?.waitUntil(tracked);
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Hide user passwords in logged bodies and commands.
export const redactBody = (body: string): string => body.replace(/((?:password|passwd)=)[^\t\r\n&]*/gi, "$1***");

// One getDevice per request, shared by the admission middleware and the handlers.
const deviceCache = new WeakMap<Request, Promise<Device | null>>();
export function loadDevice(c: Ctx, sn: string): Promise<Device | null> {
  const cached = deviceCache.get(c.req.raw);
  if (cached) return cached;
  const device: Promise<Device | null> = getDevice(c.env.DB, sn);
  deviceCache.set(c.req.raw, device);
  return device;
}

export interface DeviceContext {
  sn: string;
  device: Device | null;
  tenant: Tenant | null;
  timezone: string;
}

// The device, its tenant (enabled or not) and the timezone to use for it. Throws on DB error.
export async function loadDeviceContext(c: Ctx, sn: string): Promise<DeviceContext> {
  const device = sn ? await loadDevice(c, sn) : null;
  const tenant = device?.tenantId ? await getTenant(c.env.DB, device.tenantId) : null;
  return { sn, device, tenant, timezone: tenant?.timezone || c.env.DEFAULT_TIMEZONE };
}

// Config responses must not fail on a DB hiccup; use the default timezone instead.
export async function timezoneFor(c: Ctx, sn: string): Promise<string> {
  try {
    return (await loadDeviceContext(c, sn)).timezone;
  } catch (error) {
    console.error("Error loading device timezone:", errorMessage(error));
    return c.env.DEFAULT_TIMEZONE;
  }
}

// Attaches tenant/branch/timezone; a punch whose local time can't be converted is skipped.
export function toNewPunches(
  parsed: ParsedPunch[],
  ctx: DeviceContext,
  sourceOf: (punchedAtUtc: string) => PunchSource
): NewPunch[] {
  const punches: NewPunch[] = [];
  for (const p of parsed) {
    let punchedAtUtc: string;
    try {
      punchedAtUtc = localToUtcIso(p.punchedAt, ctx.timezone);
    } catch {
      console.warn("Skipping punch with unparseable time:", { SN: ctx.sn, pin: p.pin, punchedAt: p.punchedAt });
      continue;
    }
    punches.push({
      ...p,
      sn: ctx.sn,
      tenantId: ctx.device?.tenantId ?? null,
      branchId: ctx.device?.branchId ?? null,
      timezone: ctx.timezone,
      punchedAtUtc,
      source: sourceOf(punchedAtUtc),
    });
  }
  return punches;
}

// While a fetch-attendance query is active, att devices answer with ordinary ATTLOG uploads:
// only punches within this window of now count as live.
const LIVE_WINDOW_MS = 10 * 60 * 1000;
export const isRecent = (punchedAtUtc: string, now = Date.now()): boolean =>
  Math.abs(now - Date.parse(punchedAtUtc)) <= LIVE_WINDOW_MS;

const webhookUser = (u: ParsedUser | DeviceUser) => ({
  devicePin: u.pin,
  name: u.name,
  cardNo: u.cardNo,
  privilege: privilegeLabel(u.privilege),
});

// Queues a device-users webhook (docs/pos-integration.md §2.2); no-op for a device without tenant.
export async function enqueueDeviceUsers(
  c: Ctx,
  ctx: DeviceContext,
  users: (ParsedUser | DeviceUser)[],
  complete: boolean
): Promise<void> {
  const tenantId = ctx.device?.tenantId;
  if (!tenantId) return;
  await enqueueWebhook(c.env.DB, tenantId, "device-users", {
    deviceSN: ctx.sn,
    branchId: ctx.device?.branchId ?? null,
    complete,
    users: users.map(webhookUser),
  });
  background(c, deliverWebhooks(c.env), "delivering webhooks");
}
