// API keys, secret encryption and constant-time compare, all on WebCrypto.
import type { Env } from "../types";
import { HttpError } from "../types";

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** "adms_" + 32 random bytes base64url (43 chars). */
export function generateApiKey(): string {
  return "adms_" + toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(key)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A missing or malformed key is a deployment problem, so callers see 503, not 500.
async function importKey(env: Env): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY) throw new HttpError(503, "ENCRYPTION_KEY is not configured");
  let raw: Uint8Array;
  try {
    raw = fromBase64(env.ENCRYPTION_KEY.trim());
  } catch {
    throw new HttpError(503, "ENCRYPTION_KEY must be base64");
  }
  if (raw.length !== 32) throw new HttpError(503, "ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM, stored as "v1:<iv b64>:<ciphertext b64>". */
export async function encryptSecret(env: Env, plain: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(ct))}`;
}

/** Throws on a wrong key or tampered value (GCM auth tag check). */
export async function decryptSecret(env: Env, enc: string): Promise<string> {
  const key = await importKey(env);
  const [version, iv, ct] = enc.split(":");
  if (version !== "v1" || !iv || !ct) throw new Error("Unsupported secret format");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ct));
  return new TextDecoder().decode(plain);
}

/** Compares without short-circuiting; only the length is leaked. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
