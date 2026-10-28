// Shuggle — one-line mode: ask once, get the answer. VODER-style plain orders.

import { banner } from "../banner.ts";
import { fmtDuration } from "../core/util.ts";
import { api, connectServer, Bridge } from "./bridge.ts";

export async function runOneLine(opts: { dataDir: string; args: string[] }): Promise<void> {
  const args = opts.args.filter((a) => a !== "chat");
  let chatIndex: number | null = null;
  if (/^\d+$/.test(args[0] ?? "")) {
    chatIndex = parseInt(args[0], 10);
    args.shift();
  }
  const text = args.join(" ").trim();
  if (!text) {
    console.log(banner());
    console.log(`
  Usage:
    shuggle chat "your question"
    shuggle chat 2 "ask in chat #2"        (see /list or shuggle status)

  For a back-and-forth conversation, use: shuggle cli`);
    process.exit(0);
  }

  let bridge: Bridge;
  try {
    bridge = await connectServer(opts.dataDir);
  } catch (e: any) {
    console.error(`  ${e.message}`);
    process.exit(1);
  }
  const a = api(bridge.port);

  // target chat: by index, or the newest, or a fresh one
  const list = ((await a.get("/api/sessions")) as any).sessions ?? [];
  let target = chatIndex !== null ? list[chatIndex - 1] : list[0];
  if (!target) {
    const created = (await a.post("/api/sessions", {})) as any;
    target = created.session;
  }

  const r = (await a.post(`/api/sessions/${target.id}/send`, { text })) as any;
  if (r.error) {
    console.error(`  ${r.error}`);
    process.exit(1);
  }

  // stream the answer
  const t0 = Date.now();
  let printed = 0;
  let thinkPrinted = 0;
  process.stdout.write("\n");
  while (Date.now() - t0 < 15 * 60_000) {
    await new Promise((r2) => setTimeout(r2, 700));
    const full = (await a.get(`/api/sessions/${target.id}`)) as any;
    const sess = full?.session;
    if (!sess) break;
    if (r.userMsgId && sess.nodes[r.userMsgId]?.error) {
      console.error(`  ${sess.nodes[r.userMsgId].error}`);
      process.exit(1);
    }
    const ids: string[] = [];
    let cur = sess.activeRoot;
    while (cur) {
      ids.push(cur);
      cur = sess.activeChild[cur] ?? null;
    }
    const uIdx = ids.indexOf(r.userMsgId);
    const assistant = ids
      .slice(uIdx + 1)
      .map((id: string) => sess.nodes[id])
      .find((n: any) => n?.role === "assistant");
    if (!assistant) continue;
    const think = assistant.thinking ?? "";
    const body = assistant.content ?? "";
    if (think.length > thinkPrinted) {
      process.stdout.write(`\r\x1b[2m  · ${think.slice(-72).replace(/\n/g, " ")}\x1b[0m`);
      thinkPrinted = think.length;
    }
    if (body.length > printed) {
      process.stdout.write("\r" + " ".repeat(90) + "\r");
      process.stdout.write(body.slice(printed));
      printed = body.length;
    }
    if (assistant.genMs != null) {
      process.stdout.write(`\n  \x1b[2m${fmtDuration(assistant.genMs)}\x1b[0m\n\n`);
      process.exit(0);
    }
    if (assistant.error) {
      process.stdout.write("\n");
      console.error(`  ${assistant.error}`);
      process.exit(1);
    }
  }
  console.error("\n  Timed out waiting for the reply.");
  process.exit(1);
}

export async function runStatus(opts: { dataDir: string }): Promise<void> {
  let bridge: Bridge;
  try {
    bridge = await connectServer(opts.dataDir);
  } catch (e: any) {
    console.error(`  ${e.message}`);
    process.exit(1);
  }
  const a = api(bridge.port);
  const app = (await a.get("/api/app")) as any;
  console.log(`\n  Account: ${app.account}`);
  console.log(`  Tokens: ${app.tokens.length}`);
  app.tokens.forEach((t: any, i: number) => {
    const pct = t.totalHours ? Math.round((t.usedHours / t.totalHours) * 100) : 0;
    console.log(`    ${i + 1}. ${t.id} — ${t.usedHours.toFixed(1)}h / ${t.totalHours.toFixed(0)}h (${pct}%) — ${t.state}`);
  });
  if (app.engines.length) {
    console.log("  Engines:");
    for (const e of app.engines) console.log(`    ${e.username}: ${e.state}${e.error ? ` — ${e.error}` : ""}`);
  } else {
    console.log("  Engines: none running (they wake when you chat)");
  }
  console.log(`  Chats: ${app.sessions.length}\n`);
  process.exit(0);
}
