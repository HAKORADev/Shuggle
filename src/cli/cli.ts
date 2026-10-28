// Shuggle — interactive CLI: simple verbs, streaming answers, the banner.

import { banner } from "../banner.ts";
import { fmtDuration } from "../core/util.ts";
import { api, connectServer, Bridge, question, promptHidden } from "./bridge.ts";
import { VERSION } from "../version.ts";

interface AppSnapshot {
  account: string | null;
  tokens: { id: string; state: string; usedHours: number; totalHours: number; resetAt: string }[];
  engines: { username: string; state: string; error: string | null }[];
  sessions: { id: string; name: string; pinned: boolean; messageCount: number; updatedAt: number }[];
}

let session: { id: string; name: string } | null = null;
let generating = false;
let genStart = 0;

export async function runInteractiveCli(opts: { dataDir: string }): Promise<void> {
  console.log(banner());
  let bridge: Bridge;
  try {
    bridge = await connectServer(opts.dataDir);
  } catch (e: any) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
  const a = api(bridge.port);
  const snap = (await a.get("/api/app")) as AppSnapshot;
  console.log(`\n  Signed in as ${snap.account}. Chat #1 is ready — type to talk, /help for commands.\n`);

  // pick the most recent chat, or make one
  const list = snap.sessions;
  if (list.length) {
    session = { id: list[0].id, name: list[0].name };
  } else {
    const created = (await a.post("/api/sessions", {})) as any;
    session = { id: created.id, name: created.session.name };
  }
  printCurrent(a);

  const { getRl, isPiped, initPiped, nextPipedLine } = await import("./bridge.ts");
  const rl = getRl();

  const tick = setInterval(() => {
    if (generating) {
      const secs = ((Date.now() - genStart) / 1000).toFixed(0);
      process.stdout.write(`\r    thinking… ${secs}s`);
    }
  }, 1000);

  if (isPiped()) {
    // Deterministic line processing for piped input (scripts / tests)
    initPiped();
    while (true) {
      const line = nextPipedLine();
      if (line === null) break;
      const t = line.trim();
      if (t === "exit" || t === "/exit" || t === "quit") break;
      if (!t) continue;
      await handle(t, a, rl);
    }
    clearInterval(tick);
    console.log("\n  Goodbye.");
    process.exit(0);
  }

  rl.on("line", async (line: string) => {
    await handle(line, a, rl);
  });
  rl.on("close", async () => {
    clearInterval(tick);
    console.log("\n  Goodbye.");
    process.exit(0);
  });
}

function printCurrent(a: ReturnType<typeof api>): void {
  if (session) console.log(`  [${session.name}]`);
}

async function refreshTitle(a: ReturnType<typeof api>): Promise<void> {
  if (!session) return;
  const full = (await a.get(`/api/sessions/${session.id}`)) as any;
  if (full?.session) session.name = full.session.name;
}

async function handle(line: string, a: ReturnType<typeof api>, rl: any): Promise<void> {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }
  if (text.startsWith("/")) {
    await command(text, a);
    return;
  }
  if (!session) {
    const created = (await a.post("/api/sessions", {})) as any;
    session = { id: created.id, name: created.session.name };
  }
  await say(text, a);
}

async function say(text: string, a: ReturnType<typeof api>): Promise<void> {
  if (!session || generating) return;
  generating = true;
  genStart = Date.now();
  let have = { text: "", think: "" };
  try {
    // listen to the stream for this reply
    const es = new EventSource(`http://127.0.0.1:${(a as any).port ?? ""}`);
    // EventSource with port unknown here — use closure instead:
  } catch {
    /* fall through to polling */
  }
  const r = (await a.post(`/api/sessions/${session!.id}/send`, { text })) as any;
  if (r.error) {
    console.log(`\n  ${r.error}\n`);
    generating = false;
    return;
  }
  await streamReply(r.userMsgId, a);
  await refreshTitle(a);
  printCurrent(a);
}

async function streamReply(userMsgId: string | null, a: ReturnType<typeof api>): Promise<void> {
  // We poll the session until the assistant node has content and genMs set.
  const t0 = Date.now();
  let printed = 0;
  let printedThink = 0;
  let lastLen = -1;
  process.stdout.write("\n");
  while (Date.now() - t0 < 15 * 60_000) {
    await new Promise((r) => setTimeout(r, 700));
    const full = (await a.get(`/api/sessions/${session!.id}`)) as any;
    if (!full?.session) break;
    const nodes = full.session.nodes;
    const activeChild = full.session.activeChild;
    // walk to find the assistant reply after userMsgId
    const ids = walkIds(full.session);
    const uIdx = userMsgId ? ids.indexOf(userMsgId) : ids.length - 2;
    const after = ids.slice(uIdx + 1);
    const assistant = after.map((id) => nodes[id]).find((n) => n && n.role === "assistant");
    if (!assistant) continue;
    const think = assistant.thinking ?? "";
    const body = assistant.content ?? "";
    if (think.length > printedThink) {
      process.stdout.write(`\r\x1b[2m  · ${think.slice(printedThink).replace(/\n/g, " ").slice(-77)}\x1b[0m`);
      printedThink = think.length;
    }
    if (body.length > printed) {
      process.stdout.write("\r" + " ".repeat(90) + "\r");
      process.stdout.write(body.slice(printed));
      printed = body.length;
    }
    if (assistant.genMs !== null && assistant.genMs !== undefined) {
      process.stdout.write(`\n  \x1b[2m${fmtDuration(assistant.genMs)}\x1b[0m\n\n`);
      break;
    }
    if (assistant.error) {
      process.stdout.write(`\n  ! ${assistant.error}\n\n`);
      break;
    }
    lastLen = body.length;
  }
  generating = false;
}

