import type { Device, DeviceStatus } from "../types";
import { now, toDevice, type Row } from "./util";
import { cancelForeignCommands } from "./commands";

// Strangers can't flood the table: only the most recently seen pending devices are kept.
const MAX_PENDING_DEVICES = 100;

const clean = (value: string | null | undefined): string | null => (value == null ? null : value.trim() || null);

// Empty info values never replace stored ones.
const cleanInfo = (info: Record<string, string> | null | undefined): string | null => {
  const entries = Object.entries(info ?? {}).filter(([, v]) => v != null && String(v).trim() !== "");
  return entries.length ? JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, String(v).trim()]))) : null;
};

/**
 * Makes the device's punches follow its current tenant/branch: held punches are released to
 * the tenant (due now), and undelivered punches already owned by that tenant get the branch.
 * No-op while the device has no tenant.
 */
const syncPunches = (db: D1Database, sn: string, ts: string) =>
  db
    .prepare(
      `UPDATE punches SET
         tenant_id = (SELECT tenant_id FROM devices WHERE sn = ?1),
         branch_id = (SELECT branch_id FROM devices WHERE sn = ?1),
         delivery_status = CASE WHEN delivery_status = 'held' THEN 'pending' ELSE delivery_status END,
         next_attempt_at = CASE WHEN delivery_status = 'held' THEN ?2 ELSE next_attempt_at END
       WHERE sn = ?1
         AND (SELECT tenant_id FROM devices WHERE sn = ?1) IS NOT NULL
         AND (delivery_status = 'held'
              OR (delivery_status IN ('pending', 'failed') AND tenant_id = (SELECT tenant_id FROM devices WHERE sn = ?1)))`
    )
    .bind(sn, ts);

export async function recordSeen(
  db: D1Database,
  s: {
    sn: string;
    ip?: string | null;
    userAgent?: string | null;
    deviceType?: string | null;
    firmware?: string | null;
    pushVersion?: string | null;
    info?: Record<string, string> | null;
  }
): Promise<void> {
  if (!s.sn) return;
  const ts = now();
  const info = cleanInfo(s.info);
  await db.batch([
    db
      .prepare(
        `INSERT INTO devices (sn, device_type, firmware, push_version, user_agent, ip, info, status, last_seen, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8, ?8)
         ON CONFLICT(sn) DO UPDATE SET
           device_type = COALESCE(excluded.device_type, device_type),
           firmware = COALESCE(excluded.firmware, firmware),
           push_version = COALESCE(excluded.push_version, push_version),
           user_agent = COALESCE(excluded.user_agent, user_agent),
           ip = COALESCE(excluded.ip, ip),
           info = CASE WHEN excluded.info IS NULL THEN info ELSE json_patch(COALESCE(info, '{}'), excluded.info) END,
           last_seen = excluded.last_seen`
      )
      .bind(s.sn, clean(s.deviceType), clean(s.firmware), clean(s.pushVersion), clean(s.userAgent), clean(s.ip), info, ts),
    // The device's own name fills an empty name (as the Express service did).
    db
      .prepare(
        `UPDATE devices SET name = json_extract(info, '$."~DeviceName"')
         WHERE sn = ? AND (name IS NULL OR name = '') AND json_extract(info, '$."~DeviceName"') IS NOT NULL`
      )
      .bind(s.sn),
    db
      .prepare(
        `DELETE FROM devices WHERE status = 'pending' AND tenant_id IS NULL AND sn NOT IN (
           SELECT sn FROM devices WHERE status = 'pending' AND tenant_id IS NULL
           ORDER BY last_seen DESC LIMIT ?)`
      )
      .bind(MAX_PENDING_DEVICES),
  ]);
}

export async function getDevice(db: D1Database, sn: string): Promise<Device | null> {
  const row = await db.prepare("SELECT * FROM devices WHERE sn = ?").bind(sn).first<Row>();
  return row ? toDevice(row) : null;
}

export async function listDevices(
  db: D1Database,
  f: { tenantId?: string | null; branchId?: number; status?: DeviceStatus } = {}
): Promise<Device[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (f.tenantId === null) where.push("tenant_id IS NULL");
  else if (f.tenantId !== undefined) (where.push("tenant_id = ?"), values.push(f.tenantId));
  if (f.branchId !== undefined) (where.push("branch_id = ?"), values.push(f.branchId));
  if (f.status !== undefined) (where.push("status = ?"), values.push(f.status));
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`SELECT * FROM devices ${clause} ORDER BY last_seen DESC, sn`)
    .bind(...values)
    .all<Row>();
  return results.map(toDevice);
}

