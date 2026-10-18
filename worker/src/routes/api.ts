// Tenant API used by POS installs: docs/pos-integration.md §3.
// Every lookup is scoped to the calling tenant; another tenant's device is a 404.
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Command, Device, DeviceUser, Env, Tenant } from "../types";
import { HttpError } from "../types";
import { hashApiKey } from "../lib/crypto";
import { getTenantByApiKeyHash } from "../db/tenants";
import { claimDevice, getDevice, listDevices, releaseDevice, updateDevice } from "../db/devices";
import { listDeviceUsers } from "../db/users";
import { getCommand } from "../db/commands";
import { queryPunches, requeuePunches } from "../db/punches";
import { scheduleDelivery, toPunchPayload } from "../delivery";
import { isActionName, privilegeLabel, putUser, removeUser, runAction } from "../services/actions";
import {
  DEVICE_PIN_PATTERN,
  branchIdSchema,
  dateSchema,
  parseJson,
  parseQuery,
  parseWith,
  snSchema,
} from "../lib/validate";

type ApiEnv = { Bindings: Env; Variables: { tenant: Tenant } };
type ApiContext = Context<ApiEnv>;

const ONLINE_WINDOW_MS = 120 * 1000;
const API_KEY_PATTERN = /^adms_[A-Za-z0-9_-]{43}$/;

export const apiRoutes = new Hono<ApiEnv>();

apiRoutes.use(
  "*",
  bodyLimit({ maxSize: 100 * 1024, onError: (c) => c.json({ error: "Request body too large (max 100 kB)" }, 413) })
);

apiRoutes.use("*", async (c, next) => {
  const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  const key = match?.[1];
  // Format check first so junk never costs a DB query.
  const tenant = key && API_KEY_PATTERN.test(key) ? await getTenantByApiKeyHash(c.env.DB, await hashApiKey(key)) : null;
  if (!tenant) return c.json({ error: "Invalid or missing API key" }, 401);
  c.set("tenant", tenant);
  await next();
});

// --- presenters ---

const isOnline = (lastSeen: string | null): boolean => {
  const time = Date.parse(lastSeen ?? "");
  return !Number.isNaN(time) && Date.now() - time <= ONLINE_WINDOW_MS;
};

const presentDevice = (d: Device) => ({
  sn: d.sn,
  name: d.name,
  branchId: d.branchId,
  deviceType: d.deviceType,
  online: isOnline(d.lastSeen),
  lastSeen: d.lastSeen,
  firmware: d.firmware,
  userCount: d.userCount,
});

// Command text is left out on purpose: it can carry user passwords.
const presentCommand = (cmd: Command) => ({
  id: cmd.id,
  deviceSN: cmd.sn,
  kind: cmd.kind,
  status: cmd.status,
  returnCode: cmd.returnCode,
  result: cmd.result,
  createdAt: cmd.createdAt,
  completedAt: cmd.completedAt,
});

// Same wording as the device-users webhook (§2.2).
const presentUser = (u: DeviceUser) => ({
  devicePin: u.pin,
  name: u.name,
  cardNo: u.cardNo,
  privilege: privilegeLabel(u.privilege),
  updatedAt: u.updatedAt,
});

const queued = (c: ApiContext, list: Command[]) => c.json({ commands: list.map(presentCommand) }, 202);

// --- lookups ---

async function tenantDevice(c: ApiContext): Promise<Device> {
  const sn = c.req.param("sn") ?? "";
  const device = sn.length <= 64 ? await getDevice(c.env.DB, sn) : null;
  if (!device || device.tenantId !== c.get("tenant").id) throw new HttpError(404, "Device not found");
  return device;
}

async function branchDevices(c: ApiContext): Promise<Device[]> {
  const branchId = parseWith(branchIdSchema, c.req.param("branchId"));
  const devices = await listDevices(c.env.DB, { tenantId: c.get("tenant").id, branchId, status: "approved" });
  if (devices.length === 0) throw new HttpError(404, "No devices in this branch");
  return devices;
}

function deliverSoon(c: ApiContext, tenantId: string | null): void {
  try {
    // Hono's ExecutionContext type lags workers-types; same object at runtime.
    scheduleDelivery(c.env, c.executionCtx as unknown as ExecutionContext, tenantId);
  } catch {
    // No execution context (e.g. tests); the cron delivers them.
  }
}

// --- schemas ---

const nameSchema = z.string().trim().max(64);

const claimSchema = z.object({
  sn: snSchema,
  name: nameSchema.nullish(),
  branchId: branchIdSchema.nullable(),
});

const patchSchema = z.object({
  name: nameSchema.nullable().optional(),
  branchId: branchIdSchema.nullable().optional(),
});

const userSchema = z.object({
  name: z.string().trim().min(1, "required").max(24),
  cardNo: z.string().trim().regex(/^\d{0,20}$/, "use up to 20 digits").optional(),
  privilege: z.enum(["user", "admin"]).optional(),
  password: z.string().max(8).optional(),
});

const actionSchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  seconds: z.number().int().min(1).max(60).optional(),
});