function walkIds(sess: any): string[] {
  const out: string[] = [];
  let cur = sess.activeRoot;
  while (cur) {
    out.push(cur);
    cur = sess.activeChild[cur] ?? null;
  }
  return out;
}

async function command(text: string, a: ReturnType<typeof api>): Promise<void> {
  const [verbRaw, ...rest] = text.slice(1).split(/\s+/);
  const verb = verbRaw.toLowerCase();
  const argStr = rest.join(" ");
  const snap = (await a.get("/api/app")) as AppSnapshot;

  switch (verb) {
    case "help":
      console.log(`
  /new [name]        start a new chat
  /open <n>          open chat #n from /list
  /list              show chats
  /rename <name>     rename the current chat
  /del <n>           delete a chat
  /pin               pin or unpin the current chat
  /search            toggle web search for the current chat
  /think             toggle showing the model's thinking
  /memory            show your memories
  /tokens            show the token pool
  /use <n>           use token #n for the current chat
  /status            engines and quotas
  /sleep             put engines to rest (saves their GPU hours)
  /help              this list
  exit               quit (also Ctrl+C / Ctrl+D)
`);
      break;
    case "new": {
      const r = (await a.post("/api/sessions", argStr ? { name: argStr } : {})) as any;
      session = { id: r.id, name: r.session.name };
      console.log(`  Started "${session.name}"`);
      break;
    }
    case "open": {
      const n = parseInt(rest[0] ?? "", 10);
      const s = snap.sessions[Number.isFinite(n) ? n - 1 : 0];
      if (!s) {
        console.log("  No such chat — try /list");
        break;
      }
      session = { id: s.id, name: s.name };
      console.log(`  Switched to "${s.name}"`);
      break;
    }
    case "list": {
      if (!snap.sessions.length) {
        console.log("  No chats yet — just start typing, or /new");
        break;
      }
      snap.sessions.forEach((s, i) => {
        console.log(`  ${i + 1}${s.pinned ? "*" : " "}. ${s.name} (${s.messageCount} messages)`);
      });
      break;
    }
    case "rename": {
      if (!session || !argStr) break;
      await a.put(`/api/sessions/${session.id}`, { name: argStr });
      session.name = argStr;
      console.log(`  Renamed to "${argStr}"`);
      break;
    }
    case "del": {
      const n = parseInt(rest[0] ?? "", 10);
      const s = snap.sessions[Number.isFinite(n) ? n - 1 : 0];
      if (!s) {
        console.log("  No such chat — try /list");
        break;
      }
      await a.del(`/api/sessions/${s.id}`);
      if (session?.id === s.id) {
        const left = ((await a.get("/api/sessions")) as any).sessions;
        session = left.length ? { id: left[0].id, name: left[0].name } : null;
      }
      console.log(`  Deleted "${s.name}"`);
      break;
    }
    case "pin": {
      if (!session) break;
      const cur = snap.sessions.find((x) => x.id === session!.id);
      await a.put(`/api/sessions/${session.id}`, { pinned: !cur?.pinned });
      console.log(cur?.pinned ? "  Unpinned" : "  Pinned");
      break;
    }
    case "search": {
      if (!session) break;
      const full = (await a.get(`/api/sessions/${session.id}`)) as any;
      const next = !full.session.searchEnabled;
      await a.put(`/api/sessions/${session.id}`, { searchEnabled: next });
      console.log(next ? "  Web search: on" : "  Web search: off");
      break;
    }
    case "think": {
      if (!session) break;
      const full = (await a.get(`/api/sessions/${session.id}`)) as any;
      const next = !full.session.thinkingEnabled;
      await a.put(`/api/sessions/${session.id}`, { thinkingEnabled: next });
      console.log(next ? "  Thinking: shown" : "  Thinking: hidden");
      break;
    }
    case "memory": {
      const app = (await a.get("/api/app")) as any;
      console.log(app.memory ? `  ${app.memory}\n` : "  Memory is empty. Teach it things in the app, or /memory-set later.");
      break;
    }
    case "tokens": {
      if (!snap.tokens.length) {
        console.log("  No tokens yet — add one with: shuggle tokens add <token>");
        break;
      }
      snap.tokens.forEach((t, i) => {
        const pct = t.totalHours ? Math.round((t.usedHours / t.totalHours) * 100) : 0;
        console.log(`  ${i + 1}. ${t.id} — ${t.usedHours.toFixed(1)}h / ${t.totalHours.toFixed(0)}h (${pct}%) — ${t.state}`);
      });
      break;
    }
    case "use": {
      const n = parseInt(rest[0] ?? "", 10);
      const t = snap.tokens[Number.isFinite(n) ? n - 1 : -1];
      if (!t || !session) {
        console.log("  /use <n> — pick a token number from /tokens");
        break;
      }
      await a.put(`/api/sessions/${session.id}`, {});
      // bind by waking this engine then flagging the session
      await a.post("/api/engine/wake", { username: t.id });
      console.log(`  Using ${t.id} for "${session.name}"`);
      break;
    }
    case "status": {
      const app = (await a.get("/api/app")) as any;
      if (!app.engines.length) console.log("  No engine running. Send a message and it wakes up automatically.");
      for (const e of app.engines) {
        console.log(`  ${e.username}: ${e.state}${e.error ? ` — ${e.error}` : ""}`);
      }
      break;
    }
    case "sleep": {
      await a.post("/api/engine/sleep");
      console.log("  Engines are resting. Their GPU hours are yours again.");
      break;
    }
    case "exit":
      console.log("  Goodbye.");
      process.exit(0);
      break;
    default:
      console.log(`  Unknown command /${verb} — /help shows the list`);
  }
}
