import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv, DeliveryStatus, Device, DeviceStatus, Punch, Tenant } from "../types";
import { HttpError } from "../types";
import { encryptSecret, generateApiKey, hashApiKey, timingSafeEqual } from "../lib/crypto";
import { isValidTimeZone } from "../lib/time";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { SESSION_COOKIE, SESSION_TTL_MS, clearLoginFailures, createSession, isLoginThrottled, recordLoginFailure, verifySession } from "../lib/session";
import { redact } from "../protocol/commands";
import { createTenant, deleteTenant, getTenant, listTenants, updateTenant } from "../db/tenants";
import { deleteDevice, getDevice, listDevices, updateDevice } from "../db/devices";
import { listDeviceUsers } from "../db/users";
import { listCommands } from "../db/commands";
import { deliveryCounts, queryPunches, requeuePunches } from "../db/punches";
import { listWebhooks, retryWebhook } from "../db/outbox";
import { scheduleDelivery, testPosConnection } from "../delivery";
import { DATE_PATTERN, DEVICE_PIN_PATTERN, SN_PATTERN } from "../lib/validate";
import { PIN_PATTERN, isActionName, putUser, removeUser, runAction } from "../services/actions";

const ADMIN_USER = "admin";
const ONLINE_WINDOW_MS = 120 * 1000;
const MAX_BODY_BYTES = 100 * 1024;
const DELIVERY_STATUSES = ["held", "pending", "delivered", "failed"] as const;
const DEVICE_STATUSES = ["pending", "approved", "disabled"] as const;
// CSV export pages through the cursor; D1 queries per invocation are limited, so cap the pages.
const CSV_PAGE = 500;
const CSV_MAX_PAGES = 20;
const IMPORT_MAX_ROWS = 500;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  // The SPA is external files only; no inline scripts or styles.
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

// ---------- auth ----------

const parseBasic = (header: string | undefined): { user: string; password: string } | null => {
  const match = /^Basic\s+(.+)$/i.exec(header || "");
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(match[1].trim()), (ch) => ch.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const index = decoded.indexOf(":");
  if (index === -1) return null;
  return { user: decoded.slice(0, index), password: decoded.slice(index + 1) };
};

const withSecurityHeaders = (c: Context<AppEnv>) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
};

// Admin auth: a signed session cookie set by the login page, or HTTP Basic for scripts and
// curl. No WWW-Authenticate header is sent, so browsers show the login page instead of a
// native password prompt. Disabled entirely when ADMIN_PASSWORD is unset.
const PUBLIC_PATHS = ["/admin/login", "/admin/login.js", "/admin/styles.css", "/api/admin/login", "/api/admin/logout"];

const hasValidBasic = (c: Context<AppEnv>, password: string) => {
  const credentials = parseBasic(c.req.header("Authorization"));
  if (!credentials) return false;
  // Compute both so a wrong user name takes as long as a wrong password.
  const userOk = timingSafeEqual(credentials.user, ADMIN_USER);
  const passwordOk = timingSafeEqual(credentials.password, password);
  return userOk && passwordOk;
};

export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const password = c.env.ADMIN_PASSWORD;
  if (!password) {
    withSecurityHeaders(c);
    return c.json({ error: "Admin UI disabled: set ADMIN_PASSWORD" }, 503);
  }
  const authed =
    PUBLIC_PATHS.includes(c.req.path) ||
    (await verifySession(password, getCookie(c, SESSION_COOKIE))) ||
    hasValidBasic(c, password);
  if (authed) {
    await next();
    // After next() so the headers also land on asset responses (Hono clones them).
    withSecurityHeaders(c);
    return;
  }
  withSecurityHeaders(c);
  if (!c.req.path.startsWith("/api/")) return c.redirect("/admin/login");
  return c.json({ error: "Authentication required" }, 401);
};

const clientIp = (c: Context<AppEnv>) => c.req.header("CF-Connecting-IP") || "local";

const sessionCookieOptions = (c: Context<AppEnv>) => ({
  path: "/",
  httpOnly: true,
  sameSite: "Strict" as const,
  secure: new URL(c.req.url).protocol === "https:",
});

// CSRF guard: browsers resend cached Basic credentials on cross-site form posts, so
// state-changing requests must be JSON (forms can't send it without a CORS preflight)
// and must not come from another origin.
const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const site = c.req.header("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site request refused");
  const origin = c.req.header("Origin");
  if (origin) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {}
    const allowed = [c.req.header("Host"), c.req.header("X-Forwarded-Host"), new URL(c.req.url).host].filter(Boolean);
    if (!host || !allowed.includes(host)) throw new HttpError(403, "Cross-origin request refused");
  }
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const type = (c.req.header("Content-Type") || "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "Content-Type must be application/json");
  }
  return next();
};

