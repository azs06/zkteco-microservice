// Stateless admin sessions: the cookie is "<expiry ms>.<HMAC>" signed with a key derived from
// ADMIN_PASSWORD, so changing the password signs everyone out.

import { timingSafeEqual } from "./crypto";

export const SESSION_COOKIE = "adms_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const encoder = new TextEncoder();

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sign = async (password: string, expiry: number) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`adms-admin-session:${password}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(`admin:${expiry}`)));
};

export const createSession = async (password: string, now = Date.now()) => {
  const expiry = now + SESSION_TTL_MS;
  return `${expiry}.${await sign(password, expiry)}`;
};

export const verifySession = async (password: string, token: string | undefined, now = Date.now()) => {
  const [expiryText, signature] = (token || "").split(".");
  const expiry = Number(expiryText);
  if (!signature || !Number.isSafeInteger(expiry) || expiry <= now) return false;
  return timingSafeEqual(signature, await sign(password, expiry));
};

// Failed logins per client IP, per isolate. Workers have no shared memory, so this only slows
// down guessing from one client; it is not a global lockout.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map<string, { count: number; since: number }>();

export const isLoginThrottled = (ip: string, now = Date.now()) => {
  const entry = failures.get(ip);
  if (!entry || now - entry.since > FAIL_WINDOW_MS) return false;
  return entry.count >= MAX_FAILS;
};

export const recordLoginFailure = (ip: string, now = Date.now()) => {
  const entry = failures.get(ip);
  if (!entry || now - entry.since > FAIL_WINDOW_MS) failures.set(ip, { count: 1, since: now });
  else entry.count++;
  if (failures.size > 1000) failures.clear();
};

export const clearLoginFailures = (ip: string) => failures.delete(ip);
