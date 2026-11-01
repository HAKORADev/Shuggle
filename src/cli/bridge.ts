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
  // 1. try an existing server
  if (existsSync(lockFile)) {
    try {
      const { port } = JSON.parse(readFileSync(lockFile, "utf8"));
      const r = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
      if (r?.ok) {
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
    } catch (e: any) {
      if (String(e.message).includes("password")) throw e;
    }
  }
  // 2. start an embedded server
  const { pickFreePort } = await import("../launch.ts");
  const port = await pickFreePort(8690);
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
    fetch: (req) => server.handle(req),
  });
  server.startPings();
  // process state check + login/onboarding
  const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  if (!st.hasAccount) {
    // First run on this device — create the account right here, no GUI needed.
    console.log("\n  First run on this device — let's make your Shuggle account.");
    console.log("  One account lives on this device; your data stays in the app folder, encrypted.\n");
    let name = "";
    for (let i = 0; i < 3; i++) {
      name = (await question("  account name: ")).trim();
      if (/^[a-zA-Z0-9_-]{1,32}$/.test(name)) break;
      console.log("  names can use letters, numbers, _ and - (max 32)");
      name = "";
    }
    if (!name) throw new Error("no account name given");
    let pass = await promptHidden("  password: ");
    let pass2 = await promptHidden("  confirm password: ");
    if (pass !== pass2) throw new Error("passwords do not match");
    if (!pass) throw new Error("password cannot be empty");
    const cr = await fetch(`http://127.0.0.1:${port}/api/account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password: pass }),
    });
    if (!cr.ok) {
      const j = await cr.json().catch(() => ({ error: "account creation failed" }));
      throw new Error(j.error ?? "account creation failed");
    }
    console.log(`\n  Welcome, ${name}.\n`);
  } else if (!st.loggedIn) {
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
    patch: (p: string, body?: any) =>
      fetch(base + p, {
        method: "PATCH",
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
