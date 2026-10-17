// Punch and webhook delivery to POS installs (docs/pos-integration.md §2).
// Everything here is called from waitUntil or cron, so nothing may throw.
import type { Env, OutboxRow, Punch, PunchPayload, Tenant } from "./types";
import { decryptSecret } from "./lib/crypto";
import { getTenant } from "./db/tenants";
import {
  markPunchesDelivered,
  markPunchesFailed,
  markPunchesRetry,
  takeDuePunches,
  tenantsWithDuePunches,
} from "./db/punches";
import { markWebhookDelivered, markWebhookFailed, markWebhookRetry, takeDueWebhooks } from "./db/outbox";

const TIMEOUT_MS = 10_000;
// 98 so markPunchesRetry (ids + error + nextAttemptAt) stays within D1's 100 bound parameters.
const BATCH_SIZE = 98;
const MAX_BATCHES = 10;
const MAX_TENANTS_PER_RUN = 50;
// Posted one after another (10 s timeout each), so a run must fit in the 60 s outbox lease.
const WEBHOOKS_PER_RUN = 5;
// Parallel tenants per cron run; Workers allow 6 simultaneous outgoing connections.
const CONCURRENCY = 6;
const GIVE_UP_MS = 3 * 24 * 3600e3;
const BACKOFF_MS = [60e3, 300e3, 900e3, 3600e3, 21600e3];

type DuePunch = Punch & { deviceName: string | null };
type PostResult = { status: number | null; error: string | null };
export type Outcome = "delivered" | "retry" | "failed";

/** Delay before the next try, given how many attempts were already made (>= 1). */
export function nextAttemptDelayMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i]!;
}

/** HTTP status (null = timeout or network error) -> what to do with the items. */
export function classifyResponse(status: number | null): Outcome {
  if (status === null) return "retry";
  if (status >= 200 && status < 300) return "delivered";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "failed";
}

/** Retries stop once an item has waited 3 days since it was stored. */
export function isExpired(createdAt: string, now: Date): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now.getTime() - created > GIVE_UP_MS;
}

export function toPunchPayload(p: DuePunch): PunchPayload {
  return {
    eventId: p.eventId,
    deviceSN: p.sn,
    deviceName: p.deviceName,
    branchId: p.branchId,
    devicePin: p.pin,
    punchedAt: p.punchedAt,
    timezone: p.timezone,
    punchedAtUtc: p.punchedAtUtc,
    direction: p.direction,
    verifyMode: p.verifyMode,
    source: p.source,
  };
}

function isDeliverable(t: Tenant | null): t is Tenant & { posApiUrl: string; posKeyEnc: string } {
  return !!t && t.enabled && !!t.posApiUrl && !!t.posKeyEnc;
}

function endpoint(posApiUrl: string, path: string): string {
  return posApiUrl.replace(/\/+$/, "") + path;
}