// One conditional UPSERT: it only touches a row that is unassigned or already this tenant's,
// so a concurrent claim by another tenant cannot win silently. RETURNING no row => conflict.
export async function claimDevice(
  db: D1Database,
  sn: string,
  tenantId: string,
  d: { name?: string | null; branchId: number | null }
): Promise<Device | "conflict"> {
  const ts = now();
  const [claimed] = await db.batch<Row>([
    db
      .prepare(
        `INSERT INTO devices (sn, tenant_id, branch_id, name, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'approved', ?6, ?6)
         ON CONFLICT(sn) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           branch_id = excluded.branch_id,
           name = CASE WHEN ?5 THEN excluded.name ELSE name END,
           -- a device the admin disabled stays disabled; claiming must not re-admit it
           status = CASE WHEN devices.status = 'disabled' THEN 'disabled' ELSE 'approved' END,
           updated_at = excluded.updated_at
         WHERE devices.tenant_id IS NULL OR devices.tenant_id = excluded.tenant_id
         RETURNING *`
      )
      .bind(sn, tenantId, d.branchId, clean(d.name), d.name === undefined ? 0 : 1, ts),
    syncPunches(db, sn, ts),
    cancelForeignCommands(db, sn, ts),
  ]);
  const row = claimed?.results[0];
  return row && row.tenant_id === tenantId ? toDevice(row) : "conflict";
}

// Only the fields present in the patch are written.
export async function updateDevice(
  db: D1Database,
  sn: string,
  patch: Partial<{ name: string | null; branchId: number | null; status: DeviceStatus; tenantId: string | null }>,
  // Set by the tenant API: the update only applies while the device still belongs to this tenant,
  // so a reassignment between the ownership check and the write can't be overridden.
  ownerTenantId?: string
): Promise<Device | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), values.push(clean(patch.name)));
  if (patch.branchId !== undefined) (sets.push("branch_id = ?"), values.push(patch.branchId));
  // Assigning a tenant is a claim, which admits the device unless the patch says otherwise.
  const status = patch.status ?? (patch.tenantId ? "approved" : undefined);
  if (status !== undefined) (sets.push("status = ?"), values.push(status));
  if (patch.tenantId !== undefined) (sets.push("tenant_id = ?"), values.push(patch.tenantId));
  if (!sets.length) return getDevice(db, sn);
  const ts = now();
  const owner = ownerTenantId === undefined ? "" : " AND tenant_id = ?";
  const ownerValues = ownerTenantId === undefined ? [] : [ownerTenantId];
  // The follow-up statements recompute from the device row, so they are no-ops if this one matched nothing.
  const statements = [
    db
      .prepare(`UPDATE devices SET ${sets.join(", ")}, updated_at = ? WHERE sn = ?${owner} RETURNING *`)
      .bind(...values, ts, sn, ...ownerValues),
  ];
  if (patch.tenantId !== undefined || patch.branchId !== undefined) statements.push(syncPunches(db, sn, ts));
  if (patch.tenantId !== undefined) statements.push(cancelForeignCommands(db, sn, ts));
  const [updated] = await db.batch<Row>(statements);
  const row = updated?.results[0];
  return row ? toDevice(row) : null;
}

// With ownerTenantId, only releases a device that still belongs to that tenant. Returns whether it did.
export async function releaseDevice(db: D1Database, sn: string, ownerTenantId?: string): Promise<boolean> {
  const ts = now();
  const owner = ownerTenantId === undefined ? "" : " AND tenant_id = ?";
  const [released] = await db.batch([
    db
      .prepare(`UPDATE devices SET tenant_id = NULL, branch_id = NULL, status = 'pending', updated_at = ? WHERE sn = ?${owner}`)
      .bind(ts, sn, ...(ownerTenantId === undefined ? [] : [ownerTenantId])),
    cancelForeignCommands(db, sn, ts),
  ]);
  return (released?.meta.changes ?? 0) > 0;
}

// Users and commands go with the device; punches are kept (they are the attendance record).
export async function deleteDevice(db: D1Database, sn: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare("DELETE FROM device_users WHERE sn = ?").bind(sn),
    db.prepare("DELETE FROM commands WHERE sn = ?").bind(sn),
    db.prepare("DELETE FROM devices WHERE sn = ?").bind(sn),
  ]);
  return (results[2]?.meta.changes ?? 0) > 0;
}

export async function isAdmitted(db: D1Database, sn: string, allowedSerials: string[]): Promise<boolean> {
  if (!sn) return false;
  if (allowedSerials.includes(sn)) return true;
  const row = await db.prepare("SELECT status FROM devices WHERE sn = ?").bind(sn).first<{ status: string }>();
  return row?.status === "approved";
}
