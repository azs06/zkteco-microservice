import { z } from "zod";
import type { Context } from "hono";
import { HttpError } from "../types";

// Shared field schemas for the tenant API (and anyone else who wants them).
export const SN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// What a device itself may report as a PIN; used for lookups/filters, not for creating users.
export const DEVICE_PIN_PATTERN = /^[^\s=]{1,24}$/;
// The command builders accept a bare day or a full timestamp.
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;

export const snSchema = z.string().trim().regex(SN_PATTERN, "invalid serial number");
export const dateSchema = z.string().regex(DATE_PATTERN, "use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss");
export const branchIdSchema = z.coerce.number().int().positive();

/** One readable line from zod issues, e.g. "branchId: Expected number, received string". */
export function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

export function parseWith<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, zodMessage(result.error));
  return result.data;
}

/** Parses the JSON body (empty body => {}), so a malformed body is a 400, not a 500. */
export async function parseJson<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
  }
  return parseWith(schema, body);
}

export function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}
