import type { OutboxRow } from "../types";
import { now, toOutbox, type Row } from "./util";

// Same lease idea as takeDuePunches: a taken webhook is hidden from a concurrent sweep.
const LEASE_MS = 60 * 1000;

export async function enqueueWebhook(db: D1Database, tenantId: string, kind: "device-users", payload: unknown): Promise<void> {
  const ts = now();
  await db
    .prepare("INSERT INTO outbox (tenant_id, kind, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)")
    .bind(tenantId, kind, JSON.stringify(payload), ts, ts)
    .run();
}

// Only rows of deliverable tenants (as tenantsWithDuePunches), so undeliverable ones can't
// fill every sweep. Only the oldest pending row per (tenant, device) is taken: a retried
// complete snapshot must not land after a newer partial update and overwrite it at the POS.
export async function takeDueWebhooks(db: D1Database, at: string, limit = 20): Promise<OutboxRow[]> {
  const lease = new Date(Date.parse(at) + LEASE_MS).toISOString();
  const { results } = await db
    .prepare(
      `UPDATE outbox SET next_attempt_at = ?1
       WHERE id IN (
         SELECT o.id FROM outbox o JOIN tenants t ON t.id = o.tenant_id
         WHERE o.status = 'pending' AND o.next_attempt_at <= ?2
           AND t.enabled = 1 AND t.pos_api_url IS NOT NULL AND t.pos_key_enc IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM outbox e
             WHERE e.status = 'pending' AND e.tenant_id = o.tenant_id AND e.id < o.id
               AND json_extract(e.payload, '$.deviceSN') IS json_extract(o.payload, '$.deviceSN'))
         ORDER BY o.id LIMIT ?3)
       RETURNING *`
    )
    .bind(lease, at, Math.min(Math.max(limit, 1), 100))
    .all<Row>();
  return results.map(toOutbox).sort((a, b) => a.id - b.id);
}

export async function markWebhookDelivered(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE outbox SET status = 'delivered', delivered_at = ?, last_error = NULL, attempts = attempts + 1 WHERE id = ?")
    .bind(now(), id)
    .run();
}

export async function markWebhookRetry(db: D1Database, id: number, error: string, nextAttemptAt: string): Promise<void> {
  await db
    .prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?")
    .bind(error, nextAttemptAt, id)
    .run();
}

export async function markWebhookFailed(db: D1Database, id: number, error: string): Promise<void> {
  await db
    .prepare("UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?")
    .bind(error, id)
    .run();
}

// Newest first.
export async function listWebhooks(
  db: D1Database,
  f: { tenantId?: string; status?: string; limit?: number } = {}
): Promise<OutboxRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (f.tenantId) (where.push("tenant_id = ?"), values.push(f.tenantId));
  if (f.status) (where.push("status = ?"), values.push(f.status));
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50) || 50, 1), 500);
  const { results } = await db
    .prepare(`SELECT * FROM outbox ${clause} ORDER BY id DESC LIMIT ?`)
    .bind(...values, limit)
    .all<Row>();
  return results.map(toOutbox);
}

export async function retryWebhook(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE outbox SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ?, delivered_at = NULL WHERE id = ?")
    .bind(now(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
