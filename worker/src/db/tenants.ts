import type { Tenant } from "../types";
import { now, toTenant, type Row } from "./util";
import { cancelTenantCommands } from "./commands";

type TenantPatch = Partial<{
  name: string;
  posApiUrl: string | null;
  posKeyEnc: string | null;
  apiKeyHash: string;
  apiKeyPrefix: string;
  timezone: string;
  enabled: boolean;
}>;

const COLUMNS: Record<keyof TenantPatch, string> = {
  name: "name",
  posApiUrl: "pos_api_url",
  posKeyEnc: "pos_key_enc",
  apiKeyHash: "api_key_hash",
  apiKeyPrefix: "api_key_prefix",
  timezone: "timezone",
  enabled: "enabled",
};

export async function createTenant(
  db: D1Database,
  t: { name: string; posApiUrl: string | null; posKeyEnc: string | null; apiKeyHash: string; apiKeyPrefix: string; timezone: string }
): Promise<Tenant> {
  const ts = now();
  const row = await db
    .prepare(
      `INSERT INTO tenants (id, name, pos_api_url, pos_key_enc, api_key_hash, api_key_prefix, timezone, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`
    )
    .bind(crypto.randomUUID(), t.name, t.posApiUrl, t.posKeyEnc, t.apiKeyHash, t.apiKeyPrefix, t.timezone, ts, ts)
    .first<Row>();
  return toTenant(row!);
}

export async function getTenant(db: D1Database, id: string): Promise<Tenant | null> {
  const row = await db.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<Row>();
  return row ? toTenant(row) : null;
}

export async function getTenantByApiKeyHash(db: D1Database, hash: string): Promise<Tenant | null> {
  const row = await db.prepare("SELECT * FROM tenants WHERE api_key_hash = ? AND enabled = 1").bind(hash).first<Row>();
  return row ? toTenant(row) : null;
}

export async function listTenants(
  db: D1Database
): Promise<(Tenant & { deviceCount: number; pendingDeliveries: number; failedDeliveries: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id) AS device_count,
         (SELECT COUNT(*) FROM punches p WHERE p.tenant_id = t.id AND p.delivery_status = 'pending') AS pending_deliveries,
         (SELECT COUNT(*) FROM punches p WHERE p.tenant_id = t.id AND p.delivery_status = 'failed') AS failed_deliveries
       FROM tenants t ORDER BY t.name COLLATE NOCASE, t.created_at`
    )
    .all<Row>();
  return results.map((r) => ({
    ...toTenant(r),
    deviceCount: Number(r.device_count) || 0,
    pendingDeliveries: Number(r.pending_deliveries) || 0,
    failedDeliveries: Number(r.failed_deliveries) || 0,
  }));
}

// Only the fields present in the patch are written.
export async function updateTenant(db: D1Database, id: string, patch: TenantPatch): Promise<Tenant | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(COLUMNS) as (keyof TenantPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key]} = ?`);
    values.push(key === "enabled" ? (value ? 1 : 0) : value);
  }
  if (!sets.length) return getTenant(db, id);
  const row = await db
    .prepare(`UPDATE tenants SET ${sets.join(", ")}, updated_at = ? WHERE id = ? RETURNING *`)
    .bind(...values, now(), id)
    .first<Row>();
  return row ? toTenant(row) : null;
}

// The tenant's devices go back to unassigned/pending. Its undelivered punches are failed and
// keep their tenant_id: holding them would hand them to whichever tenant claims the device next.
// Its queued commands are cancelled for the same reason. Outbox rows go with the tenant.
export async function deleteTenant(db: D1Database, id: string): Promise<boolean> {
  const ts = now();
  const results = await db.batch([
    cancelTenantCommands(db, id, ts),
    db
      .prepare("UPDATE devices SET tenant_id = NULL, branch_id = NULL, status = 'pending', updated_at = ? WHERE tenant_id = ?")
      .bind(ts, id),
    db
      .prepare(
        `UPDATE punches SET delivery_status = 'failed', last_error = 'Tenant deleted', next_attempt_at = NULL
         WHERE tenant_id = ? AND delivery_status = 'pending'`
      )
      .bind(id),
    db.prepare("DELETE FROM outbox WHERE tenant_id = ?").bind(id),
    db.prepare("DELETE FROM tenants WHERE id = ?").bind(id),
  ]);
  return (results[4]?.meta.changes ?? 0) > 0;
}
