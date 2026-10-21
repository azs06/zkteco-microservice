import { describe, expect, it, vi } from "vitest";
import type { Env, Punch } from "../src/types";

// delivery.ts imports the db layer; these tests only cover its pure parts.
vi.mock("../src/db/tenants", () => ({ getTenant: vi.fn() }));
vi.mock("../src/db/punches", () => ({
  markPunchesDelivered: vi.fn(),
  markPunchesFailed: vi.fn(),
  markPunchesRetry: vi.fn(),
  takeDuePunches: vi.fn(),
  tenantsWithDuePunches: vi.fn(),
}));
vi.mock("../src/db/outbox", () => ({
  markWebhookDelivered: vi.fn(),
  markWebhookFailed: vi.fn(),
  markWebhookRetry: vi.fn(),
  takeDueWebhooks: vi.fn(),
}));

const { classifyResponse, isExpired, nextAttemptDelayMs, toPunchPayload } = await import("../src/delivery");
const { decryptSecret, encryptSecret, generateApiKey, hashApiKey, timingSafeEqual } = await import("../src/lib/crypto");
const { HttpError } = await import("../src/types");

function keyB64(fill: number, length = 32): string {
  return btoa(String.fromCharCode(...new Uint8Array(length).fill(fill)));
}

function envWith(key?: string): Env {
  return { ENCRYPTION_KEY: key } as Env;
}

describe("nextAttemptDelayMs", () => {
  it("follows 1m, 5m, 15m, 1h, then 6h", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(nextAttemptDelayMs)).toEqual([60e3, 300e3, 900e3, 3600e3, 21600e3, 21600e3, 21600e3]);
  });
  it("treats 0 like the first attempt", () => {
    expect(nextAttemptDelayMs(0)).toBe(60e3);
  });
});

describe("classifyResponse", () => {
  it.each([
    [200, "delivered"],
    [204, "delivered"],
    [408, "retry"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
    [null, "retry"],
    [400, "failed"],
    [401, "failed"],
    [404, "failed"],
    [422, "failed"],
    [302, "failed"],
  ] as const)("%s -> %s", (status, outcome) => {
    expect(classifyResponse(status)).toBe(outcome);
  });
});

describe("isExpired", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  it("gives up after 3 days", () => {
    expect(isExpired("2026-10-14T11:59:59Z", now)).toBe(true);
    expect(isExpired("2026-10-14T12:00:01Z", now)).toBe(false);
  });
});

describe("toPunchPayload", () => {
  it("maps a stored punch to the webhook shape", () => {
    const punch: Punch & { deviceName: string | null } = {
      id: 7,
      eventId: "0b1c7f0e-5a2d-4c39-9d61-4f0c2a9f8e11",
      sn: "NYU7254701889",
      tenantId: "t1",
      branchId: 3,
      pin: "17",
      punchedAt: "2026-10-17 09:01:22",
      timezone: "Asia/Dhaka",
      punchedAtUtc: "2026-10-17T03:01:22Z",
      direction: "in",
      verifyMode: "face",
      source: "live",
      deliveryStatus: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      deliveredAt: null,
      createdAt: "2026-10-17T03:01:23.000Z",
      deviceName: "Front door",
    };
    expect(toPunchPayload(punch)).toEqual({
      eventId: "0b1c7f0e-5a2d-4c39-9d61-4f0c2a9f8e11",
      deviceSN: "NYU7254701889",
      deviceName: "Front door",
      branchId: 3,
      devicePin: "17",
      punchedAt: "2026-10-17 09:01:22",
      timezone: "Asia/Dhaka",
      punchedAtUtc: "2026-10-17T03:01:22Z",
      direction: "in",
      verifyMode: "face",
      source: "live",
    });
  });
});

describe("crypto", () => {
  it("round-trips a secret with a random IV", async () => {
    const env = envWith(keyB64(1));
    const a = await encryptSecret(env, "pos-key-123");
    const b = await encryptSecret(env, "pos-key-123");
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await decryptSecret(env, a)).toBe("pos-key-123");
  });

  it("fails to decrypt with the wrong key or a tampered value", async () => {
    const enc = await encryptSecret(envWith(keyB64(1)), "secret");
    await expect(decryptSecret(envWith(keyB64(2)), enc)).rejects.toThrow();
    const [v, iv, ct] = enc.split(":");
    const flipped = ct!.startsWith("A") ? "B" + ct!.slice(1) : "A" + ct!.slice(1);
    await expect(decryptSecret(envWith(keyB64(1)), `${v}:${iv}:${flipped}`)).rejects.toThrow();
  });

  it("rejects a missing or wrong-length key with 503", async () => {
    for (const key of [undefined, "", keyB64(1, 16), "not base64!!"]) {
      const err = await encryptSecret(envWith(key), "x").catch((e) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(503);
    }
  });

  it("hashes keys to stable sha256 hex", async () => {
    expect(await hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashApiKey("abc")).toBe(await hashApiKey("abc"));
  });

  it("generates adms_ keys with 43 base64url chars", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^adms_[A-Za-z0-9_-]{43}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  it("compares strings in constant time", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual("secret", "secreT")).toBe(false);
    expect(timingSafeEqual("secret", "secret1")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