const attendanceQuery = z.object({
  deviceSN: snSchema.optional(),
  devicePin: z.string().trim().regex(DEVICE_PIN_PATTERN, "invalid PIN").optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const redeliverSchema = z.object({
  from: dateSchema,
  to: dateSchema,
  deviceSN: snSchema.optional(),
});

// --- devices ---

apiRoutes.get("/devices", async (c) => {
  const devices = await listDevices(c.env.DB, { tenantId: c.get("tenant").id });
  return c.json(devices.map(presentDevice));
});

apiRoutes.post("/devices", async (c) => {
  const body = await parseJson(c, claimSchema);
  const result = await claimDevice(c.env.DB, body.sn, c.get("tenant").id, {
    name: body.name || null,
    branchId: body.branchId,
  });
  if (result === "conflict") throw new HttpError(409, "Device belongs to another tenant");
  // Held punches were just released to this tenant: send them now, not on the next cron.
  deliverSoon(c, result.tenantId);
  return c.json(presentDevice(result), 201);
});

apiRoutes.patch("/devices/:sn", async (c) => {
  const device = await tenantDevice(c);
  const body = await parseJson(c, patchSchema);
  const patch: { name?: string | null; branchId?: number | null } = {};
  if (body.name !== undefined) patch.name = body.name || null;
  if (body.branchId !== undefined) patch.branchId = body.branchId;
  if (Object.keys(patch).length === 0) return c.json(presentDevice(device));
  const updated = await updateDevice(c.env.DB, device.sn, patch, c.get("tenant").id);
  if (!updated) throw new HttpError(404, "Device not found");
  return c.json(presentDevice(updated));
});

apiRoutes.delete("/devices/:sn", async (c) => {
  const device = await tenantDevice(c);
  if (!(await releaseDevice(c.env.DB, device.sn, c.get("tenant").id))) throw new HttpError(404, "Device not found");
  return c.body(null, 204);
});

// --- users on devices ---

apiRoutes.get("/devices/:sn/users", async (c) => {
  const device = await tenantDevice(c);
  const users = await listDeviceUsers(c.env.DB, device.sn);
  return c.json(users.map(presentUser));
});

apiRoutes.put("/devices/:sn/users/:pin", async (c) => {
  const device = await tenantDevice(c);
  const body = await parseJson(c, userSchema);
  return queued(c, await putUser(c.env, device, c.req.param("pin"), body));
});

apiRoutes.delete("/devices/:sn/users/:pin", async (c) => {
  const device = await tenantDevice(c);
  return queued(c, await removeUser(c.env, device, c.req.param("pin")));
});

apiRoutes.put("/branches/:branchId/users/:pin", async (c) => {
  const body = await parseJson(c, userSchema);
  const devices = await branchDevices(c);
  const list: Command[] = [];
  for (const device of devices) list.push(...(await putUser(c.env, device, c.req.param("pin"), body)));
  return queued(c, list);
});

apiRoutes.delete("/branches/:branchId/users/:pin", async (c) => {
  const devices = await branchDevices(c);
  const list: Command[] = [];
  for (const device of devices) list.push(...(await removeUser(c.env, device, c.req.param("pin"))));
  return queued(c, list);
});

// --- actions and commands ---

apiRoutes.post("/devices/:sn/actions/:action", async (c) => {
  const action = c.req.param("action");
  if (!isActionName(action)) throw new HttpError(404, `Unknown action: ${action}`);
  const device = await tenantDevice(c);
  const body = await parseJson(c, actionSchema);
  return queued(c, await runAction(c.env, device, action, body));
});

apiRoutes.get("/commands/:id", async (c) => {
  const id = parseWith(z.coerce.number().int().positive(), c.req.param("id"));
  const cmd = await getCommand(c.env.DB, id, c.get("tenant").id);
  if (!cmd) throw new HttpError(404, "Command not found");
  return c.json(presentCommand(cmd));
});

// --- attendance ---

apiRoutes.get("/attendance", async (c) => {
  const q = parseQuery(c, attendanceQuery);
  const { punches, nextCursor } = await queryPunches(c.env.DB, {
    tenantId: c.get("tenant").id,
    sn: q.deviceSN,
    pin: q.devicePin,
    from: q.from,
    to: q.to,
    cursor: q.cursor,
    limit: q.limit,
  });
  return c.json({ punches: punches.map(toPunchPayload), nextCursor });
});

apiRoutes.post("/attendance/redeliver", async (c) => {
  const body = await parseJson(c, redeliverSchema);
  if (body.from.slice(0, 10) > body.to.slice(0, 10)) throw new HttpError(400, "'from' must not be after 'to'");
  const tenantId = c.get("tenant").id;
  const count = await requeuePunches(c.env.DB, { tenantId, from: body.from, to: body.to, sn: body.deviceSN });
  // Send now rather than waiting for the next cron sweep.
  if (count > 0) deliverSoon(c, tenantId);
  return c.json({ queued: count });
});

apiRoutes.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
  console.error("Tenant API error:", error);
  return c.json({ error: "Internal error" }, 500);
});
