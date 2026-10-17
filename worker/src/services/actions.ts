// Device actions and user changes, shared by the tenant API and the admin API.
// Callers may pass raw request bodies, so every value is validated here.
import type { Command, Device, Env } from "../types";
import { HttpError } from "../types";
import * as commands from "../protocol/commands";
import { queueCommands } from "../db/commands";
import { upsertDeviceUsers, deleteDeviceUser } from "../db/users";
import { DATE_PATTERN, DEVICE_PIN_PATTERN } from "../lib/validate";

export type ActionName = "fetch-users" | "fetch-attendance" | "sync-time" | "open-door" | "reboot";

export const PIN_PATTERN = /^\d{1,24}$/;

const ACTIONS: readonly ActionName[] = ["fetch-users", "fetch-attendance", "sync-time", "open-door", "reboot"];
const DEFAULT_DOOR_SECONDS = 5;

export function isActionName(value: string): value is ActionName {
  return (ACTIONS as readonly string[]).includes(value);
}

// The wire format is tab/newline separated, so those can't live inside a value (the
// builders strip them too; doing it here keeps the stored user row identical).
const clean = (value: unknown): string => String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") throw new HttpError(400, `Invalid ${field}`);
  const result = clean(value);
  if (result.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return result;
}

function date(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new HttpError(400, `Invalid ${field}: use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`);
  }
  return value;
}

// docs/pos-integration.md allows 1-60 s, tighter than the builder's 254.
function doorSeconds(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_DOOR_SECONDS;
  const seconds = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
    throw new HttpError(400, "seconds must be a whole number between 1 and 60");
  }
  return seconds;
}

// Device privilege level as the POS sees it (§2.2, §3): 0 is a normal user, any elevated
// level (enroller, admin, super admin) counts as admin. One rule for webhook and API.
export const privilegeLabel = (level: number): "user" | "admin" => (level === 0 ? "user" : "admin");

function privilegeOf(value: unknown): number {
  if (value === undefined || value === null || value === "" || value === "user") return 0;
  if (value === "admin") return 14;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 14) return value;
  throw new HttpError(400, 'privilege must be "user", "admin" or an integer 0-14');
}

function checkPin(pin: unknown, pattern: RegExp): string {
  const value = typeof pin === "string" || typeof pin === "number" ? String(pin).trim() : "";
  if (!pattern.test(value)) {
    throw new HttpError(400, pattern === PIN_PATTERN ? "Invalid pin: use 1-24 digits" : "Invalid pin");
  }
  return value;
}

function buildAction(device: Device, action: ActionName, body: { from?: unknown; to?: unknown; seconds?: unknown }): string[] {
  switch (action) {
    case "fetch-users":
      return commands.queryUsers(device.deviceType);
    case "fetch-attendance": {
      const from = date(body.from, "from");
      const to = date(body.to, "to");
      // The builders require both; say so clearly instead of passing undefined through.
      if (!from || !to) throw new HttpError(400, "'from' and 'to' are required (YYYY-MM-DD)");
      return commands.queryAttendance(device.deviceType, { from, to });
    }
    case "sync-time":
      return commands.syncTime(device.deviceType, new Date());
    case "open-door":
      return commands.openDoor(device.deviceType, doorSeconds(body.seconds));
    case "reboot":
      return commands.reboot(device.deviceType);
  }
}

export async function runAction(
  env: Env,
  device: Device,
  action: ActionName,
  body: { from?: string; to?: string; seconds?: number }
): Promise<Command[]> {
  if (!isActionName(action)) throw new HttpError(400, `Unknown action: ${String(action)}`);
  const list = buildAction(device, action, body ?? {});
  return queueCommands(env.DB, device.sn, device.tenantId, action, list);
}

export async function putUser(
  env: Env,
  device: Device,
  pin: string,
  u: { name: string; cardNo?: string; privilege?: "user" | "admin" | number; password?: string }
): Promise<Command[]> {
  const body = (u ?? {}) as Record<string, unknown>;
  const user = {
    pin: checkPin(pin, PIN_PATTERN),
    name: text(body.name, "name", 24),
    cardNo: text(body.cardNo, "cardNo", 20),
    privilege: privilegeOf(body.privilege),
    password: text(body.password, "password", 8),
  };
  if (!user.name) throw new HttpError(400, "Missing name");
  if (user.cardNo && !/^\d+$/.test(user.cardNo)) throw new HttpError(400, "cardNo must be digits");

  const list = commands.addUser(device.deviceType, user);
  const queued = await queueCommands(env.DB, device.sn, device.tenantId, "add-user", list);
  // Optimistic: the device confirms later via fetch-users / OPERLOG. Password is never stored.
  await upsertDeviceUsers(env.DB, device.sn, [
    { pin: user.pin, name: user.name, cardNo: user.cardNo, privilege: user.privilege },
  ]);
  return queued;
}

export async function removeUser(env: Env, device: Device, pin: string): Promise<Command[]> {
  // Device-reported PINs may be non-numeric; allow removing those too.
  const id = checkPin(pin, DEVICE_PIN_PATTERN);
  const list = commands.deleteUser(device.deviceType, id);
  const queued = await queueCommands(env.DB, device.sn, device.tenantId, "delete-user", list);
  await deleteDeviceUser(env.DB, device.sn, id);
  return queued;
}