// ---------- input ----------

const readJson = async <T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> => {
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }
  return check(schema, data);
};

const check = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new HttpError(400, path ? `${path}: ${issue?.message}` : issue?.message || "Invalid input");
  }
  return parsed.data;
};

const text = (max: number) => z.string().trim().max(max, `Too long (max ${max})`);
const dateText = z.string().regex(DATE_PATTERN, "Use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss");
const timezone = z.string().refine(isValidTimeZone, "Unknown IANA timezone");
// Stored without a trailing slash; empty string clears it.
const posUrl = z
  .string()
  .trim()
  .max(500)
  .transform((value) => value.replace(/\/+$/, ""))
  .refine((value) => value === "" || /^https?:\/\/[^\s/]+/i.test(value), "Must be an http(s) URL")
  .transform((value) => value || null);
const branchId = z.number().int().min(0).max(2147483647).nullable();

const tenantCreateSchema = z.object({
  name: text(100).min(1, "Required"),
  posApiUrl: posUrl.nullish(),
  posKey: text(500).nullish(),
  timezone: timezone.optional(),
});

const tenantPatchSchema = z.object({
  name: text(100).min(1, "Required").optional(),
  posApiUrl: posUrl.nullable().optional(),
  posKey: text(500).nullable().optional(),
  timezone: timezone.optional(),
  enabled: z.boolean().optional(),
});

const devicePatchSchema = z.object({
  name: text(100).nullable().optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  tenantId: z.string().min(1).max(64).nullable().optional(),
  branchId: branchId.optional(),
});

const privilege = z.union([z.enum(["user", "admin"]), z.number().int().min(0).max(14)], {
  errorMap: () => ({ message: 'Use "user", "admin" or 0-14' }),
});
const userSchema = z.object({
  name: text(24).min(1, "Required"),
  cardNo: text(20).regex(/^\d*$/, "Digits only").optional(),
  privilege: privilege.optional(),
  password: z.string().max(8, "Too long (max 8)").optional(),
});

const actionSchema = z.object({
  from: dateText.optional(),
  to: dateText.optional(),
  seconds: z.number().int().min(1).max(60).optional(),
});

const attendanceSchema = z.object({
  tenantId: z.string().max(64).optional(),
  sn: z.string().regex(SN_PATTERN, "Invalid serial number").optional(),
  pin: z.string().regex(DEVICE_PIN_PATTERN, "Invalid pin").optional(),
  from: dateText.optional(),
  to: dateText.optional(),
  deliveryStatus: z.enum(DELIVERY_STATUSES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const retrySchema = z.object({
  tenantId: z.string().min(1).max(64),
  from: dateText,
  to: dateText,
  sn: z.string().regex(SN_PATTERN, "Invalid serial number").optional(),
  failedOnly: z.boolean().optional(),
});

// Query strings: drop empty values so "?sn=" means "no filter".
const queryOf = (c: Context<AppEnv>) =>
  Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ""));

const checkSnParam = (value: string) => {
  // Looked up as given (not SN_PATTERN) so odd rows recorded earlier can still be removed.
  if (!value || value.length > 200) throw new HttpError(400, "Invalid serial number");
  return value;
};

const intParam = (value: string | undefined, fallback: number, min: number, max: number) => {
  const number = parseInt(value || "", 10);
  if (Number.isNaN(number)) return fallback;
  return Math.min(Math.max(number, min), max);
};

// ---------- presenters ----------

// posKeyEnc never leaves the server; the UI only needs to know whether one is set.
const presentTenant = <T extends Tenant>(tenant: T) => {
  const { posKeyEnc, ...rest } = tenant;
  return { ...rest, hasPosKey: Boolean(posKeyEnc) };
};

const allowedSerials = (c: Context<AppEnv>) =>
  (c.env.ALLOWED_SERIALS || "")
    .split(",")
    .map((sn) => sn.trim())
    .filter(Boolean);

const isOnline = (lastSeen: string | null) => {
  const time = Date.parse(lastSeen || "");
  return !Number.isNaN(time) && Date.now() - time <= ONLINE_WINDOW_MS;
};

const presentDevice = (c: Context<AppEnv>, device: Device, withInfo = false) => {
  const { info, ...rest } = device;
  const access = device.status === "approved" ? "approved" : allowedSerials(c).includes(device.sn) ? "allowlist" : device.status;
  return { ...rest, access, online: isOnline(device.lastSeen), ...(withInfo ? { info } : {}) };
};

const redactCommands = <T extends { command: string }>(rows: T[]) => rows.map((row) => ({ ...row, command: redact(row.command) }));

const loadDevice = async (c: Context<AppEnv>) => {
  const device = await getDevice(c.env.DB, checkSnParam(c.req.param("sn") || ""));
  if (!device) throw new HttpError(404, "Device not found");
  return device;
};

const loadTenant = async (c: Context<AppEnv>, id: string | undefined) => {
  const tenant = id ? await getTenant(c.env.DB, id) : null;
  if (!tenant) throw new HttpError(404, "Tenant not found");
  return tenant;
};

const newApiKey = async () => {
  const apiKey = generateApiKey();
  return { apiKey, apiKeyHash: await hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, 12) };
};

