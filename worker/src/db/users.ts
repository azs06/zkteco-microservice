import type { DeviceUser, ParsedUser } from "../types";
import { MAX_PARAMS, chunk, now, toDeviceUser, type Row } from "./util";

const USER_PARAMS = 6;

const refreshUserCount = (db: D1Database, sn: string) =>
  db.prepare("UPDATE devices SET user_count = (SELECT COUNT(*) FROM device_users WHERE sn = ?1) WHERE sn = ?1").bind(sn);

const comparePins = (a: DeviceUser, b: DeviceUser) => a.pin.localeCompare(b.pin, undefined, { numeric: true });

export async function listDeviceUsers(db: D1Database, sn: string): Promise<DeviceUser[]> {
  const { results } = await db
    .prepare("SELECT pin, name, card_no, privilege, updated_at FROM device_users WHERE sn = ?")
    .bind(sn)
    .all<Row>();
  return results.map(toDeviceUser).sort(comparePins);
}

// Multi-row upserts, chunked to stay under the bound-parameter limit, plus the count refresh,
// all in one batch.
export async function upsertDeviceUsers(db: D1Database, sn: string, users: ParsedUser[], at: string = now()): Promise<void> {
  const valid = users.filter((u) => u && u.pin);
  const statements = chunk(valid, Math.floor(MAX_PARAMS / USER_PARAMS)).map((rows) =>
    db
      .prepare(
        `INSERT INTO device_users (sn, pin, name, card_no, privilege, updated_at)
         VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
         ON CONFLICT(sn, pin) DO UPDATE SET
           name = excluded.name, card_no = excluded.card_no, privilege = excluded.privilege, updated_at = excluded.updated_at`
      )
      .bind(...rows.flatMap((u) => [sn, String(u.pin), u.name || "", u.cardNo || "", Number(u.privilege) || 0, at]))
  );
  await db.batch([...statements, refreshUserCount(db, sn)]);
}

export async function deleteDeviceUser(db: D1Database, sn: string, pin: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM device_users WHERE sn = ? AND pin = ?").bind(sn, String(pin)),
    refreshUserCount(db, sn),
  ]);
}

// Removes users not touched since `before` (after a complete user query from the device).
export async function pruneDeviceUsers(db: D1Database, sn: string, before: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM device_users WHERE sn = ? AND updated_at < ?").bind(sn, before),
    refreshUserCount(db, sn),
  ]);
}
