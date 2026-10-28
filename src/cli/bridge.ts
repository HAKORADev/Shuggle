// Shuggle — CLI shared plumbing: reuse a running Shuggle server (GUI or
// another CLI) or start an embedded one. CLI and GUI always agree on state.

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Server } from "../server/server.ts";

export interface Bridge {
  port: number;
  owned: boolean; // did we start it inside this process?
}

const lockName = "server.json";

export async function connectServer(dataDir: string): Promise<Bridge> {
  const lockFile = join(dataDir, lockName);
  // 1. try an existing server (health-checked — stale locks are taken over)
  const claimed = await Server.claimLock(dataDir, 0, process.pid).catch(() => null);
  if (claimed?.existing) {
    const port = claimed.port;
    const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    if (st.loggedIn) return { port, owned: false };
    // running but locked — ask for the password and log in
    const password = await promptHidden("  password: ");
    const lr = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!lr.ok) {
      const j = await lr.json().catch(() => ({ error: "login failed" }));
      throw new Error(j.error ?? "login failed");
    }
    return { port, owned: false };
  }
  // 2. start an embedded server (we now hold the lock on a fresh port)
  const { pickFreePort } = await import("../launch.ts");
  const port = claimed ? claimed.port : await pickFreePort(8690);
  await Server.claimLock(dataDir, port, process.pid);
  const server = new Server({
    dataDir,
    port,
    lan: false,
    appWindow: false,
    onExit: () => process.exit(0),
  });
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    fetch: (req) => server.handle(req),
  });
  server.startPings();
  // process state check + login if needed
  const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  if (!st.hasAccount) {
    throw new Error("no account on this device yet — run `shuggle` once to create one");
  }
  if (!st.loggedIn) {
    const password = await promptHidden("  password: ");
    const lr = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!lr.ok) {
      const j = await lr.json().catch(() => ({ error: "login failed" }));
      throw new Error(j.error ?? "login failed");
    }
  }
  writeFileSync(lockFile, JSON.stringify({ port, pid: process.pid }));
  process.on("exit", () => Server.releaseLock(dataDir, process.pid));
  return { port, owned: true };
}

export function api(port: number) {
  const base = `http://127.0.0.1:${port}`;
  return {
    get: (p: string) => fetch(base + p).then((r) => r.json()),
    post: (p: string, body?: any) =>
      fetch(base + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json()),
    put: (p: string, body?: any) =>
      fetch(base + p, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json()),
    del: (p: string, body?: any) =>
      fetch(base + p, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json()),
  };
}

// One readline for the whole process — multiple interfaces on the same stdin
// steal each other's lines (bitten us in testing).
let sharedRl: any = null;
export function getRl(): any {
  if (!sharedRl) {
    sharedRl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  }
  return sharedRl;
}

// Piped (non-TTY) input: buffer everything up front, serve lines deterministically.
let pipedLines: string[] | null = null;
export function isPiped(): boolean {
  return process.stdin.isTTY !== true;
}
export function initPiped(): void {
  if (!isPiped() || pipedLines) return;
  try {
    const all = readFileSync(0, "utf8");
    pipedLines = all.split("\n");
  } catch {
    pipedLines = [];
  }
}
export function nextPipedLine(): string | null {
  if (!pipedLines) return null;
  const l = pipedLines.shift();
  return l === undefined ? null : l;
}

export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (isPiped()) {
      process.stdout.write(question);
      resolve((nextPipedLine() ?? "").trim());
      return;
    }
    const rl = getRl();
    const origWrite = (rl as any)._writeToOutput?.bind(rl);
    (rl as any)._writeToOutput = (s: string) => {
      // mask everything except newlines
      const masked = s.replace(/[^\n\r]/g, "*");
      rl.output.write(masked);
    };
    process.stdout.write(question);
    rl.question("", (answer: string) => {
      if (origWrite) (rl as any)._writeToOutput = origWrite;
      resolve(answer);
    });
  });
}

export function question(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = getRl();
    rl.question(q, (a: string) => resolve(a));
  });
}

export function resumeInput(): void {
  process.stdin.resume();
}
