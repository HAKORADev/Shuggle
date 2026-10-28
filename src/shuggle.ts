// Shuggle — single executable entry point.
//
//   shuggle              → GUI (local server + app window)
//   shuggle serve        → local server only (add --lan to share on your network)
//   shuggle cli          → interactive chat in the terminal
//   shuggle chat [id] …  → one-line chat
//   shuggle tokens …     → manage Kaggle tokens
//   shuggle status       → engines at a glance
//   shuggle help         → this list
//
// argv dispatch happens FIRST — nothing else runs before it.

import { join, dirname } from "node:path";
import { VERSION } from "./version.ts";
import { printBanner } from "./banner.ts";
import { Server } from "./server/server.ts";
import { openAppWindow, pickFreePort, localUrls, lanUrls } from "./launch.ts";

function arg(i: number): string | undefined {
  return process.argv[i];
}
const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);

function dataDir(): string {
  const custom = args.find((a) => a.startsWith("--data="))?.split("=")[1];
  if (custom) return custom;
  // Next to the executable, like every HAKORA tool: one folder, everything inside.
  const invoked = process.argv[1] ?? "";
  const devMode = invoked.endsWith(".ts") || invoked.endsWith(".js");
  if (devMode) return join(process.cwd(), "ShuggleData");
  return join(dirname(process.execPath), "ShuggleData");
}

function portFromFlags(defaultPort: number): number {
  const p = args.find((a) => a.startsWith("--port="))?.split("=")[1];
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
      const port = portFromFlags(lan ? 8680 : await pickFreePort());
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
        fetch: (req) => server.handle(req),
      });
      server.startPings();
      printBanner();
      const urls = lan ? lanUrls(port) : localUrls(port);
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
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      break;
    }
    case "cli": {
      const { initPiped } = await import("./cli/bridge.ts");
      initPiped();
      const { runInteractiveCli } = await import("./cli/cli.ts");
      await runInteractiveCli({ dataDir: dataDir() });
      break;
    }
    case "chat": {
      const { initPiped } = await import("./cli/bridge.ts");
      initPiped();
      const { runOneLine } = await import("./cli/oneline.ts");
      await runOneLine({ dataDir: dataDir(), args: args.slice(1) });
      break;
    }
    case "tokens": {
      const { initPiped } = await import("./cli/bridge.ts");
      initPiped();
      const { runTokensCommand } = await import("./cli/tokens_cmd.ts");
      await runTokensCommand({ dataDir: dataDir(), args: args.slice(1) });
      break;
    }
    case "status": {
      const { initPiped } = await import("./cli/bridge.ts");
      initPiped();
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
    shuggle status             Engines at a glance
    shuggle help               Show this help

  Everything lives next to the executable, in ShuggleData/. Your data never leaves your disk.`);
      break;
    }
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