// ---------- routes ----------

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", adminAuth);
adminRoutes.use("*", csrfGuard);

adminRoutes.get("/health", (c) => c.json({ ok: true }));

// Login page backend. Goes through the CSRF guard (JSON, same origin) like every mutation.
const loginSchema = z.object({ username: z.string().max(200), password: z.string().max(500) });

adminRoutes.post("/login", async (c) => {
  const ip = clientIp(c);
  if (isLoginThrottled(ip)) throw new HttpError(429, "Too many failed sign-in attempts. Try again in 15 minutes.");
  const { username, password } = await readJson(c, loginSchema);
  const expected = c.env.ADMIN_PASSWORD!;
  const userOk = timingSafeEqual(username, ADMIN_USER);
  const passwordOk = timingSafeEqual(password, expected);
  if (!userOk || !passwordOk) {
    recordLoginFailure(ip);
    throw new HttpError(401, "Wrong username or password");
  }
  clearLoginFailures(ip);
  setCookie(c, SESSION_COOKIE, await createSession(expected), {
    ...sessionCookieOptions(c),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return c.body(null, 204);
});

adminRoutes.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(c));
  return c.body(null, 204);
});

// Tenants

adminRoutes.get("/tenants", async (c) => {
  const tenants = await listTenants(c.env.DB);
  return c.json(tenants.map(presentTenant));
});

adminRoutes.post("/tenants", async (c) => {
  const body = await readJson(c, tenantCreateSchema);
  const key = await newApiKey();
  const tenant = await createTenant(c.env.DB, {
    name: body.name,
    posApiUrl: body.posApiUrl ?? null,
    posKeyEnc: body.posKey ? await encryptSecret(c.env, body.posKey) : null,
    apiKeyHash: key.apiKeyHash,
    apiKeyPrefix: key.apiKeyPrefix,
    timezone: body.timezone || c.env.DEFAULT_TIMEZONE,
  });
  // The plain key is only ever returned here and by rotate-key.
  return c.json({ tenant: presentTenant(tenant), apiKey: key.apiKey }, 201);
});

adminRoutes.get("/tenants/:id", async (c) => c.json(presentTenant(await loadTenant(c, c.req.param("id")))));

// posApiUrl / posKey: absent leaves as is, null or "" clears, a string sets.
adminRoutes.patch("/tenants/:id", async (c) => {
  const existing = await loadTenant(c, c.req.param("id"));
  const body = await readJson(c, tenantPatchSchema);
  const patch: Parameters<typeof updateTenant>[2] = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.posApiUrl !== undefined) patch.posApiUrl = body.posApiUrl;
  if (body.posKey !== undefined) patch.posKeyEnc = body.posKey ? await encryptSecret(c.env, body.posKey) : null;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  const tenant = await updateTenant(c.env.DB, existing.id, patch);
  if (!tenant) throw new HttpError(404, "Tenant not found");
  return c.json(presentTenant(tenant));
});

adminRoutes.delete("/tenants/:id", async (c) => {
  const tenant = await loadTenant(c, c.req.param("id"));
  await deleteTenant(c.env.DB, tenant.id);
  return c.body(null, 204);
});

adminRoutes.post("/tenants/:id/rotate-key", async (c) => {
  const tenant = await loadTenant(c, c.req.param("id"));
  const key = await newApiKey();
  const updated = await updateTenant(c.env.DB, tenant.id, { apiKeyHash: key.apiKeyHash, apiKeyPrefix: key.apiKeyPrefix });
  if (!updated) throw new HttpError(404, "Tenant not found");
  return c.json({ apiKey: key.apiKey, tenant: presentTenant(updated) });
});

