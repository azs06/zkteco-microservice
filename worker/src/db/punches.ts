import { HttpError, type DeliveryStatus, type NewPunch, type Punch } from "../types";
import { MAX_PARAMS, chunk, endOfDay, now, placeholders, toPunch, type Row } from "./util";

type PunchRow = Punch & { deviceName: string | null };

const PUNCH_COLUMNS = [
  "event_id", "sn", "tenant_id", "branch_id", "pin", "punched_at", "punched_at_utc", "timezone",
  "direction", "verify_mode", "source", "delivery_status", "next_attempt_at", "created_at",
];
// Rows go in as one JSON parameter per statement (json_each), not 14 bound values per row,
// so a large upload is a few statements instead of hundreds. Kept well under D1's limits.
const JSON_CHUNK_CHARS = 90_000;
// Room for the extra bound values next to an id list.
const IDS_PER_UPDATE = MAX_PARAMS - 5;
// A taken batch is invisible to other deliverers for this long (one POS request, 10 s timeout).
const LEASE_MS = 60 * 1000;

const WITH_DEVICE_NAME = "SELECT p.*, d.name AS device_name FROM punches p LEFT JOIN devices d ON d.sn = p.sn";

// JSON keys of each row, in PUNCH_COLUMNS order.
const toJsonRow = (p: NewPunch, ts: string): unknown[] => [
  crypto.randomUUID(), p.sn, p.tenantId, p.branchId, p.pin, p.punchedAt, p.punchedAtUtc, p.timezone,
  p.direction, p.verifyMode, p.source, p.tenantId === null ? "held" : "pending", ts, ts,
];

// Splits rows into JSON array strings of at most JSON_CHUNK_CHARS (one row may exceed it alone).
const jsonChunks = (rows: unknown[][]): string[] => {
  const out: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (current.length && size + json.length + 1 > JSON_CHUNK_CHARS) {
      out.push(`[${current.join(",")}]`);
      (current = []), (size = 2);
    }
    current.push(json);
    size += json.length + 1;
  }
  if (current.length) out.push(`[${current.join(",")}]`);
  return out;
};

// Every statement in one batch (one transaction); duplicates (sn, pin, punched_at) are skipped.
export async function insertPunches(db: D1Database, punches: NewPunch[]): Promise<{ inserted: number }> {
  if (!punches.length) return { inserted: 0 };
  const ts = now();
  const select = PUNCH_COLUMNS.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ");
  // "WHERE true" keeps SQLite from parsing ON CONFLICT as a join constraint.
  const sql = `INSERT INTO punches (${PUNCH_COLUMNS.join(", ")}) SELECT ${select} FROM json_each(?) WHERE true
               ON CONFLICT(sn, pin, punched_at) DO NOTHING`;
  const statements = jsonChunks(punches.map((p) => toJsonRow(p, ts))).map((json) => db.prepare(sql).bind(json));
  // The caller read the device (no tenant yet) before this insert. If the device was assigned in
  // between, its held-punch release already ran and missed these rows, so release them here, in
  // the same transaction.
  const heldSerials = [...new Set(punches.filter((p) => p.tenantId === null).map((p) => p.sn))];
  const release = heldSerials.map((sn) =>
    db
      .prepare(
        `UPDATE punches SET
           tenant_id = (SELECT tenant_id FROM devices WHERE sn = ?1),
           branch_id = (SELECT branch_id FROM devices WHERE sn = ?1),
           delivery_status = 'pending', next_attempt_at = ?2
         WHERE sn = ?1 AND delivery_status = 'held'
           AND (SELECT tenant_id FROM devices WHERE sn = ?1) IS NOT NULL`
      )
      .bind(sn, ts)
  );
  const results = await db.batch([...statements, ...release]);
  return { inserted: results.slice(0, statements.length).reduce((sum, r) => sum + (r.meta.changes ?? 0), 0) };
}

// Opaque keyset cursor: base64url of [punched_at, id] of the last row returned.
const encodeCursor = (punchedAt: string, id: number) =>
  btoa(JSON.stringify([punchedAt, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const decodeCursor = (cursor: string): [string, number] => {
  try {
    const value = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (Array.isArray(value) && typeof value[0] === "string" && Number.isInteger(value[1])) return [value[0], value[1]];
  } catch {
    // fall through
  }
  throw new HttpError(400, "Invalid cursor");
};

export async function queryPunches(
  db: D1Database,
  f: {
    tenantId?: string;
    sn?: string;
    pin?: string;
    from?: string;
    to?: string;
    deliveryStatus?: DeliveryStatus;
    cursor?: string;
    limit?: number;
  }
): Promise<{ punches: PunchRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 100) || 100, 1), 500);
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => (where.push(sql), values.push(...v));
  if (f.tenantId) add("p.tenant_id = ?", f.tenantId);
  if (f.sn) add("p.sn = ?", f.sn);
  if (f.pin) add("p.pin = ?", f.pin);
  if (f.from) add("p.punched_at >= ?", f.from);
  if (f.to) add("p.punched_at <= ?", endOfDay(f.to));
  if (f.deliveryStatus) add("p.delivery_status = ?", f.deliveryStatus);
  if (f.cursor) {
    const [punchedAt, id] = decodeCursor(f.cursor);
    add("(p.punched_at < ? OR (p.punched_at = ? AND p.id < ?))", punchedAt, punchedAt, id);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`${WITH_DEVICE_NAME} ${clause} ORDER BY p.punched_at DESC, p.id DESC LIMIT ?`)
    .bind(...values, limit + 1)
    .all<Row>();
  const punches = results.slice(0, limit).map(toPunch);
  const last = punches[punches.length - 1];
  return { punches, nextCursor: results.length > limit && last ? encodeCursor(last.punchedAt, last.id) : null };
}

