import type { Command, CommandKind } from "../types";
import { now, toCommand, type Row } from "./util";

const SENT_TIMEOUT_MS = 10 * 60 * 1000;
const TIMED_OUT = "No reply from device (timed out)";
const ATTENDANCE_QUERY_WINDOW_MS = 10 * 60 * 1000;

const CANCELLED = "Cancelled: device changed owner";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// Run after a device's tenant changes (in the same batch): pending commands queued for the
// previous owner (user changes, door, reboot) must never run for the next one, and its sent
// DATA QUERY must not hold up the new owner's queue.
export const cancelForeignCommands = (db: D1Database, sn: string, ts: string): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE commands SET status = 'failed', result = COALESCE(result, ?1), completed_at = ?2
       WHERE sn = ?3 AND status IN ('pending', 'sent') AND tenant_id IS NOT (SELECT tenant_id FROM devices WHERE sn = ?3)`
    )
    .bind(CANCELLED, ts, sn);

// Same, for every device of a tenant being deleted.
export const cancelTenantCommands = (db: D1Database, tenantId: string, ts: string): D1PreparedStatement =>
  db
    .prepare(
      "UPDATE commands SET status = 'failed', result = COALESCE(result, ?1), completed_at = ?2 WHERE tenant_id = ?3 AND status IN ('pending', 'sent')"
    )
    .bind(CANCELLED, ts, tenantId);

export async function queueCommands(
  db: D1Database,
  sn: string,
  tenantId: string | null,
  kind: CommandKind,
  commands: string[]
): Promise<Command[]> {
  if (!commands.length) return [];
  const ts = now();
  const insert = db.prepare(
    "INSERT INTO commands (sn, tenant_id, kind, command, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING *"
  );
  const results = await db.batch<Row>(commands.map((command) => insert.bind(sn, tenantId, kind, command, ts)));
  return results.flatMap((r) => r.results.map(toCommand));
}

// One command per poll. Commands left 'sent' too long are failed first. The claim is a single
// UPDATE so two concurrent polls can't both send work while a DATA QUERY is still uploading
// (the Express version checked and claimed in separate statements).
export async function takeNextCommand(db: D1Database, sn: string): Promise<Command | null> {
  const ts = now();
  const [, taken] = await db.batch<Row>([
    db
      .prepare(
        `UPDATE commands SET status = 'failed', result = COALESCE(result, ?), completed_at = ?
         WHERE sn = ? AND status = 'sent' AND sent_at < ?`
      )
      .bind(TIMED_OUT, ts, sn, ago(SENT_TIMEOUT_MS)),
    db
      .prepare(
        `UPDATE commands SET status = 'sent', sent_at = ?1
         WHERE id = (SELECT id FROM commands WHERE sn = ?2 AND status = 'pending'
                       -- only the current owner's commands (guards a queue racing a reassignment)
                       AND tenant_id IS (SELECT tenant_id FROM devices WHERE sn = ?2)
                     ORDER BY id LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM commands WHERE sn = ?2 AND status = 'sent' AND command LIKE 'DATA QUERY%')
         RETURNING *`
      )
      .bind(ts, sn),
  ]);
  const row = taken?.results[0];
  return row ? toCommand(row) : null;
}

// Only the device a command was sent to can complete it. A late reply to a timed-out command
// (failed without a return code) is still accepted. The querydata result text is kept; the
// timeout note is dropped since the device did answer.
// A reply without a numeric code (NaN/null) fails the command, as in the Express service.
export async function completeCommand(db: D1Database, sn: string, id: number, returnCode: number | null): Promise<void> {
  const code = returnCode !== null && Number.isFinite(returnCode) ? Math.trunc(returnCode) : null;
  await db
    .prepare(
      `UPDATE commands SET status = ?, return_code = ?, result = NULLIF(result, ?), completed_at = ?
       WHERE id = ? AND sn = ? AND (status = 'sent' OR (status = 'failed' AND return_code IS NULL))`
    )
    .bind(code !== null && code >= 0 ? "success" : "failed", code, TIMED_OUT, now(), id, sn)
    .run();
}

// Accumulates querydata packets into progress JSON and a readable result. Packet 1 starts over,
// so a device re-sending the whole answer isn't double counted. The data may arrive before or
// after the devicecmd reply, so only 'pending' is excluded.
export async function recordQueryPacket(
  db: D1Database,
  sn: string,
  id: number,
  p: { label: string; count: number; inserted?: number; packidx: number; packcnt: number }
): Promise<void> {
  await db
    .prepare(
      `UPDATE commands SET
         progress = json_object('count', t.count, 'inserted', t.inserted, 'packets', t.packets),
         result = t.count || ' ' || ?3
           || CASE WHEN ?4 THEN ' (' || t.inserted || ' new)' ELSE '' END
           || CASE WHEN ?7 > 1 THEN ', packet ' || CAST(?6 AS INTEGER) || '/' || CAST(?7 AS INTEGER) ELSE '' END
       -- JS numbers bind as REAL in D1; the casts keep "12 users", not "12.0 users".
       FROM (
         SELECT id AS cid,
           CASE WHEN ?6 <= 1 THEN 0 ELSE COALESCE(json_extract(progress, '$.count'), 0) END + CAST(?8 AS INTEGER) AS count,
           CASE WHEN ?6 <= 1 THEN 0 ELSE COALESCE(json_extract(progress, '$.inserted'), 0) END + CAST(?5 AS INTEGER) AS inserted,
           CASE WHEN ?6 <= 1 THEN 0 ELSE COALESCE(json_extract(progress, '$.packets'), 0) END + 1 AS packets
         FROM commands WHERE id = ?1 AND sn = ?2
       ) AS t
       WHERE commands.id = t.cid AND commands.status != 'pending'`
    )
    .bind(id, sn, p.label, p.inserted === undefined ? 0 : 1, p.inserted ?? 0, p.packidx, p.packcnt, p.count)
    .run();
}

export async function getCommand(db: D1Database, id: number, tenantId?: string): Promise<Command | null> {
  const row =
    tenantId === undefined
      ? await db.prepare("SELECT * FROM commands WHERE id = ?").bind(id).first<Row>()
      : await db.prepare("SELECT * FROM commands WHERE id = ? AND tenant_id = ?").bind(id, tenantId).first<Row>();
  return row ? toCommand(row) : null;
}

export async function listCommands(db: D1Database, sn: string, limit = 50): Promise<Command[]> {
  const max = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const { results } = await db
    .prepare("SELECT * FROM commands WHERE sn = ? ORDER BY id DESC LIMIT ?")
    .bind(sn, max)
    .all<Row>();
  return results.map(toCommand);
}

export async function getSentQueryStart(db: D1Database, sn: string, id: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT sent_at FROM commands WHERE id = ? AND sn = ?")
    .bind(id, sn)
    .first<{ sent_at: string | null }>();
  return row?.sent_at ?? null;
}

// True while an attendance history query is in flight or just finished; ATTLOG uploads in
// that window are (mostly) answers to it rather than live punches.
export async function isAttendanceQueryActive(db: D1Database, sn: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM commands WHERE sn = ? AND kind = 'fetch-attendance'
       AND (status = 'sent' OR completed_at > ?) LIMIT 1`
    )
    .bind(sn, ago(ATTENDANCE_QUERY_WINDOW_MS))
    .first();
  return !!row;
}
