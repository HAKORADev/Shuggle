// Shuggle — single executable entry point.
//
//   shuggle              → GUI (local server + app window)
//   shuggle serve        → local server only (add --lan to share on your network)
//   shuggle cli          → interactive chat in the terminal
//   shuggle chat [id] …  → one-line chat
//   shuggle tokens …     → manage Kaggle tokens
//   shuggle account      → create this device's account
//   shuggle status       → engines at a glance
//   shuggle help         → this list
//
// argv dispatch happens FIRST — nothing else runs before it.
//
// Windows console model: the exe is compiled as a CONSOLE-subsystem binary
// (so `shuggle cli` from cmd/PowerShell works with real stdio), and GUI mode
// hides its console window at startup (no black box behind the app window).
// Console verbs (cli/chat/tokens/status/help/version) keep the console.

import { join, dirname } from "node:path";
import { VERSION } from "./version.ts";
import { printBanner } from "./banner.ts";
import { Server } from "./server/server.ts";
import { openAppWindow, pickFreePort, localUrls, lanUrls, detachConsole } from "./launch.ts";

function arg(i: number): string | undefined {
  return process.argv[i];
}

// Global flags may appear BEFORE the command (launchers pass --data=…), so
// they are pulled out first. Anything else is positional and belongs to the
// command — a chat message may legitimately start with a dash.
const RAW_ARGS = process.argv.slice(2);
const GLOBAL_FLAG_PREFIXES = ["--data=", "--port="];
const GLOBAL_FLAGS = ["--lan", "lan", "--version", "-v"];
const args: string[] = [];
const globals: string[] = [];
for (const a of RAW_ARGS) {
  if (GLOBAL_FLAG_PREFIXES.some((p) => a.startsWith(p)) || GLOBAL_FLAGS.includes(a)) globals.push(a);
  else args.push(a);
}
const hasFlag = (f: string) => globals.includes(f);

function dataDir(): string {
  const custom = globals.find((a) => a.startsWith("--data="))?.split("=")[1];
  if (custom) return custom;
  // Next to the executable, like every HAKORA tool: one folder, everything inside.
  const invoked = process.argv[1] ?? "";
  const devMode = invoked.endsWith(".ts") || invoked.endsWith(".js");
  return devMode ? join(process.cwd(), "ShuggleData") : join(dirname(process.execPath), "ShuggleData");
}

/** Hide the console window this process inherited (Windows, GUI mode only).
 *  The exe stays console-subsystem so terminal commands keep real stdio. */
function hideWindowsConsole(): void {
  if (process.platform !== "win32") return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, suffix } = require("bun:ffi");
    const lib = dlopen(`kernel32.${suffix}`, {
      GetConsoleWindow: { args: [], returns: "ptr" },
      ShowWindow: { args: ["ptr", "i32"], returns: "i32" },
      FreeConsole: { args: [], returns: "i32" },
    });
    const hwnd = lib.symbols.GetConsoleWindow();
    if (hwnd) {
      lib.symbols.ShowWindow(hwnd, 0); // SW_HIDE
      lib.symbols.FreeConsole(); // release the caller's shell
    }
  } catch {
    /* worst case the console stays visible — never worth crashing over */
  }
}

