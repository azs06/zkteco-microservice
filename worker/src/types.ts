// Shared types. Every module codes against these; see CONTRACT.md for module exports.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DEFAULT_TIMEZONE: string;
  REQUEST_DELAY: string;
  ALLOWED_SERIALS: string;
  ADMIN_PASSWORD?: string;
  ENCRYPTION_KEY?: string;
}

export type AppEnv = { Bindings: Env };

export type DeviceStatus = "pending" | "approved" | "disabled";
export type CommandStatus = "pending" | "sent" | "success" | "failed";
export type DeliveryStatus = "held" | "pending" | "delivered" | "failed";
export type Direction = "in" | "out" | null;
export type VerifyMode = "face" | "fingerprint" | "card" | "password" | "palm" | "other";
export type PunchSource = "live" | "history";
export type CommandKind =
  | "add-user"
  | "delete-user"
  | "fetch-users"
  | "fetch-attendance"
  | "sync-time"
  | "open-door"
  | "reboot";

export interface Tenant {
  id: string;
  name: string;
  posApiUrl: string | null;
  posKeyEnc: string | null;
  apiKeyPrefix: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Device {
  sn: string;
  tenantId: string | null;
  branchId: number | null;
  name: string | null;
  status: DeviceStatus;
  deviceType: string | null;
  firmware: string | null;
  pushVersion: string | null;
  userAgent: string | null;
  ip: string | null;
  info: Record<string, string>;
  userCount: number;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceUser {
  pin: string;
  name: string;
  cardNo: string;
  privilege: number;
  updatedAt: string;
}

/** A user record as parsed from device uploads (password is never stored). */
export interface ParsedUser {
  pin: string;
  name: string;
  cardNo: string;
  privilege: number;
}

export interface Command {
  id: number;
  sn: string;
  tenantId: string | null;
  kind: CommandKind;
  command: string;
  status: CommandStatus;
  returnCode: number | null;
  result: string | null;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
}

/** A punch as parsed from a device upload, before tenant/timezone are attached. */
export interface ParsedPunch {
  pin: string;
  punchedAt: string; // device local "YYYY-MM-DD HH:mm:ss"
  direction: Direction;
  verifyMode: VerifyMode;
}

export interface NewPunch extends ParsedPunch {
  sn: string;
  tenantId: string | null;
  branchId: number | null;
  timezone: string;
  punchedAtUtc: string; // ISO 8601 with Z
  source: PunchSource;
}

export interface Punch extends NewPunch {
  id: number;
  eventId: string;
  deliveryStatus: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/** The punch object in webhooks and GET /api/v1/attendance (docs/pos-integration.md §2.1). */
export interface PunchPayload {
  eventId: string;
  deviceSN: string;
  deviceName: string | null;
  branchId: number | null;
  devicePin: string;
  punchedAt: string;
  timezone: string;
  punchedAtUtc: string;
  direction: Direction;
  verifyMode: VerifyMode;
  source: PunchSource;
}

export interface OutboxRow {
  id: number;
  tenantId: string;
  kind: "device-users";
  payload: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/** Thrown for bad input anywhere; routes turn it into 4xx JSON {error}. */
export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503,
    message: string
  ) {
    super(message);
  }
}
