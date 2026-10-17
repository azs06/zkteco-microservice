# Worker internal contract

Build-time contract between modules. Each module is owned by one builder; code against the
signatures here and against `src/types.ts`. Do not change another module's file. If a
signature here is wrong, implement it as written and note the problem in your report.

The external contract (devices and POS) is `../docs/pos-integration.md`. The Express service in
`../src` is the reference implementation of the device protocol, verified on a real SenseFace 2A
(firmware ZAM70-NF24HA-Ver3.3.12, push 3.1.2). Responses to devices must stay byte-identical to
it unless noted below.

Conventions: TypeScript strict, Hono 4, zod 3, ES modules, no Node-only APIs (use WebCrypto,
`crypto.randomUUID()`, `Intl`). Timestamps stored as ISO 8601 UTC strings (`new Date().toISOString()`)
except `punches.punched_at` (device local). DB rows are snake_case; functions return the camelCase
types from `src/types.ts`. Every db function takes `db: D1Database` first. Multi-statement writes
that must be atomic use `db.batch([...])` or a single statement.

## Decisions already made

- RequestDelay comes from `env.REQUEST_DELAY` (default "15"). Legacy `Delay` stays 30.
- One PIN per employee per tenant (POS concern; the Worker just passes `devicePin`).
- A device is **admitted** when `status = 'approved'` or its SN is in `env.ALLOWED_SERIALS`
  (comma-separated). Claiming a device (tenant API or admin assign) sets `approved`.
  Unadmitted requests get HTTP 200 `{"message":"Authentication failed."}` exactly like the Express service.
- Unknown devices with a valid SN (`/^[A-Za-z0-9_-]{1,64}$/`) are recorded as `pending`;
  at most 100 pending devices are kept (oldest `last_seen` dropped).
- Punches from an admitted device with no tenant are stored with `delivery_status = 'held'`;
  when the device is assigned to a tenant, its held punches become `pending` with that tenant/branch.
- Every successful punch is stored, live or history (`source`), deduped by `UNIQUE(sn,pin,punched_at)`
  with `INSERT ... ON CONFLICT DO NOTHING`. The device is acked only **after** the insert succeeds;
  on DB error the device gets a non-OK reply (`FAIL` for cdata) so it re-sends.
- Delivery: immediately after an insert, `ctx.waitUntil(deliverTenant(...))`; a cron every
  minute (`runDeliveries`) sweeps everything due. Backoff after attempt n (1-based):
  1m, 5m, 15m, 1h, then 6h; give up (`failed`) when the punch is older than 3 days since
  `created_at`. Retry on 408/429/5xx/timeout(10 s)/network; other 4xx => `failed` at once.
  Up to 100 punches per request, per tenant, ordered by `punched_at`.
- Timezone: the tenant's `timezone`, else `env.DEFAULT_TIMEZONE`. Used for the device config
  `TimeZone=` (hours, may be fractional), `ServerTZ=` (+HHMM) and `punchedAtUtc`.
- Admin auth: HTTP Basic, user `admin`, password `env.ADMIN_PASSWORD` (constant-time compare);
  503 `{error}` when the secret is unset. Admin UI files are served from `env.ASSETS` only after auth.
  Mutating admin requests must be `application/json` and same-origin (CSRF guard, as in `../src/routes/adminRoutes.js`).
- Tenant API auth: `Authorization: Bearer <key>`; keys look like `adms_<43 base64url chars>`;
  stored as sha256 hex; `api_key_prefix` = first 12 chars.
- Errors from HTTP APIs: `{"error": "<message>"}`; throw `HttpError` from `src/types.ts`.

## Modules

### `src/lib/time.ts` (protocol builder)
```ts
export function offsetMinutes(timeZone: string, at?: Date): number;      // Asia/Dhaka -> 360
export function formatOffset(minutes: number): string;                     // 360 -> "+0600", -210 -> "-0330"
export function localToUtcIso(local: string, timeZone: string): string;    // "2026-10-17 09:01:22","Asia/Dhaka" -> "2026-10-17T03:01:22Z"; throws on bad input
export function nowLocal(timeZone: string, at?: Date): string;             // "YYYY-MM-DD HH:mm:ss"
export function isValidTimeZone(timeZone: string): boolean;
```

