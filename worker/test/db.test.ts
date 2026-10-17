// Runs the src/db modules against a real (in-memory, local) D1 via wrangler's platform proxy.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
// @ts-expect-error vite ?raw import (no type declaration)
import migration from "../migrations/0001_init.sql?raw";
import { createTenant, deleteTenant, getTenantByApiKeyHash, listTenants, updateTenant } from "../src/db/tenants";
import { claimDevice, getDevice, isAdmitted, listDevices, recordSeen, updateDevice } from "../src/db/devices";
import { listDeviceUsers, pruneDeviceUsers, upsertDeviceUsers } from "../src/db/users";
import { completeCommand, getCommand, queueCommands, recordQueryPacket, takeNextCommand } from "../src/db/commands";
import {
  deliveryCounts,
  insertPunches,
  markPunchesDelivered,
  queryPunches,
  requeuePunches,
  takeDuePunches,
  tenantsWithDuePunches,
} from "../src/db/punches";
import { enqueueWebhook, retryWebhook, markWebhookFailed, takeDueWebhooks } from "../src/db/outbox";
import type { NewPunch } from "../src/types";

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let db: D1Database;

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  db = proxy.env.DB;
  const statements = (migration as string)
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

const punch = (sn: string, tenantId: string | null, pin: string, punchedAt: string): NewPunch => ({
  sn,
  tenantId,
  branchId: null,
  pin,
  punchedAt,
  punchedAtUtc: "2026-10-17T03:00:00Z",
  timezone: "Asia/Dhaka",
  direction: "in",
  verifyMode: "face",
  source: "live",
});

