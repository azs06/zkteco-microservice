-- One row per POS install.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,                    -- uuid
  name TEXT NOT NULL,
  pos_api_url TEXT,                       -- e.g. https://acme.dokanepos.xyz/api (no trailing slash)
  pos_key_enc TEXT,                       -- POS X-Authorization key, AES-GCM encrypted (lib/crypto)
  api_key_hash TEXT NOT NULL UNIQUE,      -- sha256 hex of the key the POS uses to call us
  api_key_prefix TEXT NOT NULL,           -- first chars of that key, for display
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- status: pending (seen, not admitted) | approved (admitted) | disabled (refused)
CREATE TABLE devices (
  sn TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  branch_id INTEGER,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  device_type TEXT,                       -- 'acc' (Security PUSH) or null/other (legacy ADMS)
  firmware TEXT,
  push_version TEXT,
  user_agent TEXT,
  ip TEXT,
  info TEXT,                              -- JSON object (registry / OPTIONS key=values)
  user_count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_devices_tenant ON devices (tenant_id, branch_id);
CREATE INDEX idx_devices_status ON devices (status);

CREATE TABLE device_users (
  sn TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  pin TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  card_no TEXT NOT NULL DEFAULT '',
  privilege INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sn, pin)
);

-- status: pending | sent | success | failed
CREATE TABLE commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sn TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  tenant_id TEXT,
  kind TEXT NOT NULL,                     -- add-user, delete-user, fetch-users, fetch-attendance, sync-time, open-door, reboot
  command TEXT NOT NULL,                  -- wire text without the "C:<id>:" prefix
  status TEXT NOT NULL DEFAULT 'pending',
  return_code INTEGER,
  result TEXT,                            -- human-readable outcome / querydata summary
  progress TEXT,                          -- JSON {count, inserted, packets} accumulated across querydata packets
  created_at TEXT NOT NULL,
  sent_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_commands_device ON commands (sn, status, id);

-- Punch log and webhook outbox in one.
-- delivery_status: held (device has no tenant yet) | pending | delivered | failed
CREATE TABLE punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,          -- uuid, stable across retries
  sn TEXT NOT NULL,
  tenant_id TEXT,
  branch_id INTEGER,
  pin TEXT NOT NULL,
  punched_at TEXT NOT NULL,               -- device local wall clock, YYYY-MM-DD HH:mm:ss
  punched_at_utc TEXT NOT NULL,           -- ISO 8601 Z
  timezone TEXT NOT NULL,
  direction TEXT,                         -- in | out | null
  verify_mode TEXT NOT NULL DEFAULT 'other',
  source TEXT NOT NULL,                   -- live | history
  delivery_status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (sn, pin, punched_at)
);
CREATE INDEX idx_punches_delivery ON punches (delivery_status, next_attempt_at);
CREATE INDEX idx_punches_tenant_time ON punches (tenant_id, punched_at);
CREATE INDEX idx_punches_sn_time ON punches (sn, punched_at);

-- Other webhooks (device-users). status: pending | delivered | failed
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- 'device-users'
  payload TEXT NOT NULL,                  -- JSON request body
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_due ON outbox (status, next_attempt_at);
