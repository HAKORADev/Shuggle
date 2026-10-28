// Shuggle — profile store: one account per device, password-gated, encrypted at rest.
//
// Layout:
//   <data>/device.json                      { installId, signature, account }
//   <data>/profiles/<name>/auth.json        { salt, verifier, kdf, createdAt }
//   <data>/profiles/<name>/vault.*          AES-256-GCM sealed JSON domains
//   <data>/profiles/<name>/downloads/...
//
// The vault key is derived from the password (scrypt). The verifier proves the
// password without storing it. Sessions, tokens, settings and memory all live
// encrypted inside the vault — "sessions in the folder but with an extra layer".

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";

export interface DeviceIdentity {
  installId: string;
  signature: string;
  account: string | null;
}

export interface ProfileMeta {
  name: string;
  createdAt: number;
  lastLoginAt: number;
}

export class StoreError extends Error {}

export function deviceSignature(dataDir: string): DeviceIdentity {
  const file = join(dataDir, "device.json");
  let dev: DeviceIdentity;
  if (existsSync(file)) {
    try {
      dev = JSON.parse(readFileSync(file, "utf8"));
      return dev;
    } catch {
      /* corrupt — regenerate */
    }
  }
  const installId = randomBytes(16).toString("hex");
  let machine = "";
  try {
    // Best-effort machine fingerprint; on platforms without a machine id the
    // install id alone still identifies this device.
    if (process.platform === "linux") machine = readFileSync("/etc/machine-id", "utf8").trim();
  } catch {
    /* ignore */
  }
  const signature = createHash("sha256").update(`${machine}|${installId}|shuggle-device`).digest("hex");
  dev = { installId, signature, account: null };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(dev, null, 2));
  return dev;
}

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize("NFKC"), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const DOMAIN_MARKER = "shuggle-vault-ok";

function seal(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function unseal(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

export class Profile {
  readonly name: string;
  readonly dir: string;
  private key: Buffer | null = null;

  constructor(readonly profilesDir: string, name: string) {
    this.name = name;
    this.dir = join(profilesDir, name);
  }

  static exists(profilesDir: string, name: string): boolean {
    return existsSync(join(profilesDir, name, "auth.json"));
  }

  static list(profilesDir: string): string[] {
    try {
      return existsSync(profilesDir)
        ? listProfileDirs(profilesDir).filter((n) => Profile.exists(profilesDir, n))
        : [];
    } catch {
      return [];
    }
  }

  authFile(): string {
    return join(this.dir, "auth.json");
  }

  exists(): boolean {
    return Profile.exists(this.profilesDir, this.name);
  }

  create(password: string): void {
    if (this.exists()) throw new StoreError(`an account named "${this.name}" already exists on this device`);
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(join(this.dir, "downloads"), { recursive: true });
    const salt = randomBytes(16);
    const key = derive(password, salt);
    const verifier = seal(key, DOMAIN_MARKER);
    writeFileSync(
      this.authFile(),
      JSON.stringify({ salt: salt.toString("base64"), verifier: verifier.toString("base64"), kdf: "scrypt-N16384-r8-p1", createdAt: Date.now() }, null, 2),
    );
    this.key = key;
  }

  login(password: string): void {
    const auth = JSON.parse(readFileSync(this.authFile(), "utf8"));
    const salt = Buffer.from(auth.salt, "base64");
    const verifier = Buffer.from(auth.verifier, "base64");
    const key = derive(password, salt);
    let ok = false;
    try {
      ok = unseal(key, verifier) === DOMAIN_MARKER;
    } catch {
      ok = false;
    }
    if (!ok) throw new StoreError("wrong password");
    this.key = key;
    const meta = JSON.stringify({ ...auth, lastLoginAt: Date.now() });
    writeFileSync(this.authFile(), meta);
  }

  logout(): void {
    this.key = null;
  }

  unlocked(): boolean {
    return this.key !== null;
  }

  private writeDomain(domain: string, value: any): void {
    if (!this.key) throw new StoreError("profile is locked");
    const blob = seal(this.key, JSON.stringify(value));
    writeFileSync(join(this.dir, `vault.${domain}`), blob);
  }

  private readDomain<T>(domain: string, fallback: T): T {
    if (!this.key) throw new StoreError("profile is locked");
    const f = join(this.dir, `vault.${domain}`);
    if (!existsSync(f)) return fallback;
    try {
      return JSON.parse(unseal(this.key, readFileSync(f))) as T;
    } catch {
      return fallback;
    }
  }

  // ---- domains -----------------------------------------------------------

  readTokens<T>(fallback: T): T {
    return this.readDomain("tokens", fallback);
  }
  writeTokens(v: any): void {
    this.writeDomain("tokens", v);
  }
  readSettings<T>(fallback: T): T {
    return this.readDomain("settings", fallback);
  }
  writeSettings(v: any): void {
    this.writeDomain("settings", v);
  }
  readSessions<T>(fallback: T): T {
    return this.readDomain("sessions", fallback);
  }
  writeSessions(v: any): void {
    this.writeDomain("sessions", v);
  }
  readMemoryText(fallback: string): string {
    return this.readDomain("memory", { text: fallback }).text;
  }
  writeMemoryText(text: string): void {
    this.writeDomain("memory", { text });
  }
  readMemoryHistory<T>(fallback: T): T {
    return this.readDomain("memhist", fallback);
  }
  writeMemoryHistory(v: any): void {
    this.writeDomain("memhist", v);
  }

  downloadsDir(): string {
    const d = join(this.dir, "downloads");
    mkdirSync(d, { recursive: true });
    return d;
  }

  sessionDownloadsDir(sessionId: string): string {
    const d = join(this.downloadsDir(), sessionId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function listProfileDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
