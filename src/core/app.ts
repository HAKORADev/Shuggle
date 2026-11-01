// Shuggle — application context: profile state, engine slots, persistence.

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { DeviceIdentity, Profile, deviceSignature } from "./store.ts";
import { GlobalSettings, clampSettings, defaultSettings } from "./settings.ts";
import { SessionData, Store, emptyStore, activePath } from "./sessions.ts";
import { TokenPool, TokenRecord, emptyPool } from "./tokens.ts";
import { EngineSlot } from "./engine.ts";
import { hsh16 } from "./util.ts";
import { MemoryEntry } from "./memory.ts";

export interface MemoryState {
  text: string;
  history: MemoryEntry[];
}

export class AppContext {
  readonly events = new EventEmitter();
  readonly dataDir: string;
  readonly device: DeviceIdentity;
  profile: Profile | null = null;

  // unlocked in-memory state (persisted encrypted per domain)
  sessions: Store = emptyStore();
  settings: GlobalSettings = defaultSettings();
  tokens: TokenPool = emptyPool();
  memory: MemoryState = { text: "", history: [] };

  // engine slots by kaggle username
  slots = new Map<string, EngineSlot>();
  // last authoritative outbox state per sid (for final content correction)
  lastOutboxBySid = new Map<string, any>();

  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, "profiles"), { recursive: true });
    this.device = deviceSignature(dataDir);
  }

  // ---- persistence -------------------------------------------------------

  save(domain: "sessions" | "settings" | "tokens" | "memory" | "memhist", delay = 400): void {
    if (delay <= 0) {
      // small critical domains (tokens, memory) flush immediately — other
      // processes (CLI) may read the vault at any moment
      this.flushDomain(domain);
      return;
    }
    const prev = this.saveTimers.get(domain);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(domain, setTimeout(() => {
      this.saveTimers.delete(domain);
      this.flushDomain(domain);
    }, delay));
  }

  private flushDomain(domain: string): void {
    if (!this.profile) return;
    try {
      switch (domain) {
        case "sessions":
          this.profile.writeSessions(this.sessions);
          break;
        case "settings":
          this.profile.writeSettings(this.settings);
          break;
        case "tokens":
          this.profile.writeTokens(this.tokens);
          break;
        case "memory":
          this.profile.writeMemoryText(this.memory.text);
          break;
        case "memhist":
          this.profile.writeMemoryHistory(this.memory.history);
          break;
      }
    } catch {
      /* disk hiccup — retried on next change */
    }
  }

  saveNow(): void {
    if (!this.profile) return;
    try {
      this.profile.writeSessions(this.sessions);
      this.profile.writeSettings(this.settings);
      this.profile.writeTokens(this.tokens);
      this.profile.writeMemoryText(this.memory.text);
      this.profile.writeMemoryHistory(this.memory.history);
    } catch {
      /* best effort */
    }
  }

  // ---- account -----------------------------------------------------------

  hasAccount(): boolean {
    return this.device.account !== null && Profile.exists(join(this.dataDir, "profiles"), this.device.account);
  }

  accountName(): string | null {
    return this.device.account;
  }

  createAccount(name: string, password: string): void {
    if (this.device.account) throw new Error("this device already has an account — log in instead");
    const clean = name.trim();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(clean)) throw new Error("names can use letters, numbers, _ and - (max 32)");
    const p = new Profile(join(this.dataDir, "profiles"), clean);
    p.create(password);
    this.device.account = clean;
    this.writeDevice();
  }

  login(password: string): void {
    if (!this.device.account) throw new Error("no account on this device yet");
    const p = new Profile(join(this.dataDir, "profiles"), this.device.account);
    p.login(password);
    this.profile = p;
    this.sessions = p.readSessions(emptyStore());
    const stored = p.readSettings<Partial<GlobalSettings>>({});
    this.settings = clampSettings({ ...defaultSettings(), ...stored, fancy: { ...defaultSettings().fancy, ...(stored.fancy ?? {}) } });
    this.tokens = p.readTokens(emptyPool());
    this.memory = {
      text: p.readMemoryText(""),
      history: p.readMemoryHistory<MemoryEntry[]>([]),
    };
    this.events.emit("changed");
  }

  logout(): void {
    for (const slot of this.slots.values()) slot.shutdown();
    this.slots.clear();
    this.saveNow();
    this.profile?.logout();
    this.profile = null;
    this.sessions = emptyStore();
    this.tokens = emptyPool();
    this.memory = { text: "", history: [] };
  }

  private writeDevice(): void {
    writeFileSync(join(this.dataDir, "device.json"), JSON.stringify(this.device, null, 2));
  }

  // ---- engines -----------------------------------------------------------

  slotFor(username: string): EngineSlot {
    if (process.env.SHUGGLE_DEBUG) console.error(`[app] slotFor ${username}`);
    let slot = this.slots.get(username);
    if (!slot) {
      const rec = this.tokens.tokens.find((t) => t.id === username);
      if (!rec) throw new Error(`no token for account ${username}`);
      slot = new EngineSlot({
        username,
        secret: rec.secret,
        profile: this.profile?.name ?? "default",
        contextTokens: this.settings.contextTokens,
        afkSeconds: this.settings.afkMinutes * 60,
        events: this.events,
      });
      this.slots.set(username, slot);
      slot.attachRelay();
    }
    return slot;
  }

  /** Pick a token for a session (sticky per session), boot its engine. */
  async ensureEngine(session: SessionData): Promise<EngineSlot> {
    if (!this.profile) throw new Error("not logged in");
    let rec: TokenRecord | undefined;
    if (session.engineUsername) rec = this.tokens.tokens.find((t) => t.id === session.engineUsername);
    if (!rec || rec.state !== "ok") {
      const { poolAutoPick } = await import("./tokens.ts");
      const picked = poolAutoPick(this.tokens, session.engineUsername);
      if (!picked) throw new Error("no usable Kaggle token — add one in Tokens, or wait for the weekly reset");
      rec = picked;
      session.engineUsername = picked.id;
      this.save("sessions");
    }
    const slot = this.slotFor(rec.id);
    return slot;
  }
}