describe("db", () => {
  it("records devices without overwriting known values", async () => {
    await recordSeen(db, { sn: "SN1", ip: "1.2.3.4", firmware: "fw1", info: { "~DeviceName": "Door", a: "1" } });
    await recordSeen(db, { sn: "SN1", ip: null, firmware: "  ", info: { a: "", b: "2" } });
    const d = await getDevice(db, "SN1");
    expect(d).toMatchObject({ status: "pending", ip: "1.2.3.4", firmware: "fw1", name: "Door", info: { "~DeviceName": "Door", a: "1", b: "2" } });
    expect(await isAdmitted(db, "SN1", [])).toBe(false);
    expect(await isAdmitted(db, "SN1", ["SN1"])).toBe(true);
  });

  it("holds punches, dedupes, and releases them on claim", async () => {
    const many = Array.from({ length: 20 }, (_, i) => punch("SN1", null, String(i), "2026-10-17 09:00:00"));
    expect(await insertPunches(db, many)).toEqual({ inserted: 20 });
    expect(await insertPunches(db, [...many.slice(0, 3), punch("SN1", null, "x", "2026-10-17 10:00:00")])).toEqual({ inserted: 1 });
    expect((await deliveryCounts(db)).held).toBe(21);

    const a = await createTenant(db, { name: "A", posApiUrl: "https://a", posKeyEnc: "k", apiKeyHash: "ha", apiKeyPrefix: "adms_a", timezone: "Asia/Dhaka" });
    const b = await createTenant(db, { name: "B", posApiUrl: null, posKeyEnc: null, apiKeyHash: "hb", apiKeyPrefix: "adms_b", timezone: "Asia/Dhaka" });
    const claimed = await claimDevice(db, "SN1", a.id, { branchId: 7 });
    expect(claimed).toMatchObject({ tenantId: a.id, branchId: 7, status: "approved", name: "Door" });
    expect(await claimDevice(db, "SN1", b.id, { branchId: 1 })).toBe("conflict");
    expect(await deliveryCounts(db, a.id)).toEqual({ held: 0, pending: 21, delivered: 0, failed: 0 });

    await updateDevice(db, "SN1", { branchId: 9 });
    const page1 = await queryPunches(db, { tenantId: a.id, limit: 15 });
    expect(page1.punches).toHaveLength(15);
    expect(page1.punches[0]).toMatchObject({ pin: "x", branchId: 9, deviceName: "Door" });
    const page2 = await queryPunches(db, { tenantId: a.id, limit: 15, cursor: page1.nextCursor! });
    expect(page2.punches).toHaveLength(6);
    expect(page2.nextCursor).toBeNull();
    const ids = new Set([...page1.punches, ...page2.punches].map((p) => p.id));
    expect(ids.size).toBe(21);
    expect((await queryPunches(db, { to: "2026-10-17", from: "2026-10-17" })).punches).toHaveLength(21);

    const at = new Date(Date.now() + 1000).toISOString();
    expect(await tenantsWithDuePunches(db, at)).toEqual([a.id]);
    const due = await takeDuePunches(db, a.id, at, 100);
    expect(due).toHaveLength(21);
    expect(await takeDuePunches(db, a.id, at, 100)).toHaveLength(0); // leased
    await markPunchesDelivered(db, due.map((p) => p.id));
    expect((await deliveryCounts(db, a.id)).delivered).toBe(21);
    expect(await requeuePunches(db, { tenantId: a.id, from: "2026-10-17", to: "2026-10-17" })).toBe(21);

    expect(await getTenantByApiKeyHash(db, "ha")).not.toBeNull();
    await updateTenant(db, a.id, { enabled: false });
    expect(await getTenantByApiKeyHash(db, "ha")).toBeNull();
    expect((await listTenants(db)).find((t) => t.id === a.id)).toMatchObject({ deviceCount: 1, pendingDeliveries: 21 });

    expect(await deleteTenant(db, a.id)).toBe(true);
    expect(await getDevice(db, "SN1")).toMatchObject({ tenantId: null, status: "pending" });
    // A deleted tenant's punches fail under its id; they are never handed to the next owner.
    expect(await deliveryCounts(db)).toMatchObject({ held: 0, failed: 21 });
    expect(await listDevices(db, { tenantId: null })).toHaveLength(1);
    const c = await createTenant(db, { name: "C", posApiUrl: null, posKeyEnc: null, apiKeyHash: "hc", apiKeyPrefix: "adms_c", timezone: "Asia/Dhaka" });
    expect(await updateDevice(db, "SN1", { tenantId: c.id })).toMatchObject({ tenantId: c.id, status: "approved" });
    expect((await deliveryCounts(db, c.id)).pending).toBe(0);
    // A disabled device stays disabled when its tenant claims it again.
    await updateDevice(db, "SN1", { status: "disabled" });
    expect(await claimDevice(db, "SN1", c.id, { branchId: null })).toMatchObject({ tenantId: c.id, status: "disabled" });
    // Commands queued for the previous owner are cancelled on release.
    const [own] = await queueCommands(db, "SN1", c.id, "reboot", ["CONTROL DEVICE 03000000"]);
    await updateDevice(db, "SN1", { tenantId: null, status: "pending" });
    expect(await getCommand(db, own!.id)).toMatchObject({ status: "failed" });
    expect(await takeNextCommand(db, "SN1")).toBeNull();
  });

  it("sends one command at a time and blocks behind a DATA QUERY", async () => {
    const [q, x] = await queueCommands(db, "SN1", null, "fetch-users", ["DATA QUERY tablename=user", "CONTROL DEVICE 03000000"]);
    const first = await takeNextCommand(db, "SN1");
    expect(first?.id).toBe(q!.id);
    expect(await takeNextCommand(db, "SN1")).toBeNull();
    await recordQueryPacket(db, "SN1", q!.id, { label: "users", count: 10, packidx: 1, packcnt: 2 });
    await recordQueryPacket(db, "SN1", q!.id, { label: "users", count: 2, packidx: 2, packcnt: 2 });
    await completeCommand(db, "SN1", q!.id, 0);
    expect(await getCommand(db, q!.id)).toMatchObject({ status: "success", returnCode: 0, result: "12 users, packet 2/2" });
    expect((await takeNextCommand(db, "SN1"))?.id).toBe(x!.id);
  });

  it("keeps users and the user count in sync", async () => {
    await upsertDeviceUsers(db, "SN1", Array.from({ length: 40 }, (_, i) => ({ pin: String(i + 1), name: `U${i}`, cardNo: "", privilege: 0 })), "2026-01-01T00:00:00.000Z");
    await upsertDeviceUsers(db, "SN1", [{ pin: "2", name: "Two", cardNo: "", privilege: 14 }]);
    expect((await listDeviceUsers(db, "SN1")).slice(0, 3).map((u) => u.pin)).toEqual(["1", "2", "3"]);
    await pruneDeviceUsers(db, "SN1", "2026-06-01T00:00:00.000Z");
    expect((await getDevice(db, "SN1"))?.userCount).toBe(1);
  });

  it("queues webhooks", async () => {
    const t = await createTenant(db, { name: "W", posApiUrl: "https://w", posKeyEnc: "k", apiKeyHash: "hw", apiKeyPrefix: "adms_w", timezone: "Asia/Dhaka" });
    const off = await createTenant(db, { name: "X", posApiUrl: null, posKeyEnc: null, apiKeyHash: "hx", apiKeyPrefix: "adms_x", timezone: "Asia/Dhaka" });
    await enqueueWebhook(db, off.id, "device-users", { deviceSN: "D0", complete: true });
    await enqueueWebhook(db, t.id, "device-users", { deviceSN: "D1", complete: true });
    await enqueueWebhook(db, t.id, "device-users", { deviceSN: "D1", complete: false });
    await enqueueWebhook(db, t.id, "device-users", { deviceSN: "D2", complete: true });
    const later = () => new Date(Date.now() + 1000).toISOString();
    // Undeliverable tenants are skipped; one row per device, oldest first.
    const taken = await takeDueWebhooks(db, later());
    expect(taken.map((w) => JSON.parse(w.payload))).toEqual([{ deviceSN: "D1", complete: true }, { deviceSN: "D2", complete: true }]);
    const [w] = taken;
    expect(await takeDueWebhooks(db, later())).toHaveLength(0); // D1's newer row waits behind the leased one
    await markWebhookFailed(db, w!.id, "nope");
    expect((await takeDueWebhooks(db, later())).map((r) => JSON.parse(r.payload).complete)).toEqual([false]);
    expect(await retryWebhook(db, w!.id)).toBe(true);
  });

  it("inserts a large upload in a few JSON statements", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => punch("BIG", null, String(i), "2026-10-16 08:00:00"));
    expect(await insertPunches(db, many)).toEqual({ inserted: 2500 });
    expect(await insertPunches(db, many.slice(0, 10))).toEqual({ inserted: 0 });
    expect((await queryPunches(db, { sn: "BIG", pin: "42" })).punches[0]).toMatchObject({ branchId: null, deliveryStatus: "held", verifyMode: "face" });
  });

  it("caps pending devices", async () => {
    for (let i = 0; i < 105; i++) await recordSeen(db, { sn: `P${i}` });
    expect((await listDevices(db, { status: "pending" })).length).toBe(100);
  }, 60_000);
});
