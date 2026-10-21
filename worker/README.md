# ZKTeco ADMS gateway (Cloudflare Worker)

Receives punches from ZKTeco devices (SenseFace 2A via Security PUSH, uFace and other attendance
devices via legacy ADMS) and forwards them to each POS install. The POS manages device users
through the tenant API. Contract: [`../docs/pos-integration.md`](../docs/pos-integration.md).

| | |
|---|---|
| Device server | `adms.dokanepos.xyz` (HTTPS 443 or HTTP 80) |
| Admin UI | https://adms.dokanepos.xyz/admin/ (user `admin`) |
| Tenant API | `https://adms.dokanepos.xyz/api/v1` (`Authorization: Bearer <tenant key>`) |
| Cloudflare | Worker `zkteco-adms`, D1 `zkteco_adms`, cron every minute (POS retries) |

## Connecting a device: checklist

Do these in order; each step says what you should see before moving on.

### 1. Put the device on the internet

- Connect it to a router or switch with internet access (not the Mac's USB adapter).
- **COMM → Ethernet**: DHCP on, or a static IP with that network's gateway.
- DNS: set **`1.1.1.1`** (or `8.8.8.8`). Some office DNS servers cache "not found" for new
  hostnames for up to 30 minutes.
- ✅ The device menu shows an IP address on the office network.

### 2. Point it at the gateway

**COMM → Cloud Server Setting** (on the SenseFace 2A, HTTPS is under **COMM → PC settings**):

| Try | Server address | Port | HTTPS |
|---|---|---|---|
| First | `adms.dokanepos.xyz` | 443 | On |
| If that fails | `adms.dokanepos.xyz` | 80 | Off |

Save, then restart the device (or wait a minute).

- ✅ The device's cloud/server icon turns connected.
- HTTPS on Cloudflare is untested with this firmware. If the icon never connects on 443,
  switch to port 80 with HTTPS off.

### 3. Find it in the admin UI

Open **Devices** in the admin UI. The device appears by serial number (the SenseFace here is
`NYU7254701889`) as **Pending**, with a green dot while it's polling.

- ✅ It is listed, `deviceType` acc, last seen within the last minute.
- If it isn't listed after 2 minutes, watch the live log (below). No requests at all means
  the device can't reach Cloudflare: recheck DNS, gateway and the port/HTTPS pair.

### 4. Assign it to a tenant

1. **Tenants → New tenant**: the POS install's name and timezone. Copy the **API key** now;
   it is shown only once. POS URL and POS key can be left empty until the POS side exists.
2. Open the device, set **Tenant** and **Branch** (the POS `branches.id`), and click **Save assignment**. That
   approves it.

- ✅ The device shows **Approved**. Until a device is approved its uploads are refused.

### 5. Check time and users

- ✅ After a restart the device clock matches local time. The gateway sets it on every
  connect, so if the clock is wrong the device isn't reaching the gateway.
- Device page → **Fetch users**. ✅ Within ~15 s the command shows *success* and the user
  list fills in (empty is fine on a new device).
- Device page → **Add or update user**: PIN `1`, a name. ✅ The command reaches the device within a poll
  or two; enrol a face for that user on the device itself.

### 6. Punch

Verify the enrolled face at the device.

- ✅ **Attendance** shows the punch within a few seconds, with the right local time,
  direction and `face`. Its delivery status is:
  - `pending` while the tenant has no POS URL/key, or the POS is unreachable (retried with
    backoff: 1 min, 5 min, 15 min, 1 h, then every 6 h);
  - `delivered` once the POS accepts it;
  - `failed` if the POS rejects it with a 4xx other than 408/429 (re-send from **Deliveries → Redeliver punches**).
- Denied or unknown faces do not create punches (only successful verifications count).

### 7. Connect the POS (later)

When the POS has the `attendance-api/v1` routes (docs/pos-integration.md §5):

1. **Tenants → edit**: POS URL (e.g. `https://acme.dokanepos.xyz/api`) and the POS API key.
2. **Test connection**. ✅ `ok`.
3. Pending punches go out within a minute. To re-send older ones, use **Deliveries → Redeliver punches**
   with a date range.

## Watching the gateway

Live request log (each device request, punches, command deliveries, POS errors):

```sh
cd worker && npx wrangler tail zkteco-adms --format pretty
```

Or in the dashboard: Workers & Pages → `zkteco-adms` → Logs.

Quick checks from any machine:

```sh
curl https://adms.dokanepos.xyz/health                    # {"ok":true}
dig +short adms.dokanepos.xyz @1.1.1.1                     # Cloudflare IPs
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No requests in the live log | Device has no internet, wrong DNS, or wrong port/HTTPS pair. |
| Requests show "Rejected device request" | Device not approved yet: assign it to a tenant (step 4). |
| Device listed but clock is wrong | Requests aren't completing; check the log for errors. |
| Commands stay *sent* for 10 min then fail | Device stopped polling (offline or restarted mid-command); re-run the action. |
| Punches stay *pending* | Tenant has no POS URL/key, the tenant is disabled, or the POS is down. See **Deliveries**. |
| Punches *failed* with 401/403 | Wrong POS key in the tenant settings. |

## Development

```sh
npm install
cp .dev.vars.example .dev.vars        # set ADMIN_PASSWORD and ENCRYPTION_KEY
npm run db:migrate:local
npx wrangler dev --port 8787 --test-scheduled
npm run typecheck && npm test          # unit tests
bash test/e2e.sh                       # end-to-end against wrangler dev, with a mock POS
```

Deploy: `npm run db:migrate:remote` (when migrations changed), then `npm run deploy`.
Secrets: `npx wrangler secret put ADMIN_PASSWORD` / `ENCRYPTION_KEY`. Changing
`ENCRYPTION_KEY` makes stored POS keys unreadable; re-enter them afterwards.
