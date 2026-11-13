// Shuggle — headless UI check.
//
// Drives the real app in a real browser: opens the window, walks the
// settings, toggles things and sends a message. Run with:
//   bun run ui:test
//
// It starts the app itself (a throwaway data dir), so it never touches a
// real profile.

import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
// SHUGGLE_BIN lets the same test run against a release artifact instead of
// the development build.
const BIN = process.env.SHUGGLE_BIN || join(ROOT, "shuggle");
const dataDir = mkdtempSync(join(tmpdir(), "shuggle-ui-"));
const PORT = 8799 + Math.floor(Math.random() * 40);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
}

const app = spawn(BIN, [`--data=${dataDir}`, "serve", `--port=${PORT}`], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let appOut = "";
app.stdout.on("data", (d) => (appOut += d.toString()));
app.stderr.on("data", (d) => (appOut += d.toString()));

async function waitForServer(ms = 20000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let browser: any = null;
try {
  if (!(await waitForServer())) throw new Error("server did not come up:\n" + appOut);
  check("app starts and serves", true);

  // A device account is needed before the UI opens.
  const acc = await fetch(`http://127.0.0.1:${PORT}/api/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "uitester", password: "uitester-pass" }),
  });
  check("device account can be created", acc.ok, `http ${acc.status}`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e?.message ?? e)));
  page.on("console", (m: any) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  check("UI loads", (await page.title()) !== "", `title "${await page.title()}"`);

  // --- the window shell -------------------------------------------------
  const sidebarVisible = await page.locator("aside, .sidebar, #sidebar").first().isVisible().catch(() => false);
  check("sidebar renders", sidebarVisible);
  const composerVisible = await page.locator("#composer textarea, textarea#input, .composer textarea").first().isVisible().catch(() => false);
  check("composer renders", composerVisible);

  // --- settings: the tabs the user asked for ---------------------------
  await page.locator("#btn-settings, [data-act='settings'], .settings-btn").first().click().catch(() => {});
  await page.waitForTimeout(600);
  const dialog = page.locator(".modal, dialog, .sheet").first();
  const dialogOpen = await dialog.isVisible().catch(() => false);
  check("settings opens", dialogOpen);

  if (dialogOpen) {
    const tabs = await dialog.locator(".tab, [data-tab]").allTextContents();
    const names = tabs.map((t: string) => t.trim().toLowerCase());
    check("settings has a skills tab", names.some((n: string) => n.includes("skill")), names.join(", "));
    check("settings has a personalisation tab", names.some((n: string) => n.includes("you") || n.includes("personal")), names.join(", "));

    // skills tab → master switch + a skill editor
    const skillsTab = dialog.locator(".tab, [data-tab]").filter({ hasText: /skill/i }).first();
    await skillsTab.click().catch(() => {});
    await page.waitForTimeout(400);
    const masterSwitch = await dialog.locator("#set-skillsmaster").count();
    check("skills master switch exists", masterSwitch > 0);
    const addBtn = await dialog.locator("#skill-add").isVisible().catch(() => false);
    check("skills can be added", addBtn);

    // personalisation tab → about you + language
    const youTab = dialog.locator(".tab, [data-tab]").filter({ hasText: /you|personal/i }).first();
    await youTab.click().catch(() => {});
    await page.waitForTimeout(400);
    const about = await dialog.locator("#set-about").isVisible().catch(() => false);
    check("'about you' field exists", about);
    const lang = await dialog.locator("#set-langmode").isVisible().catch(() => false);
    check("language setting exists", lang);
    const tz = await dialog.locator("#set-tz, #set-timezone, [id*='tz']").first().isVisible().catch(() => false);
    check("time/location setting exists", tz);

    // model tab → vision
    const modelTab = dialog.locator(".tab, [data-tab]").filter({ hasText: /model/i }).first();
    await modelTab.click().catch(() => {});
    await page.waitForTimeout(400);
    const vision = await dialog.locator("#set-vision").count();
    check("vision toggle exists", vision > 0);

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }

  // --- sending a message must not blow up ------------------------------
  const box = page.locator("textarea").first();
  if (await box.isVisible().catch(() => false)) {
    await box.fill("hello from the UI test");
    await box.press("Enter").catch(() => {});
    await page.waitForTimeout(1500);
    const bubbles = await page.locator(".msg, .message, .bubble").count();
    check("a message can be sent and is rendered", bubbles > 0, `${bubbles} bubbles`);
    const emptyResponse = await page.locator(".msg.assistant:empty, .assistant .empty").count();
    check("no empty assistant bubble is shown", emptyResponse === 0);
  } else {
    check("composer usable", false, "no textarea found");
  }

  // --- retry/edit affordances on user messages -------------------------
  const userMsg = page.locator(".msg.user").first();
  if (await userMsg.isVisible().catch(() => false)) {
    const titles = await userMsg.locator("button").evaluateAll((els: any[]) =>
      els.map((e) => `${e.getAttribute("title") || ""} ${e.textContent || ""}`),
    );
    const flat = titles.join(" ").toLowerCase();
    check("user message can be edited", flat.includes("edit"), titles.join(" | "));
    check("user message can be retried", flat.includes("retry") || flat.includes("regenerate"), titles.join(" | "));
    check("user message can be branched", flat.includes("branch"), titles.join(" | "));
  } else {
    check("user message rendered", false);
  }

  check("no uncaught JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await page.screenshot({ path: join(ROOT, "build", "ui-test.png"), fullPage: false }).catch(() => {});
  console.log("\nscreenshot: build/ui-test.png");
} catch (e: any) {
  check("test run", false, String(e?.message ?? e));
} finally {
  if (browser) await browser.close().catch(() => {});
  app.kill("SIGTERM");
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