adminRoutes.post("/tenants/:id/test", async (c) => {
  const tenant = await loadTenant(c, c.req.param("id"));
  return c.json(await testPosConnection(c.env, tenant));
});

// Devices

// tenantId=none lists unassigned devices only.
adminRoutes.get("/devices", async (c) => {
  const q = queryOf(c);
  const filter: Parameters<typeof listDevices>[1] = {};
  if (q.status) filter.status = check(z.enum(DEVICE_STATUSES), q.status) as DeviceStatus;
  if (q.tenantId) filter.tenantId = q.tenantId === "none" ? null : q.tenantId;
  const devices = await listDevices(c.env.DB, filter);
  return c.json(devices.map((device) => presentDevice(c, device)));
});

adminRoutes.get("/devices/:sn", async (c) => c.json(presentDevice(c, await loadDevice(c), true)));

adminRoutes.patch("/devices/:sn", async (c) => {
  const device = await loadDevice(c);
  const body = await readJson(c, devicePatchSchema);
  const patch: Parameters<typeof updateDevice>[2] = {};
  if (body.name !== undefined) patch.name = body.name || null;
  if (body.branchId !== undefined) patch.branchId = body.branchId;
  if (body.status !== undefined) patch.status = body.status;
  if (body.tenantId !== undefined) {
    if (body.tenantId !== null) {
      await loadTenant(c, body.tenantId);
      // Assigning a device admits it, as claiming does in the tenant API.
      if (body.status === undefined) patch.status = "approved";
    }
    // A branch id belongs to the tenant: a new (or no) tenant starts without one.
    if (body.tenantId !== device.tenantId && body.branchId === undefined) patch.branchId = null;
    patch.tenantId = body.tenantId;
  }
  const updated = await updateDevice(c.env.DB, device.sn, patch);
  if (!updated) throw new HttpError(404, "Device not found");
  // Assigning releases held punches: deliver them now rather than on the next cron.
  if (patch.tenantId) scheduleDelivery(c.env, c.executionCtx as unknown as ExecutionContext, patch.tenantId);
  return c.json(presentDevice(c, updated, true));
});

adminRoutes.delete("/devices/:sn", async (c) => {
  const device = await loadDevice(c);
  await deleteDevice(c.env.DB, device.sn);
  return c.body(null, 204);
});

// Users on a device

adminRoutes.get("/devices/:sn/users", async (c) => {
  const device = await loadDevice(c);
  return c.json(await listDeviceUsers(c.env.DB, device.sn));
});

adminRoutes.put("/devices/:sn/users/:pin", async (c) => {
  const device = await loadDevice(c);
  const pin = c.req.param("pin");
  if (!PIN_PATTERN.test(pin)) throw new HttpError(400, "Invalid pin: use 1-24 digits");
  const body = await readJson(c, userSchema);
  const commands = await putUser(c.env, device, pin, { ...body, password: body.password || undefined });
  return c.json({ commands: redactCommands(commands) }, 202);
});

adminRoutes.delete("/devices/:sn/users/:pin", async (c) => {
  const device = await loadDevice(c);
  const pin = c.req.param("pin");
  if (!DEVICE_PIN_PATTERN.test(pin)) throw new HttpError(400, "Invalid pin");
  const commands = await removeUser(c.env, device, pin);
  return c.json({ commands: redactCommands(commands) }, 202);
});

adminRoutes.post("/devices/:sn/users/import", async (c) => {
  const device = await loadDevice(c);
  const { csv } = await readJson(c, z.object({ csv: z.string().max(MAX_BODY_BYTES) }));
  const rows = parseCsv(csv);
  // An optional header row starts with "pin".
  if (rows[0]?.cells[0]?.trim().toLowerCase() === "pin") rows.shift();
  if (rows.length > IMPORT_MAX_ROWS) throw new HttpError(413, `Too many rows (max ${IMPORT_MAX_ROWS})`);
  let imported = 0;
  let queued = 0;
  const errors: { line: number; error: string }[] = [];
  // Sequential: each user is a few commands and the queue order matters to the device.
  for (const { line, cells } of rows) {
    try {
      const [pin = "", name = "", cardNo = "", priv = ""] = cells.map((cell) => cell.trim());
      if (!PIN_PATTERN.test(pin)) throw new HttpError(400, "Invalid pin: use 1-24 digits");
      const user = check(userSchema, { name, cardNo: cardNo || undefined, privilege: parsePrivilege(priv) });
      queued += (await putUser(c.env, device, pin, user)).length;
      imported += 1;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      errors.push({ line, error: error.message });
    }
  }
  return c.json({ imported, queued, errors }, 202);
});

