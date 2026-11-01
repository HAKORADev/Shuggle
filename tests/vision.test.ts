// Shuggle — live vision check.
//
// Sends a real image through the whole stack and asks the model what it
// sees. Needs a Kaggle token in the data dir and a model on the account.
//
//   bun tests/vision.test.ts --data=<dir> --password=<pw> [--image=<file>]

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const arg = (name: string, def = ""): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const dataDir = arg("data");
const password = arg("password");
const imagePath = arg("image", join(ROOT, "build", "test_image.png"));
const PORT = 8900 + Math.floor(Math.random() * 60);

if (!dataDir || !password) {
  console.log("usage: bun tests/vision.test.ts --data=<dir> --password=<pw> [--image=<png>]");
  process.exit(2);
}
if (!existsSync(imagePath)) {
  console.log(`no image at ${imagePath} — create one first`);
  process.exit(2);
}

const app = spawn(join(ROOT, "shuggle"), [`--data=${dataDir}`, "serve", `--port=${PORT}`], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
app.stdout.on("data", (d) => (out += d.toString()));
app.stderr.on("data", (d) => (out += d.toString()));

const base = `http://127.0.0.1:${PORT}`;
async function api(method: string, path: string, body?: any): Promise<any> {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({}));
}

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
};

try {
  // wait for the server
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try {
      const r = await fetch(base + "/api/health");
      up = r.ok;
    } catch {
      /* not yet */
    }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error("server did not start:\n" + out);

  const login = await api("POST", "/api/login", { password });
  check("logged in", !login.error, login.error ?? "");

  // vision on, globally
  const put = await api("PUT", "/api/settings", {
    vision: { enabled: true, maxImages: 2, imageMaxMB: 8, videoMaxMB: 30, maxFrames: 4, frameSeconds: 2 },
  });
  check("vision enabled in settings", !!put.settings?.vision?.enabled);

  const created = await api("POST", "/api/sessions", {});
  const sid = created.session?.id;
  check("chat created", !!sid);
  if (!sid) throw new Error("no session");

  await api("PATCH", `/api/sessions/${sid}`, { visionEnabled: true });

  const b64 = readFileSync(imagePath).toString("base64");
  const sent = await api("POST", `/api/sessions/${sid}/send`, {
    text: "What do you see in this image? Answer in one short sentence.",
    media: [{ name: "test_image.png", kind: "image", dataB64: b64 }],
  });
  check("image accepted", !sent.error, sent.error ?? "");

  // wait for the answer (the engine may need minutes to boot)
  const deadline = Date.now() + 15 * 60_000;
  let answer = "";
  let visionEvent = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const full = await api("GET", `/api/sessions/${sid}`);
    const sess = full.session;
    if (!sess) continue;
    const ids: string[] = [];
    let cur = sess.activeRoot;
    while (cur) {
      ids.push(cur);
      cur = sess.activeChild[cur] ?? null;
    }
    for (const id of ids) {
      const n = sess.nodes[id];
      if (n?.role === "assistant" && n.content) answer = n.content;
      if (n?.error) {
        check("reply", false, n.error);
        break;
      }
    }
    const engines = (await api("GET", "/api/app")).engines ?? [];
    for (const e of engines) if (e.vision === "ready") visionEvent = "ready";
    if (answer) break;
  }

  check("model replied about the image", answer.length > 0, answer.slice(0, 200));
  check("engine reported vision ready", visionEvent === "ready", visionEvent || "no vision-ready event");
  if (answer) console.log("\n  answer: " + answer.slice(0, 400) + "\n");
} catch (e: any) {
  failed++;
  console.log(" FAIL " + String(e?.message ?? e));
} finally {
  app.kill("SIGTERM");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall vision checks passed");
process.exit(failed ? 1 : 0);