// One HTTP attempt. Never throws; the error string never contains the POS key.
async function postJson(url: string, posKey: string, body: string): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Authorization": posKey,
        "Content-Type": "application/json",
        "X-Adms-Delivery-Id": crypto.randomUUID(),
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (res.ok) return { status: res.status, error: null };
    return { status: res.status, error: `HTTP ${res.status}${text ? ": " + text.slice(0, 200) : ""}` };
  } catch (e) {
    const timedOut = controller.signal.aborted;
    return { status: null, error: timedOut ? "Timed out after 10 s" : `Network error: ${errorMessage(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadPosKey(env: Env, tenant: Tenant & { posKeyEnc: string }): Promise<string | null> {
  try {
    return await decryptSecret(env, tenant.posKeyEnc);
  } catch (e) {
    console.error(`delivery: cannot decrypt POS key for tenant ${tenant.id}: ${errorMessage(e)}`);
    return null;
  }
}

// created_at is not reset by a redeliver, a held release or a late POS setup, so an old item
// also gets the full backoff schedule (attempts since it was last queued) before giving up.
const givesUp = (item: { createdAt: string; attempts: number }, now: Date): boolean =>
  item.attempts >= BACKOFF_MS.length && isExpired(item.createdAt, now);

// Expired punches fail; the rest retry, grouped by attempt count since each group has its own backoff.
async function retryPunches(env: Env, punches: DuePunch[], error: string, now: Date): Promise<void> {
  const expired = punches.filter((p) => givesUp(p, now)).map((p) => p.id);
  if (expired.length) await markPunchesFailed(env.DB, expired, `${error} (gave up after 3 days)`);
  const byAttempts = new Map<number, number[]>();
  for (const p of punches) {
    if (givesUp(p, now)) continue;
    byAttempts.set(p.attempts, [...(byAttempts.get(p.attempts) ?? []), p.id]);
  }
  for (const [attempts, ids] of byAttempts) {
    const next = new Date(now.getTime() + nextAttemptDelayMs(attempts + 1)).toISOString();
    await markPunchesRetry(env.DB, ids, error, next);
  }
}

/** Sends a tenant's due punches in batches of up to 98; stops at the first batch that is not delivered. */
export async function deliverTenant(env: Env, tenantId: string): Promise<void> {
  try {
    const tenant = await getTenant(env.DB, tenantId);
    if (!isDeliverable(tenant)) return;
    const posKey = await loadPosKey(env, tenant);
    if (posKey === null) return;
    const url = endpoint(tenant.posApiUrl, "/attendance-api/v1/punches");

    for (let i = 0; i < MAX_BATCHES; i++) {
      const now = new Date();
      const punches = await takeDuePunches(env.DB, tenantId, now.toISOString(), BATCH_SIZE);
      if (!punches.length) return;
      const res = await postJson(url, posKey, JSON.stringify({ punches: punches.map(toPunchPayload) }));
      const outcome = classifyResponse(res.status);
      const ids = punches.map((p: DuePunch) => p.id);
      if (outcome === "delivered") {
        await markPunchesDelivered(env.DB, ids);
        continue;
      }
      console.error(`delivery: tenant ${tenantId} punches ${outcome} (status ${res.status ?? "none"}): ${res.error}`);
      if (outcome === "failed") await markPunchesFailed(env.DB, ids, res.error ?? "Rejected");
      else await retryPunches(env, punches, res.error ?? "Retry", now);
      return;
    }
  } catch (e) {
    console.error(`delivery: tenant ${tenantId} error: ${errorMessage(e)}`);
  }
}

async function deliverWebhook(env: Env, row: OutboxRow, tenant: Tenant & { posApiUrl: string }, posKey: string): Promise<void> {
  const res = await postJson(endpoint(tenant.posApiUrl, "/attendance-api/v1/device-users"), posKey, row.payload);
  const outcome = classifyResponse(res.status);
  if (outcome === "delivered") return markWebhookDelivered(env.DB, row.id);
  console.error(`delivery: tenant ${row.tenantId} webhook ${row.id} ${outcome} (status ${res.status ?? "none"}): ${res.error}`);
  const now = new Date();
  const error = res.error ?? "Rejected";
  if (outcome === "failed") return markWebhookFailed(env.DB, row.id, error);
  if (givesUp(row, now)) return markWebhookFailed(env.DB, row.id, `${error} (gave up after 3 days)`);
  const next = new Date(now.getTime() + nextAttemptDelayMs(row.attempts + 1)).toISOString();
  return markWebhookRetry(env.DB, row.id, error, next);
}

/** Sends due outbox rows (device-users). Undeliverable tenants' rows stay pending. */
export async function deliverWebhooks(env: Env): Promise<void> {
  try {
    const rows = await takeDueWebhooks(env.DB, new Date().toISOString(), WEBHOOKS_PER_RUN);
    const keys = new Map<string, { tenant: Tenant & { posApiUrl: string }; posKey: string } | null>();
    for (const row of rows) {
      try {
        if (!keys.has(row.tenantId)) {
          const tenant = await getTenant(env.DB, row.tenantId);
          const posKey = isDeliverable(tenant) ? await loadPosKey(env, tenant) : null;
          keys.set(row.tenantId, isDeliverable(tenant) && posKey !== null ? { tenant, posKey } : null);
        }
        const target = keys.get(row.tenantId);
        if (target) await deliverWebhook(env, row, target.tenant, target.posKey);
      } catch (e) {
        console.error(`delivery: tenant ${row.tenantId} webhook ${row.id} error: ${errorMessage(e)}`);
      }
    }
  } catch (e) {
    console.error(`delivery: webhooks error: ${errorMessage(e)}`);
  }
}

/** Cron sweep: every tenant with due punches (a few at a time), then the outbox. */
export async function runDeliveries(env: Env): Promise<void> {
  try {
    const tenantIds: string[] = await tenantsWithDuePunches(env.DB, new Date().toISOString(), MAX_TENANTS_PER_RUN);
    for (let i = 0; i < tenantIds.length; i += CONCURRENCY) {
      await Promise.all(tenantIds.slice(i, i + CONCURRENCY).map((id) => deliverTenant(env, id)));
    }
  } catch (e) {
    console.error(`delivery: sweep error: ${errorMessage(e)}`);
  }
  await deliverWebhooks(env);
}

export function scheduleDelivery(env: Env, ctx: ExecutionContext, tenantId: string | null): void {
  if (tenantId) ctx.waitUntil(deliverTenant(env, tenantId));
}

/** Admin "test connection": POSTs an empty punch list and reports what came back. */
export async function testPosConnection(env: Env, tenant: Tenant): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!tenant.posApiUrl) return { ok: false, error: "POS API URL is not set" };
  if (!tenant.posKeyEnc) return { ok: false, error: "POS key is not set" };
  let posKey: string;
  try {
    posKey = await decryptSecret(env, tenant.posKeyEnc);
  } catch (e) {
    return { ok: false, error: `Cannot decrypt POS key: ${errorMessage(e)}` };
  }
  const res = await postJson(endpoint(tenant.posApiUrl, "/attendance-api/v1/punches"), posKey, JSON.stringify({ punches: [] }));
  const ok = classifyResponse(res.status) === "delivered";
  return { ok, ...(res.status !== null && { status: res.status }), ...(res.error && { error: res.error }) };
}
