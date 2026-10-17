# ZKTeco ADMS ↔ POS integration contract (v1, draft)

This service (the **ADMS Worker**, deployed on Cloudflare) sits between ZKTeco devices and
the HRM side of each POS install (`pos-api`, `B2B-Pos-api`). Devices only ever talk to the
Worker; the POS only ever talks to the Worker.

```
ZKTeco devices ──ADMS/Security PUSH──▶ ADMS Worker ──punches, device users──▶ POS (per tenant)
                                            ▲
                                            └──── device & user management, history ──── POS
```

## 1. Concepts

| Term | Meaning |
|---|---|
| **Tenant** | One POS install (one customer deployment). Stores the POS API base URL, the key the Worker uses to call it, a timezone, and the key the POS uses to call the Worker. |
| **Device** | A ZKTeco terminal, identified by serial number (`deviceSN`). Each device belongs to at most one tenant and one `branchId` (the POS `branches.id`). |
| **Device PIN** | The user ID typed into / enrolled on a device (`devicePin`, digits, ≤ 24 chars). |
| **Punch** | One successful verification on a device (face, fingerprint, card or password). |

Ownership:

- The **Worker** owns devices, the device ↔ tenant/branch assignment, the device command queue and the punch log.
- The **POS** owns employees and the **PIN → employee** mapping. The Worker never knows employee IDs.
- Recommended: one PIN per employee across the whole tenant (e.g. `employees.id`), so an employee can punch on any branch's device.

## 2. Worker → POS (webhooks)

Base URL: the tenant's `posApiUrl` (e.g. `https://acme.dokanepos.xyz/api`).
Every request carries:

```
X-Authorization: <tenant POS key>        # an api_keys key, checked by the existing auth.apikey middleware
Content-Type: application/json
X-Adms-Delivery-Id: <uuid>                # unique per HTTP attempt, for logging
```

### 2.1 `POST {posApiUrl}/attendance-api/v1/punches`

```json
{
  "punches": [
    {
      "eventId": "0b1c7f0e-5a2d-4c39-9d61-4f0c2a9f8e11",
      "deviceSN": "NYU7254701889",
      "deviceName": "Front door",
      "branchId": 3,
      "devicePin": "17",
      "punchedAt": "2026-10-17 09:01:22",
      "timezone": "Asia/Dhaka",
      "punchedAtUtc": "2026-10-17T03:01:22Z",
      "direction": "in",
      "verifyMode": "face",
      "source": "live"
    }
  ]
}
```

| Field | Notes |
|---|---|
| `eventId` | UUID, stable across retries and re-deliveries of the same punch. |
| `punchedAt` | The device's local wall-clock time, as the device reports it. |
| `timezone` / `punchedAtUtc` | The tenant's timezone, and `punchedAt` converted with it. |
| `direction` | `"in"`, `"out"` or `null` (device didn't say). |
| `verifyMode` | `"face"`, `"fingerprint"`, `"card"`, `"password"`, `"palm"` or `"other"`. |
| `source` | `"live"` (pushed as it happened) or `"history"` (fetched from the device's log later). Both are delivered. |

- Up to 100 punches per request, ordered by `punchedAt`.
- **The POS must be idempotent:** treat `eventId` as unique, and also ignore a punch whose
  `(deviceSN, devicePin, punchedAt)` already exists (a history fetch can return a punch that was
  already delivered live, under a different `eventId`).
- A punch whose `devicePin` maps to no employee must still be accepted (store it as unmatched,
  so it can be linked later).
- Reply `200 {"received": <n>}` once **all** punches in the request are stored.

### 2.2 `POST {posApiUrl}/attendance-api/v1/device-users`

Sent when the Worker learns a device's user list (a `fetch-users` action completes, or someone
enrols/edits a user on the device itself). Lets the POS show which PINs exist on which device.

```json
{
  "deviceSN": "NYU7254701889",
  "branchId": 3,
  "complete": true,
  "users": [
    { "devicePin": "17", "name": "Rahim", "cardNo": "", "privilege": "user" }
  ]
}
```

`complete: true` means this is the device's full list (PINs not listed are no longer on the
device); `false` means a partial update. Reply `200 {"received": <n>}`.

### 2.3 Delivery and retries

| POS response | Worker behaviour |
|---|---|
| `2xx` | Delivered. |
| `408`, `429`, `5xx`, timeout (10 s), network error | Retried with backoff: 1 min, 5 min, 15 min, 1 h, then every 6 h, for up to 3 days. |
| Any other `4xx` | Marked **failed** at once (shown in the admin UI; can be re-sent manually). |

Punches are stored in the Worker before the device is acknowledged, so a POS outage never
loses data; it only delays delivery.

## 3. POS → Worker (tenant API)

