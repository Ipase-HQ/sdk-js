// Local validation, protocol section 15. Each check returns the first reason that applies, or
// undefined. Nothing is ever truncated or repaired here.

import type { Properties } from "./types";

export type Reason =
  | "invalid_name"
  | "reserved_name"
  | "reserved_property_key"
  | "invalid_user_id"
  | "properties_too_many"
  | "property_key_too_long"
  | "property_value_too_long"
  | "invalid_property"
  | "event_too_large";

export const MAX_EVENT_BYTES = 32 * 1024;

/** A screen name, or a track name when host is false (SDK-emitted reserved names). */
export function checkName(name: unknown, host = true): Reason | undefined {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) return "invalid_name";
  if (host && name.charAt(0) === "$") return "reserved_name";
  return undefined;
}

export function checkUserId(id: unknown): Reason | undefined {
  return typeof id !== "string" || id.length < 1 || id.length > 128 ? "invalid_user_id" : undefined;
}

export function checkProperties(props: unknown): Reason | undefined {
  if (props === undefined || props === null) return undefined;
  if (typeof props !== "object" || Array.isArray(props)) return "invalid_property";
  const keys = Object.keys(props);
  if (keys.length > 100) return "properties_too_many";
  for (const key of keys) {
    if (key.charAt(0) === "$") return "reserved_property_key";
    if (key.length < 1 || key.length > 64) return "property_key_too_long";
    const value = (props as Properties)[key];
    if (typeof value === "string") {
      if (value.length > 1024) return "property_value_too_long";
    } else if (typeof value === "number") {
      if (!isFinite(value)) return "invalid_property";
    } else if (typeof value !== "boolean" && value !== null) {
      return "invalid_property";
    }
  }
  return undefined;
}

/** UTF-8 byte length without TextEncoder, so the core stays platform-agnostic. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
