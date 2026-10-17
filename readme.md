# Express-based HTTP Microservice for ZKTeco Device Logging

This microservice provides an API endpoint to accept data from **ZKTeco** devices and store it in an **SQLite database**. Additionally, it offers optional **API integration** with other applications.

## 🔗 API Integration

To integrate this microservice with another application, set the following environment variables in the `.env` file:

```bash
API_URL=https://api.example.com
API_KEY=1234567890
API_INTEGRATION_ENABLED=true
```

Refer to [`services/apiService.js`](services/apiService.js) for more details.

## 📌 Available Endpoints

The microservice includes endpoints to **retrieve attendance data**:

- `GET /api/attendance` — Retrieves all attendance logs.
- `GET /api/attendance/:id` — Retrieves a specific attendance log by ID.
- `GET /api/attendance/device/:deviceSN` — Retrieves attendance logs by **device serial number**.

## 🖥️ Admin UI

A small web UI at **`/admin`** lets you manage devices without editing `.env`: approve new devices, add or remove users on a device, pull users and attendance from it, sync its clock, open the door, reboot it, and browse or export attendance as CSV.

Enable it by setting a password (the UI and its API are disabled while `ADMIN_PASSWORD` is empty):

```bash
ADMIN_USER=admin
ADMIN_PASSWORD=change-me
```

Both `/admin` and `/api/admin` use HTTP Basic auth, so the browser prompts for these credentials. Serve the service over HTTPS (or keep it on a trusted network) since Basic auth sends the password with every request.

Basic auth sends the password with every request, so use HTTPS for admin access: set `HTTPS_PORT` (with `HTTPS_KEY`/`HTTPS_CERT`) or put a TLS proxy in front. After 10 failed logins from one IP within 15 minutes, that IP gets `429` for the rest of the window. State-changing admin requests must be JSON from the same origin.

The device channel (`/iclock/*`) has no credential besides the serial number (and `User-Agent`): anyone who knows an approved device's SN can poll its queued commands, which include the users you add (passwords are hidden in the UI, not on the wire to the device).

Fetching attendance from a device stores the records but does not forward them to the HR API (`API_INTEGRATION_ENABLED`), because the API receives no timestamp and would treat old punches as new ones. Live punches are forwarded as before.

### Adding a device

Point the device at this service (see the setup steps below). Every device that connects is recorded, even if it is rejected, and shows up in the UI as **pending**. Click **Approve** (or add it by serial number up front) and it is accepted from its next request. A device is accepted if any of these is true:

- it was approved in the admin UI,
- its serial number is in `ALLOWED_SERIALS`,
- its `User-Agent` contains one of the values in `ALLOWED_AGENT`.

### How device commands work

ZKTeco devices can't be called directly; they poll the server. Actions in the UI (adding a user, fetching users, ...) are queued as commands and picked up the next time the device polls `GET /iclock/getrequest`, usually within a few seconds while it is online. The device reports each result through `POST /iclock/devicecmd`, and the UI shows the command as `pending`, `sent`, `success` or `failed`. Users and attendance the device sends back (or pushes when someone enrols at the device) are stored locally.

Time sync and door opening are only available on access-control devices (`DeviceType=acc`, e.g. SenseFace 2A).

### Admin API

All endpoints are JSON, under `/api/admin`, and need the same Basic auth credentials. Errors look like `{ "message": "..." }`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/devices` | List known devices with `access` (`approved`, `allowlist`, `user-agent` or `pending`), `online` (seen in the last 2 minutes) and `userCount`. |
| `POST` | `/devices` | Add and approve a device: `{ "sn": "NYU7254701889", "name": "Front door" }`. |
| `GET` | `/devices/:sn` | One device, including the `info` it last reported. |
| `PATCH` | `/devices/:sn` | Rename or approve/revoke: `{ "name": "...", "approved": true }`. |
| `DELETE` | `/devices/:sn` | Forget a device with its stored users and commands. |
| `GET` | `/devices/:sn/users` | Users known for the device. |
| `POST` | `/devices/:sn/users` | Add or update a user on the device: `{ "pin": "1", "name": "Alice", "cardNo": "", "privilege": 0, "password": "" }`. `pin` must be digits. Returns `202` with the queued commands. |
| `DELETE` | `/devices/:sn/users/:pin` | Remove a user from the device. |
| `POST` | `/devices/:sn/actions/:action` | Queue `fetch-users`, `fetch-attendance` (body `{ "from": "2026-10-01", "to": "2026-10-17" }`), `sync-time`, `open-door` (body `{ "seconds": 5 }`) or `reboot`. |
| `GET` | `/devices/:sn/commands?limit=50` | Recent commands and their results. |
| `GET` | `/attendance?sn=&pin=&from=&to=&limit=100&offset=0` | Filtered attendance, newest first: `{ "rows": [...], "total": 123 }`. `from`/`to` take `YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss`. |
| `GET` | `/attendance.csv?sn=&pin=&from=&to=` | The same filter, downloaded as CSV. |

Example:

```bash
curl -u admin:change-me http://localhost:8080/api/admin/devices
curl -u admin:change-me -H "Content-Type: application/json" \
  -d '{"pin":"7","name":"Alice"}' http://localhost:8080/api/admin/devices/NYU7254701889/users
```

## 📟 Supported Devices

- **ZKTeco uFace 800** (tested)
- **ZKTeco SenseFace 2A** and other devices on newer ADMS/PUSH firmware

Devices are accepted if their `User-Agent` contains one of the values in `ALLOWED_AGENT`, **or** their serial number is listed in `ALLOWED_SERIALS` (both comma-separated):

```bash
ALLOWED_AGENT="iClock Proxy/1.09"
ALLOWED_SERIALS=AF4C200360136,CQZ7231260001
```

### SenseFace 2A setup

1. On the device, open **COMM → Cloud Server Setting (ADMS)**. Turn **Enable Domain Name** off, set **Server Address** to the machine running this service, set **Server Port** to `PORT`, and turn the proxy off.
2. Approve the device in the admin UI (it appears as pending after its first request), or add its serial number (**System Info → Device Info**) to `ALLOWED_SERIALS`. SenseFace firmware may not send the `iClock Proxy` User-Agent, and rejected requests are logged with their SN and User-Agent.
3. Punch once and check `GET /api/attendance/device/<SN>`.

Attendance logs (`ATTLOG`, and `rtlog` on access-control devices) are stored, as are the users the device reports (enrolments, or a **Fetch users** from the admin UI). Other tables the device pushes (`OPTIONS`, `BIODATA`, ...) are acknowledged and ignored. Punches the device re-sends are de-duplicated by device, PIN and time.

## 🤝 Contributing

Feel free to contribute by submitting a **pull request**. Your contributions are welcome! 🚀
