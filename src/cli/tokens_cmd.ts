// Shuggle — tokens command: add / list / remove Kaggle tokens.

import { api, connectServer, Bridge, question, promptHidden } from "./bridge.ts";
import { MAX_TOKENS } from "../core/tokens.ts";

export async function runTokensCommand(opts: { dataDir: string; args: string[] }): Promise<void> {
  const [verb, ...rest] = opts.args;
  let bridge: Bridge;
  try {
    bridge = await connectServer(opts.dataDir);
  } catch (e: any) {
    console.error(`  ${e.message}`);
    process.exit(1);
  }
  const a = api(bridge.port);

  switch (verb) {
    case "add": {
      let secret = rest.join(" ").trim();
      if (!secret) {
        console.log("\n  Create a token at kaggle.com/settings → API → Create New Token (Token API, KGAT).");
        secret = await promptHidden("  paste it here: ");
      }
      const r = (await a.post("/api/tokens", { secret })) as any;
      if (r.error) {
        console.error(`  ${r.error}`);
        process.exit(1);
      }
      const q = r.quota;
      console.log(`  Added ${r.username}${q ? ` — ${q.usedHours.toFixed(1)}h used of ${q.totalHours.toFixed(0)}h this week` : ""}`);
      process.exit(0);
    }
    case "list": {
      const app = (await a.get("/api/app")) as any;
      if (!app.tokens.length) {
        console.log(`\n  No tokens yet. Add one: shuggle tokens add <token>  (max ${MAX_TOKENS})\n`);
        process.exit(0);
      }
      console.log("");
      app.tokens.forEach((t: any, i: number) => {
        const pct = t.totalHours ? Math.round((t.usedHours / t.totalHours) * 100) : 0;
        console.log(`  ${i + 1}. ${t.id} — ${t.usedHours.toFixed(1)}h / ${t.totalHours.toFixed(0)}h (${pct}%) — ${t.state}${t.resetAt ? `, resets ${t.resetAt.slice(0, 10)}` : ""}`);
      });
      console.log("");
      process.exit(0);
    }
    case "remove": {
      const user = rest.join(" ").trim();
      if (!user) {
        console.log("  Usage: shuggle tokens remove <username>");
        process.exit(1);
      }
      await a.del("/api/tokens", { username: user });
      console.log(`  Removed ${user}`);
      process.exit(0);
    }
    default:
      console.log(`
  Usage:
    shuggle tokens add <token>    add a Kaggle token (or paste it when asked)
    shuggle tokens list           show the pool, quotas and states
    shuggle tokens remove <user>  remove one
`);
      process.exit(0);
  }
}
