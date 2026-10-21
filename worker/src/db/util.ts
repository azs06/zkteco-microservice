// Shared row mapping and helpers for the D1 modules.
import type {
  Command,
  CommandKind,
  CommandStatus,
  DeliveryStatus,
  Device,
  DeviceStatus,
  DeviceUser,
  Direction,
  OutboxRow,
  Punch,
  PunchSource,
  Tenant,
  VerifyMode,
} from "../types";

export type Row = Record<string, unknown>;

/** D1 allows at most 100 bound parameters per statement. */
export const MAX_PARAMS = 100;

export const now = () => new Date().toISOString();

export const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const parseInfo = (value: unknown): Record<string, string> => {
  try {
    const info = JSON.parse(str(value) || "{}");
    return info && typeof info === "object" && !Array.isArray(info) ? info : {};
  } catch {
    return {};
  }
};

export const toTenant = (r: Row): Tenant => ({
  id: str(r.id),
  name: str(r.name),
  posApiUrl: strOrNull(r.pos_api_url),
  posKeyEnc: strOrNull(r.pos_key_enc),
  apiKeyPrefix: str(r.api_key_prefix),
  timezone: str(r.timezone),
  enabled: Number(r.enabled) === 1,
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

export const toDevice = (r: Row): Device => ({
  sn: str(r.sn),
  tenantId: strOrNull(r.tenant_id),
  branchId: numOrNull(r.branch_id),
  name: strOrNull(r.name),
  status: str(r.status) as DeviceStatus,
  deviceType: strOrNull(r.device_type),
  firmware: strOrNull(r.firmware),
  pushVersion: strOrNull(r.push_version),
  userAgent: strOrNull(r.user_agent),
  ip: strOrNull(r.ip),
  info: parseInfo(r.info),
  userCount: Number(r.user_count) || 0,
  lastSeen: strOrNull(r.last_seen),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

export const toDeviceUser = (r: Row): DeviceUser => ({
  pin: str(r.pin),
  name: str(r.name),
  cardNo: str(r.card_no),
  privilege: Number(r.privilege) || 0,
  updatedAt: str(r.updated_at),
});

export const toCommand = (r: Row): Command => ({
  id: Number(r.id),
  sn: str(r.sn),
  tenantId: strOrNull(r.tenant_id),
  kind: str(r.kind) as CommandKind,
  command: str(r.command),
  status: str(r.status) as CommandStatus,
  returnCode: numOrNull(r.return_code),
  result: strOrNull(r.result),
  createdAt: str(r.created_at),
  sentAt: strOrNull(r.sent_at),
  completedAt: strOrNull(r.completed_at),
});

export const toPunch = (r: Row): Punch & { deviceName: string | null } => ({
  id: Number(r.id),
  eventId: str(r.event_id),
  sn: str(r.sn),
  tenantId: strOrNull(r.tenant_id),
  branchId: numOrNull(r.branch_id),
  pin: str(r.pin),
  punchedAt: str(r.punched_at),
  punchedAtUtc: str(r.punched_at_utc),
  timezone: str(r.timezone),
  direction: strOrNull(r.direction) as Direction,
  verifyMode: (strOrNull(r.verify_mode) ?? "other") as VerifyMode,
  source: str(r.source) as PunchSource,
  deliveryStatus: str(r.delivery_status) as DeliveryStatus,
  attempts: Number(r.attempts) || 0,
  nextAttemptAt: strOrNull(r.next_attempt_at),
  lastError: strOrNull(r.last_error),
  deliveredAt: strOrNull(r.delivered_at),
  createdAt: str(r.created_at),
  deviceName: strOrNull(r.device_name),
});

export const toOutbox = (r: Row): OutboxRow => ({
  id: Number(r.id),
  tenantId: str(r.tenant_id),
  kind: "device-users",
  payload: str(r.payload),
  status: str(r.status) as OutboxRow["status"],
  attempts: Number(r.attempts) || 0,
  nextAttemptAt: str(r.next_attempt_at),
  lastError: strOrNull(r.last_error),
  deliveredAt: strOrNull(r.delivered_at),
  createdAt: str(r.created_at),
});

/** "YYYY-MM-DD" as an upper bound means the whole day. */
export const endOfDay = (to: string) => (/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to} 23:59:59` : to);
