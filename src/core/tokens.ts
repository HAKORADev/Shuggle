// Shuggle — token pool: up to 100 Kaggle tokens, auto-dedupe, weekly quota
// tracking, exhaustion flags, and automatic selection.

import { Kaggle } from "./kaggle.ts";

export type TokenState = "ok" | "exhausted" | "invalid";

export interface TokenRecord {
  id: string; // username
  secret: string; // KGAT token
  state: TokenState;
  usedHours: number;
  totalHours: number;
  resetAt: string; // ISO
  addedAt: number;
  lastUsedAt: number | null;
  lastCheckedAt: number | null;
  note?: string;
}

export interface TokenPool {
  tokens: TokenRecord[];
}

export const MAX_TOKENS = 100;

export function emptyPool(): TokenPool {
  return { tokens: [] };
}

export function poolGet(pool: TokenPool, username: string): TokenRecord | undefined {
  return pool.tokens.find((t) => t.id === username);
}

export function poolBySecret(pool: TokenPool, secret: string): TokenRecord | undefined {
  return pool.tokens.find((t) => t.secret === secret);
}

/** Add a token: introspects, dedupes by account (one account = one token). */
export async function poolAdd(
  pool: TokenPool,
  secret: string,
): Promise<{ ok: boolean; username?: string; error?: string; quota?: { usedHours: number; totalHours: number; resetAt: string } }> {
  const kaggle = new Kaggle(secret);
  let identity;
  try {
    identity = await kaggle.introspect();
  } catch (e: any) {
    return { ok: false, error: `Kaggle rejected this token — ${e.message}` };
  }
  const username = identity.username;
  const existing = pool.tokens.find((t) => t.id === username);
  if (existing) {
    if (existing.secret === secret) return { ok: false, username, error: "this token is already in the pool" };
    // One account, one token: replace the old secret with the fresh one.
    existing.secret = secret;
    existing.state = "ok";
    existing.note = "replaced with a newer token for the same account";
    return { ok: true, username, quota: await tryQuota(kaggle) };
  }
  if (pool.tokens.length >= MAX_TOKENS) {
    return { ok: false, username, error: `the pool is full (${MAX_TOKENS} tokens max)` };
  }
  const q = await tryQuota(kaggle);
  pool.tokens.push({
    id: username,
    secret,
    state: q && q.usedHours >= q.totalHours ? "exhausted" : "ok",
    usedHours: q?.usedHours ?? 0,
    totalHours: q?.totalHours ?? 30,
    resetAt: q?.resetAt ?? "",
    addedAt: Date.now(),
    lastUsedAt: null,
    lastCheckedAt: Date.now(),
  });
  return { ok: true, username, quota: q ?? undefined };
}

async function tryQuota(kaggle: Kaggle): Promise<{ usedHours: number; totalHours: number; resetAt: string } | null> {
  try {
    return await kaggle.quota();
  } catch {
    return null;
  }
}

/** Refresh quota for one token; flips exhausted state based on real numbers. */
export async function poolRefresh(pool: TokenPool, username: string): Promise<TokenRecord | null> {
  const rec = poolGet(pool, username);
  if (!rec) return null;
  const kaggle = new Kaggle(rec.secret);
  try {
    const q = await tryQuota(kaggle);
    if (q) {
      rec.usedHours = q.usedHours;
      rec.totalHours = q.totalHours;
      rec.resetAt = q.resetAt;
      rec.lastCheckedAt = Date.now();
      rec.state = q.usedHours >= q.totalHours ? "exhausted" : "ok";
      // Weekly reset passed?
      if (rec.state === "exhausted" && rec.resetAt) {
        const reset = Date.parse(rec.resetAt);
        if (!Number.isNaN(reset) && reset > Date.now() + 60_000) {
          // reset still in the future — stays exhausted
        } else {
          rec.state = "ok";
        }
      }
    }
  } catch (e: any) {
    if (String(e.message).includes("401") || String(e.message).includes("not active")) {
      rec.state = "invalid";
    }
  }
  return rec;
}

/** Pick the best available token: prefer the currently running one, then the freshest quota. */
export function poolAutoPick(pool: TokenPool, preferredUsername?: string | null): TokenRecord | null {
  const now = Date.now();
  // Weekly reset sweep
  for (const t of pool.tokens) {
    if (t.state === "exhausted" && t.resetAt) {
      const reset = Date.parse(t.resetAt);
      if (!Number.isNaN(reset) && reset <= now) t.state = "ok";
    }
  }
  if (preferredUsername) {
    const pref = poolGet(pool, preferredUsername);
    if (pref && pref.state === "ok") return pref;
  }
  const ok = pool.tokens.filter((t) => t.state === "ok");
  if (ok.length === 0) return null;
  ok.sort((a, b) => b.totalHours - b.usedHours - (a.totalHours - a.usedHours));
  return ok[0];
}

export function poolSummary(pool: TokenPool): {
  id: string;
  state: TokenState;
  usedHours: number;
  totalHours: number;
  resetAt: string;
  lastUsedAt: number | null;
  note?: string;
}[] {
  return pool.tokens.map((t) => ({
    id: t.id,
    state: t.state,
    usedHours: t.usedHours,
    totalHours: t.totalHours,
    resetAt: t.resetAt,
    lastUsedAt: t.lastUsedAt,
    note: t.note,
  }));
}