function crashLog(e: unknown): void {
  try {
    const dir = dataDir();
    const fs = require("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    const file = join(dir, "last-error.txt");
    const stamp = new Date().toISOString();
    fs.appendFileSync(file, `[${stamp}] Shuggle failed to start:\n${e?.stack ?? String(e)}\n\n`);
    console.error(`\n  Shuggle hit a problem starting up. Details written to:\n  ${file}\n`);
  } catch {
    console.error(e);
  }
}

function portFromFlags(defaultPort: number): number {
  const p = globals.find((a) => a.startsWith("--port="))?.split("=")[1];
  return p ? parseInt(p, 10) || defaultPort : defaultPort;
}

async function main(): Promise<void> {
  let cmd: string | undefined = args[0];

  if (hasFlag("--version") || hasFlag("-v")) cmd = "version";

  switch (cmd ?? "gui") {
    case "gui":
    case "serve": {
      const isServe = cmd === "serve";
      const lan = hasFlag("--lan") || hasFlag("lan");
      // Hide the inherited console only for the windowed app experience.
      // `serve`/LAN mode keeps it — the user is reading URLs from it.
      if (!isServe && !lan) hideWindowsConsole();
      const port = portFromFlags(lan ? 8680 : await pickFreePort());
      // One data dir, one server — adopt the running one if it's alive.
      const lock = await Server.claimLock(dataDir(), port, process.pid);
      if (lock.existing) {
        printBanner();
        console.log(`\n  Shuggle is already running here:`);
        console.log(`    http://127.0.0.1:${lock.port}\n`);
        if (!isServe && !lan) openAppWindow(`http://127.0.0.1:${lock.port}`);
        return;
      }
      const server = new Server({
        dataDir: dataDir(),
        port,
        lan,
        appWindow: !isServe && !lan,
        onExit: () => process.exit(0),
      });
      const { serve } = await import("bun");
      const srv = Bun.serve({
        port,
        hostname: lan ? "0.0.0.0" : "127.0.0.1",
        idleTimeout: 255, // long engine operations stream via SSE, but keep room
        fetch: (req) => server.handle(req),
      });
      const realPort = srv.port || port;
      // Record the port we actually bound — the lock is what other processes
      // (CLI, second launch) use to find this server.
      await Server.claimLock(dataDir(), realPort, process.pid);
      server.startPings();
      printBanner();
      const urls = lan ? lanUrls(realPort) : localUrls(realPort);
      console.log("");
      if (lan) {
        console.log("  Shuggle is open to your local network:");
      } else {
        console.log("  Shuggle is running:");
      }
      for (const u of urls) console.log(`    ${u}`);
      console.log("");
      if (!isServe && !lan) {
        openAppWindow(urls[0]);
      }
      const stop = async () => {
        await server.context.saveNow();
        Server.releaseLock(dataDir(), process.pid);
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.on("exit", () => Server.releaseLock(dataDir(), process.pid));
      break;
    }
    case "cli": {
      const { initPiped } = await import("./cli/bridge.ts");
      await initPiped();
      const { runInteractiveCli } = await import("./cli/cli.ts");
      await runInteractiveCli({ dataDir: dataDir() });
      break;
    }
    case "chat": {
      const { initPiped } = await import("./cli/bridge.ts");
      await initPiped();
      const { runOneLine } = await import("./cli/oneline.ts");
      await runOneLine({ dataDir: dataDir(), args: args.slice(1) });
      break;
    }
    case "tokens": {
      const { initPiped } = await import("./cli/bridge.ts");
      await initPiped();
      const { runTokensCommand } = await import("./cli/tokens_cmd.ts");
      await runTokensCommand({ dataDir: dataDir(), args: args.slice(1) });
      break;
    }
    case "account": {
      const { initPiped } = await import("./cli/bridge.ts");
      initPiped();
      const { runAccountCommand } = await import("./cli/account_cmd.ts");
      await runAccountCommand({ dataDir: dataDir() });
      break;
    }
    case "status": {
      const { initPiped } = await import("./cli/bridge.ts");
      await initPiped();
      const { runStatus } = await import("./cli/oneline.ts");
      await runStatus({ dataDir: dataDir() });
      break;
    }
    case "version":
      console.log(`Shuggle v${VERSION}`);
      break;
    case "help":
    case "--help":
    case "-h":
    default: {
      printBanner();
      console.log(`
  Usage:
    shuggle                    Open the app
    shuggle serve --lan        Share on your local network (others open it in a browser)
    shuggle serve              Keep the server running without a window
    shuggle cli                Chat right here in the terminal
    shuggle chat "text"        Ask once and get the answer
    shuggle chat 3 "text"      Ask in chat #3
    shuggle tokens add <tok>   Add a Kaggle token
    shuggle tokens list        Show the token pool
    shuggle account            Create this device's account
    shuggle status             Engines at a glance
    shuggle help               Show this help

  Everything lives next to the executable, in ShuggleData/. Your data never leaves your disk.`);
      break;
    }
  }
}

main().catch((e) => {
  crashLog(e);
  process.exit(1);
});