### `src/protocol/format.ts` (protocol builder) — port of `../src/helpers.js`
```ts
export function getConfig(sn: string, offsetHours: number): string;                                   // legacy cdata handshake
export function getRegistryCode(sn: string): Promise<string>;                                         // sha1("zk-acc-"+sn) hex, first 10 (MUST equal Express output)
export function getAccConfig(sn: string, offsetHours: number, requestDelay: number): Promise<string>; // RequestDelay from arg
export function encodeDeviceSeconds(date: Date): number;
export function decodeDeviceSeconds(value: string | number): string | null;
export function getDeviceTime(date: Date, serverTZ: string): string;
export function parseKeyValues(body: string): Record<string, string>;
export function parseTabLine(line: string): { table: string; fields: Record<string, string> };
export function toLines(body: string): string[];
export function parseAttendanceLog(body: string): ParsedPunch[];     // ATTLOG
export function parseRealtimeLog(body: string): ParsedPunch[];       // rtlog
export function parseTransactionLines(body: string): ParsedPunch[];  // querydata transaction
export function parseUserLines(body: string): ParsedUser[];
export function verifyModeOf(code: string | number | undefined): VerifyMode;
```
Direction: ATTLOG status 0 => in, 1 => out, else null; rtlog `inoutstatus` / transaction
`inoutstate` 0 => in, 1 => out, else null. Verify codes (ZKTeco): 0 or 3 => password,
1 => fingerprint, 2 or 4 => card, 15 => face, 25 => palm, anything else => other.
ATTLOG verify is the 4th tab field; rtlog `verifytype`; transaction `verified`.

### `src/protocol/commands.ts` (protocol builder) — port of `../src/commands.js`
```ts
export function addUser(deviceType: string | null, u: { pin: string; name?: string; cardNo?: string; privilege?: number; password?: string }): string[];
export function deleteUser(deviceType: string | null, pin: string): string[];
export function queryUsers(deviceType: string | null): string[];
export function queryAttendance(deviceType: string | null, range: { from: string; to: string }): string[];
export function syncTime(deviceType: string | null, at?: Date): string[];
export function openDoor(deviceType: string | null, seconds?: number): string[];
export function reboot(deviceType: string | null): string[];
export function redact(command: string): string;
```
Invalid input throws `HttpError(400, message)`.

### `src/lib/crypto.ts` (delivery builder)
```ts
export function generateApiKey(): string;                                   // "adms_" + 32 random bytes base64url
export function hashApiKey(key: string): Promise<string>;                   // sha256 hex
export function encryptSecret(env: Env, plain: string): Promise<string>;    // AES-GCM with ENCRYPTION_KEY, "v1:<iv b64>:<ct b64>"; throws HttpError(503) if key unset
export function decryptSecret(env: Env, enc: string): Promise<string>;
export function timingSafeEqual(a: string, b: string): boolean;
```