Base URL: `https://<adms-host>/api/v1`. Every request carries
`Authorization: Bearer <tenant API key>` (issued per tenant in the Worker's admin UI).
All responses are JSON; errors are `{"error": "<message>"}` with a 4xx/5xx status. Every
endpoint only sees the calling tenant's devices.

### Devices

| Method & path | Body | Result |
|---|---|---|
| `GET /devices` | | `[{ sn, name, branchId, deviceType, online, lastSeen, firmware, userCount }]` |
| `POST /devices` | `{ sn, name, branchId }` | `201` device. Claims an unassigned (or pending) device for this tenant. `409` if another tenant owns it. |
| `PATCH /devices/:sn` | `{ name?, branchId? }` | device |
| `DELETE /devices/:sn` | | `204`. Releases the device (it stops being accepted). |

### Users on devices

Changes are queued as device commands and applied the next time the device polls (seconds).
Each call returns `202 { "commands": [{ id, status }] }`.

| Method & path | Body |
|---|---|
| `GET /devices/:sn/users` | → `[{ devicePin, name, cardNo, privilege, updatedAt }]` |
| `PUT /devices/:sn/users/:pin` | `{ name, cardNo?, privilege?: "user" \| "admin", password? }`: create or update |
| `DELETE /devices/:sn/users/:pin` | removes the user and their biometrics from the device |
| `PUT /branches/:branchId/users/:pin` | same body; applied to every device of that branch |
| `DELETE /branches/:branchId/users/:pin` | removes from every device of that branch |

Faces and fingerprints are enrolled on the device itself; only the user record is pushed.

### Actions and commands

| Method & path | Body |
|---|---|
| `POST /devices/:sn/actions/fetch-users` | |
| `POST /devices/:sn/actions/fetch-attendance` | `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }` (results are delivered via §2.1 with `source: "history"`) |
| `POST /devices/:sn/actions/sync-time` | |
| `POST /devices/:sn/actions/open-door` | `{ seconds?: 1–60 }` (access-control devices only) |
| `POST /devices/:sn/actions/reboot` | |
| `GET /commands/:id` | → `{ id, deviceSN, kind, status: "pending" \| "sent" \| "success" \| "failed", returnCode, result, createdAt, completedAt }` |

### Attendance (pull, for reconciliation)

| Method & path | Notes |
|---|---|
| `GET /attendance?deviceSN=&devicePin=&from=&to=&cursor=&limit=` | Same punch objects as §2.1, newest first, `limit` ≤ 500, `{ punches, nextCursor }`. |
| `POST /attendance/redeliver` | `{ from, to, deviceSN? }`: queue those punches for webhook delivery again. |

## 4. Device connection

Devices point at the Worker's hostname (`adms.<your-domain>`) in **COMM → Cloud Server Setting**.
Access-control devices (SenseFace) speak the Security PUSH protocol and attendance devices
(uFace) the legacy ADMS protocol; the Worker handles both. A device is accepted only once a
tenant claims its serial number (§3) or an operator assigns it in the admin UI; until then it
shows as **pending**.

ZKTeco devices authenticate by serial number only, which is a protocol limitation. Keep the
pending list reviewed and release devices that are retired.

## 5. Work needed in each POS (`pos-api`, `B2B-Pos-api`)

1. **Routes:** an `attendance-api/v1` group behind the existing `auth.apikey` middleware
   (header `X-Authorization`), with `POST punches` and `POST device-users`.
2. **Tables:**
   - `attendance_punches` — `eventId` (unique), `deviceSN`, `branchId`, `devicePin`,
     `employeeId` (nullable), `punchedAt`, `punchedAtUtc`, `direction`, `verifyMode`, `source`,
     timestamps; unique `(deviceSN, devicePin, punchedAt)`.
   - `employee_device_pins` — `employeeId`, `devicePin` (unique per install).
   - Optionally `attendance_devices` mirroring §3 `GET /devices` for display.
3. **Feature toggle:** an "Attendance" entry in `modules` / `company_modules`, plus role
   permissions via `user_role_module_permissions`.
4. **Settings:** the Worker base URL and tenant API key, e.g. as an `app_settings` row of
   type `attendance` (the key encrypted like `EcomIntegration.apiKey`).
5. **Outbound client:** a small service that calls §3 (claim device, push employee PIN to a
   branch, fetch history), modelled on `InvoiceMicroServiceHelper`.

## 6. Open points

- **Poll interval vs. cost.** Devices poll for commands every `RequestDelay` seconds. At 2 s each
  device makes ~43,000 requests a day; at 30 s, ~2,900. Punches arrive instantly either way
  (they're pushed); the interval only affects how fast queued commands (add user, open door)
  reach the device. Proposed default: **15 s**.
- **PIN scope.** This contract assumes one PIN per employee per tenant. If two branches can
  reuse the same PIN for different people, the POS mapping must include `branchId`.
