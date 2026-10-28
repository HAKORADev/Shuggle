// Shuggle — small shared utilities.

import { createHash } from "node:crypto";

/**
 * Serialize like Python's json.dumps(obj, sort_keys=True, ensure_ascii=False)
 * — the engine hashes session history with that exact formatting, and both
 * sides must agree byte-for-byte on the delta-sync hashes.
 */
export function pyJson(value: any): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map((v) => pyJson(v)).join(", ") + "]";
  const keys = Object.keys(value).filter((k) => (value as any)[k] !== undefined).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}: ${pyJson(value[k])}`).join(", ") + "}";
}

/** Byte-compatible with the kernel's hsh(): sha256(pyJson)[:16]. */
export function hsh16(obj: any): string {
  return createHash("sha256").update(Buffer.from(pyJson(obj), "utf8")).digest("hex").slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r.toString().padStart(2, "0")}s`;
}

export function fmtHours(h: number): string {
  return `${h.toFixed(1)}h`;
}