// Actions and commands

adminRoutes.post("/devices/:sn/actions/:action", async (c) => {
  const device = await loadDevice(c);
  const action = c.req.param("action");
  if (!isActionName(action)) throw new HttpError(400, `Unknown action: ${action}`);
  const body = await readJson(c, actionSchema);
  const commands = await runAction(c.env, device, action, body);
  return c.json({ commands: redactCommands(commands) }, 202);
});

adminRoutes.get("/devices/:sn/commands", async (c) => {
  const device = await loadDevice(c);
  const rows = await listCommands(c.env.DB, device.sn, intParam(c.req.query("limit"), 50, 1, 500));
  return c.json(redactCommands(rows));
});

// Attendance

adminRoutes.get("/attendance", async (c) => {
  const filter = check(attendanceSchema, queryOf(c));
  return c.json(await queryPunches(c.env.DB, filter));
});

const CSV_COLUMNS: (keyof (Punch & { deviceName: string | null }))[] = [
  "id",
  "eventId",
  "sn",
  "deviceName",
  "tenantId",
  "branchId",
  "pin",
  "punchedAt",
  "timezone",
  "punchedAtUtc",
  "direction",
  "verifyMode",
  "source",
  "deliveryStatus",
  "attempts",
  "lastError",
  "deliveredAt",
  "createdAt",
];

// Quote when needed, and defuse cells a spreadsheet would run as a formula.
const csvCell = (value: unknown) => {
  let cell = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
};

adminRoutes.get("/attendance.csv", async (c) => {
  const { cursor: _cursor, limit: _limit, ...filter } = check(attendanceSchema, queryOf(c));
  const lines = [CSV_COLUMNS.join(",")];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page += 1) {
    if (page === CSV_MAX_PAGES) {
      truncated = true;
      break;
    }
    const result = await queryPunches(c.env.DB, { ...filter, cursor, limit: CSV_PAGE });
    for (const punch of result.punches) lines.push(CSV_COLUMNS.map((column) => csvCell(punch[column])).join(","));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="attendance.csv"');
  // Large ranges are cut at CSV_MAX_PAGES * CSV_PAGE rows; narrow the dates to get the rest.
  if (truncated) c.header("X-Truncated", "true");
  return c.body(lines.join("\r\n") + "\r\n");
});

// Deliveries

adminRoutes.get("/deliveries", async (c) => {
  const tenantId = c.req.query("tenantId") || undefined;
  const [counts, failedOutbox, failedPunches] = await Promise.all([
    deliveryCounts(c.env.DB, tenantId),
    listWebhooks(c.env.DB, { tenantId, status: "failed", limit: 50 }),
    queryPunches(c.env.DB, { tenantId, deliveryStatus: "failed", limit: 20 }),
  ]);
  return c.json({ counts, failedOutbox, failedPunches: failedPunches.punches });
});

adminRoutes.post("/deliveries/retry", async (c) => {
  const body = await readJson(c, retrySchema);
  const tenant = await loadTenant(c, body.tenantId);
  const requeued = await requeuePunches(c.env.DB, { ...body, tenantId: tenant.id });
  // Don't wait for the cron sweep.
  if (requeued) scheduleDelivery(c.env, c.executionCtx as unknown as ExecutionContext, tenant.id);
  return c.json({ requeued });
});

adminRoutes.post("/outbox/:id/retry", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, "Invalid id");
  if (!(await retryWebhook(c.env.DB, id))) throw new HttpError(404, "Outbox row not found");
  return c.json({ ok: true });
});

adminRoutes.all("*", () => {
  throw new HttpError(404, "Not found");
});

// ---------- CSV import helpers ----------

const parsePrivilege = (value: string): "user" | "admin" | number | undefined => {
  const lower = value.toLowerCase();
  if (!lower) return undefined;
  if (lower === "user" || lower === "admin") return lower;
  return /^\d+$/.test(lower) ? Number(lower) : (lower as "user");
};

// Minimal RFC 4180 reader: quoted fields, "" escapes, CRLF or LF; blank lines skipped.
function parseCsv(input: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== "")) rows.push({ line: rowLine, cells });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line += 1;
        cell += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== "" || cells.length) endRow();
  return rows;
}