// Tenants that can actually be delivered to (enabled, POS configured) with punches due.
export async function tenantsWithDuePunches(db: D1Database, at: string, limit = 50): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT p.tenant_id FROM punches p JOIN tenants t ON t.id = p.tenant_id
       WHERE p.delivery_status = 'pending' AND p.next_attempt_at <= ?
         AND t.enabled = 1 AND t.pos_api_url IS NOT NULL AND t.pos_key_enc IS NOT NULL
       LIMIT ?`
    )
    .bind(at, limit)
    .all<{ tenant_id: string }>();
  return results.map((r) => r.tenant_id);
}

// Claims a batch by pushing next_attempt_at out by a short lease, so the cron and a
// waitUntil delivery running at the same time don't post the same punches twice.
// markPunches* then set the real outcome; a crashed delivery is retried after the lease.
export async function takeDuePunches(db: D1Database, tenantId: string, at: string, limit = 100): Promise<PunchRow[]> {
  const lease = new Date(Date.parse(at) + LEASE_MS).toISOString();
  const { results } = await db
    .prepare(
      `UPDATE punches SET next_attempt_at = ?1
       WHERE id IN (
         SELECT id FROM punches
         WHERE tenant_id = ?2 AND delivery_status = 'pending' AND next_attempt_at <= ?3
         ORDER BY punched_at, id LIMIT ?4)
       RETURNING *, (SELECT name FROM devices d WHERE d.sn = punches.sn) AS device_name`
    )
    .bind(lease, tenantId, at, Math.min(Math.max(limit, 1), 500))
    .all<Row>();
  return results.map(toPunch).sort((a, b) => a.punchedAt.localeCompare(b.punchedAt) || a.id - b.id);
}

// Runs one UPDATE per chunk of ids (bound-parameter limit), atomically.
const updateByIds = async (db: D1Database, ids: number[], setSql: string, setValues: unknown[]) => {
  if (!ids.length) return;
  await db.batch(
    chunk(ids, IDS_PER_UPDATE).map((part) =>
      db.prepare(`UPDATE punches SET ${setSql} WHERE id IN (${placeholders(part.length)})`).bind(...setValues, ...part)
    )
  );
};

export async function markPunchesDelivered(db: D1Database, ids: number[]): Promise<void> {
  await updateByIds(db, ids, "delivery_status = 'delivered', delivered_at = ?, next_attempt_at = NULL, last_error = NULL, attempts = attempts + 1", [now()]);
}

export async function markPunchesRetry(db: D1Database, ids: number[], error: string, nextAttemptAt: string): Promise<void> {
  await updateByIds(db, ids, "attempts = attempts + 1, last_error = ?, next_attempt_at = ?", [error, nextAttemptAt]);
}

export async function markPunchesFailed(db: D1Database, ids: number[], error: string): Promise<void> {
  await updateByIds(db, ids, "delivery_status = 'failed', attempts = attempts + 1, last_error = ?, next_attempt_at = NULL", [error]);
}

// Sends a tenant's punches again (held ones have no tenant and are never touched).
export async function requeuePunches(
  db: D1Database,
  f: { tenantId: string; from: string; to: string; sn?: string; failedOnly?: boolean }
): Promise<number> {
  const where = ["tenant_id = ?", "punched_at >= ?", "punched_at <= ?"];
  const values: unknown[] = [f.tenantId, f.from, endOfDay(f.to)];
  if (f.sn) (where.push("sn = ?"), values.push(f.sn));
  where.push(f.failedOnly ? "delivery_status = 'failed'" : "delivery_status IN ('pending', 'delivered', 'failed')");
  const result = await db
    .prepare(
      `UPDATE punches SET delivery_status = 'pending', next_attempt_at = ?, attempts = 0, last_error = NULL, delivered_at = NULL
       WHERE ${where.join(" AND ")}`
    )
    .bind(now(), ...values)
    .run();
  return result.meta.changes ?? 0;
}

export async function deliveryCounts(db: D1Database, tenantId?: string): Promise<Record<DeliveryStatus, number>> {
  const stmt =
    tenantId === undefined
      ? db.prepare("SELECT delivery_status, COUNT(*) AS n FROM punches GROUP BY delivery_status")
      : db.prepare("SELECT delivery_status, COUNT(*) AS n FROM punches WHERE tenant_id = ? GROUP BY delivery_status").bind(tenantId);
  const { results } = await stmt.all<{ delivery_status: DeliveryStatus; n: number }>();
  const counts: Record<DeliveryStatus, number> = { held: 0, pending: 0, delivered: 0, failed: 0 };
  for (const r of results) if (r.delivery_status in counts) counts[r.delivery_status] = Number(r.n) || 0;
  return counts;
}