### `src/db/*.ts` (data builder)
`src/db/tenants.ts`
```ts
export function createTenant(db, t: { name: string; posApiUrl: string | null; posKeyEnc: string | null; apiKeyHash: string; apiKeyPrefix: string; timezone: string }): Promise<Tenant>;
export function getTenant(db, id: string): Promise<Tenant | null>;
export function getTenantByApiKeyHash(db, hash: string): Promise<Tenant | null>;   // enabled tenants only
export function listTenants(db): Promise<(Tenant & { deviceCount: number; pendingDeliveries: number; failedDeliveries: number })[]>;
export function updateTenant(db, id: string, patch: Partial<{ name: string; posApiUrl: string | null; posKeyEnc: string | null; apiKeyHash: string; apiKeyPrefix: string; timezone: string; enabled: boolean }>): Promise<Tenant | null>;
export function deleteTenant(db, id: string): Promise<boolean>;   // devices become unassigned+pending, their punches held
```
`src/db/devices.ts`
```ts
export function recordSeen(db, s: { sn: string; ip?: string | null; userAgent?: string | null; deviceType?: string | null; firmware?: string | null; pushVersion?: string | null; info?: Record<string, string> | null }): Promise<void>;
//   upsert: new rows are 'pending'; never overwrite a known value with null/empty; info merged; last_seen=now; enforce 100-pending cap
export function getDevice(db, sn: string): Promise<Device | null>;
export function listDevices(db, f?: { tenantId?: string | null; branchId?: number; status?: DeviceStatus }): Promise<Device[]>;  // tenantId null => unassigned only
export function claimDevice(db, sn: string, tenantId: string, d: { name?: string | null; branchId: number | null }): Promise<Device | "conflict">;
//   single atomic statement(s): insert if missing, or update only WHERE tenant_id IS NULL OR tenant_id = ?; sets status approved; releases held punches to this tenant/branch
export function updateDevice(db, sn: string, patch: Partial<{ name: string | null; branchId: number | null; status: DeviceStatus; tenantId: string | null }>): Promise<Device | null>;
//   assigning a tenant releases held punches; branch change updates branch_id of undelivered punches
export function releaseDevice(db, sn: string): Promise<void>;   // tenant_id=null, branch_id=null, status=pending
export function deleteDevice(db, sn: string): Promise<boolean>;
export function isAdmitted(db, sn: string, allowedSerials: string[]): Promise<boolean>;
```
`src/db/users.ts`
```ts
export function listDeviceUsers(db, sn: string): Promise<DeviceUser[]>;      // numeric-aware PIN order
export function upsertDeviceUsers(db, sn: string, users: ParsedUser[], at?: string): Promise<void>;  // also refreshes devices.user_count
export function deleteDeviceUser(db, sn: string, pin: string): Promise<void>;
export function pruneDeviceUsers(db, sn: string, before: string): Promise<void>;  // delete updated_at < before; refresh user_count
```
`src/db/commands.ts`
```ts
export function queueCommands(db, sn: string, tenantId: string | null, kind: CommandKind, commands: string[]): Promise<Command[]>;
export function takeNextCommand(db, sn: string): Promise<Command | null>;
//   1) mark 'sent' older than 10 min as failed "No reply from device (timed out)";
//   2) ONE atomic UPDATE ... WHERE id = (oldest pending for sn) AND NOT EXISTS (a 'sent' command for sn whose command LIKE 'DATA QUERY%') RETURNING *
export function completeCommand(db, sn: string, id: number, returnCode: number): Promise<void>;   // only if status sent, or failed with null return_code; >=0 success else failed; keeps existing result
export function recordQueryPacket(db, sn: string, id: number, p: { label: string; count: number; inserted?: number; packidx: number; packcnt: number }): Promise<void>;
//   accumulates progress JSON and sets result text like "12 users" / "40 attendance records (3 new), packet 2/3"
export function getCommand(db, id: number, tenantId?: string): Promise<Command | null>;  // tenantId given => must match
export function listCommands(db, sn: string, limit?: number): Promise<Command[]>;      // newest first, default 50
export function getSentQueryStart(db, sn: string, id: number): Promise<string | null>;  // sent_at of that command (used to prune users)
export function isAttendanceQueryActive(db, sn: string): Promise<boolean>;  // kind fetch-attendance and (sent or completed < 10 min ago)
```
`src/db/punches.ts`
```ts
export function insertPunches(db, punches: NewPunch[]): Promise<{ inserted: number }>;   // one db.batch; event_id = randomUUID; status held if tenantId null else pending, next_attempt_at=now
export function queryPunches(db, f: { tenantId?: string; sn?: string; pin?: string; from?: string; to?: string; deliveryStatus?: DeliveryStatus; cursor?: string; limit?: number }): Promise<{ punches: (Punch & { deviceName: string | null })[]; nextCursor: string | null }>;
//   newest first by (punched_at, id); from/to compare punched_at ("YYYY-MM-DD" means whole day); cursor opaque; limit default 100 max 500
export function tenantsWithDuePunches(db, now: string, limit?: number): Promise<string[]>;
export function takeDuePunches(db, tenantId: string, now: string, limit?: number): Promise<(Punch & { deviceName: string | null })[]>;   // pending, next_attempt_at <= now, oldest punched_at first, default 100
export function markPunchesDelivered(db, ids: number[]): Promise<void>;
export function markPunchesRetry(db, ids: number[], error: string, nextAttemptAt: string): Promise<void>;   // attempts+1
export function markPunchesFailed(db, ids: number[], error: string): Promise<void>;                       // attempts+1
export function requeuePunches(db, f: { tenantId: string; from: string; to: string; sn?: string; failedOnly?: boolean }): Promise<number>;  // set pending, next_attempt_at=now, attempts=0
export function deliveryCounts(db, tenantId?: string): Promise<Record<DeliveryStatus, number>>;
```
`src/db/outbox.ts`
```ts
export function enqueueWebhook(db, tenantId: string, kind: "device-users", payload: unknown): Promise<void>;
export function takeDueWebhooks(db, now: string, limit?: number): Promise<OutboxRow[]>;
export function markWebhookDelivered(db, id: number): Promise<void>;
export function markWebhookRetry(db, id: number, error: string, nextAttemptAt: string): Promise<void>;
export function markWebhookFailed(db, id: number, error: string): Promise<void>;
export function listWebhooks(db, f: { tenantId?: string; status?: string; limit?: number }): Promise<OutboxRow[]>;
export function retryWebhook(db, id: number): Promise<boolean>;
```

### `src/delivery.ts` (delivery builder)
```ts
export function nextAttemptDelayMs(attempts: number): number;               // attempts already made (>=1) -> 60e3, 300e3, 900e3, 3600e3, then 21600e3
export function toPunchPayload(p: Punch & { deviceName: string | null }): PunchPayload;
export function deliverTenant(env: Env, tenantId: string): Promise<void>;   // loops batches of 100 until none due (max 10 batches per call); never throws
export function deliverWebhooks(env: Env): Promise<void>;
export function runDeliveries(env: Env): Promise<void>;                     // cron: all tenants with due punches + due webhooks
export function scheduleDelivery(env: Env, ctx: ExecutionContext, tenantId: string | null): void;  // no-op for null
export function testPosConnection(env: Env, tenant: Tenant): Promise<{ ok: boolean; status?: number; error?: string }>;  // POST punches {punches: []}
```
POS request: `POST ${posApiUrl}/attendance-api/v1/punches`, headers `X-Authorization`,
`Content-Type: application/json`, `X-Adms-Delivery-Id: <uuid>`, 10 s timeout via AbortController.
Device users: `POST ${posApiUrl}/attendance-api/v1/device-users`. A tenant without `posApiUrl`
or `posKeyEnc`, or disabled, is skipped (punches stay pending, no attempt counted).

### `src/services/actions.ts` (tenant-API builder; admin routes use it too)
```ts
export type ActionName = "fetch-users" | "fetch-attendance" | "sync-time" | "open-door" | "reboot";
export function runAction(env: Env, device: Device, action: ActionName, body: { from?: string; to?: string; seconds?: number }): Promise<Command[]>;
export function putUser(env: Env, device: Device, pin: string, u: { name: string; cardNo?: string; privilege?: "user" | "admin" | number; password?: string }): Promise<Command[]>;
//   queues addUser commands and optimistically upserts device_users
export function removeUser(env: Env, device: Device, pin: string): Promise<Command[]>;  // queues deleteUser commands, deletes local row
export const PIN_PATTERN: RegExp;   // /^\d{1,24}$/
```
`privilege` "admin" => 14, "user" => 0.

### `src/routes/device.ts` (device builder)
```ts
export const deviceRoutes: Hono<AppEnv>;   // mounted at "/", handles /iclock/* only
```
Port every handler from `../src/routes/deviceRoutes.js` + `../src/middleware/auth.js`
(query normalisation, inferDeviceType, admission, registry, push, ping, rtdata, cdata GET/POST,
getrequest (one command per poll via takeNextCommand), devicecmd, querydata, catch-all).
Differences from Express: no in-memory state (use `recordQueryPacket`, `getSentQueryStart`);
punches go through `insertPunches` with the tenant timezone, then `scheduleDelivery`;
device-users webhook via `enqueueWebhook` (complete=true after the last packet of a
`fetch-users` query, complete=false for OPERLOG/tabledata user uploads), then `scheduleDelivery`
isn't needed for webhooks (cron picks them up) but call `ctx.waitUntil(deliverWebhooks(env))`.
Device bookkeeping (recordSeen) must never break the device conversation (catch + console.error,
use waitUntil). `console.log` request summaries (redact passwords).

### `src/routes/api.ts` (tenant-API builder)
```ts
export const apiRoutes: Hono<AppEnv>;   // mounted at "/api/v1"; exactly docs/pos-integration.md §3
```

### `src/routes/admin.ts` + `public/admin/*` (admin builder)
```ts
export const adminRoutes: Hono<AppEnv>;            // mounted at "/api/admin"
export const adminAuth: MiddlewareHandler<AppEnv>;  // Basic auth; also guards /admin assets in index.ts
```
Admin API (all JSON):
- `GET /tenants`, `POST /tenants` `{name, posApiUrl?, posKey?, timezone?}` → `201 {tenant, apiKey}` (key shown once),
  `PATCH /tenants/:id` `{name?, posApiUrl?, posKey?, timezone?, enabled?}`, `DELETE /tenants/:id`,
  `POST /tenants/:id/rotate-key` → `{apiKey}`, `POST /tenants/:id/test` → testPosConnection result.
- `GET /devices?status=&tenantId=`, `GET /devices/:sn`, `PATCH /devices/:sn` `{name?, status?, tenantId?, branchId?}`, `DELETE /devices/:sn`.
- `GET /devices/:sn/users`, `PUT /devices/:sn/users/:pin`, `DELETE /devices/:sn/users/:pin`, `POST /devices/:sn/users/import` (CSV text body field `{csv}`: pin,name,cardNo,privilege).
- `POST /devices/:sn/actions/:action`, `GET /devices/:sn/commands`.
- `GET /attendance?tenantId=&sn=&pin=&from=&to=&deliveryStatus=&cursor=&limit=`, `GET /attendance.csv?...`.
- `GET /deliveries` → counts + recent failed outbox rows; `POST /deliveries/retry` `{tenantId, from, to, sn?}`; `POST /outbox/:id/retry`.
- `GET /health` → `{ok:true}`.

### `src/index.ts` (written up front; integrator may fix)
Mounts routes, serves assets behind `adminAuth`, exports `fetch` and `scheduled`.
