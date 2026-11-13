// Shuggle — unit tests. Run with: bun test
//
// These cover the parts that are pure logic and easy to break silently:
// the prompt builders, the skill/memory machinery, settings clamping,
// namespace scoping and the generated engine script.

import { test, expect } from "bun:test";
import { defaultSkills, sanitizeSkills, activeSkills, skillsPrompt, MAX_SKILL_CHARS } from "../src/core/skills.ts";
import { applyOp, extractMemoryOps, parseMemoryBlocks, serializeMemory, MEMORY_CAP } from "../src/core/memory.ts";
import { defaultSettings, clampSettings, mergeOverride, CONTEXT_MIN, CONTEXT_MAX } from "../src/core/settings.ts";
import { buildSystemPrompt, languageDirective } from "../src/core/sysprompt.ts";
import { profileNamespace } from "../src/core/engine.ts";
import { engineScript } from "../src/core/kernel.ts";
import { hsh16 } from "../src/core/util.ts";


/** The python on this machine — Windows says "python", Linux "python3". */
function pythonCommand(): string | null {
  const { spawnSync } = require("node:child_process");
  for (const c of ["python3", "python"]) {
    try {
      const r = spawnSync(c, ["--version"], { stdio: "pipe" });
      if (r.status === 0) return c;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// ---------------------------------------------------------------- skills ---

test("skills: defaults survive sanitising", () => {
  const s = sanitizeSkills(defaultSkills());
  expect(s.length).toBeGreaterThan(3);
  for (const sk of s) {
    expect(sk.title.length).toBeGreaterThan(0);
    expect(sk.content.length).toBeGreaterThan(0);
    expect(sk.enabled).toBe(false); // all starter skills ship OFF
  }
});

test("skills: junk entries are dropped, not carried", () => {
  const s = sanitizeSkills([{ title: "", content: "x" }, { title: "ok" }, null, "nope", { title: "t", content: "c" }] as any);
  expect(s.length).toBe(1);
  expect(s[0].title).toBe("t");
});

test("skills: content is capped", () => {
  const s = sanitizeSkills([{ title: "big", content: "x".repeat(MAX_SKILL_CHARS + 5000) }] as any);
  expect(s[0].content.length).toBe(MAX_SKILL_CHARS);
});

test("skills: master switch wins over per-skill switch", () => {
  const list = sanitizeSkills([
    { title: "a", content: "A", enabled: true },
    { title: "b", content: "B", enabled: false },
  ]);
  expect(activeSkills(list, true).map((s) => s.title)).toEqual(["a"]);
  expect(activeSkills(list, false).length).toBe(0);
});

test("skills: a session can switch the whole thing off", () => {
  const list = sanitizeSkills([{ title: "a", content: "A", enabled: true }]);
  expect(activeSkills(list, true, false).length).toBe(0);
  expect(activeSkills(list, true, true).length).toBe(1);
});

test("skills: a session can exclude individual skills", () => {
  const list = sanitizeSkills([
    { title: "a", content: "A", enabled: true },
    { title: "b", content: "B", enabled: true },
  ]);
  const on = activeSkills(list, true, true, [list[1].id]);
  expect(on.map((s) => s.title)).toEqual(["a"]);
});

test("skills: the handler prompt teaches the model how to use them", () => {
  const list = sanitizeSkills([{ title: "Arabic care", when: "user writes Arabic", why: "RTL is tricky", content: "Reply in Arabic." , enabled: true }]);
  const p = skillsPrompt(activeSkills(list, true));
  expect(p).toContain("Arabic care");
  expect(p).toContain("Reply in Arabic.");
  expect(p).toContain("when it applies");
  expect(skillsPrompt([])).toBeNull();
});

// ---------------------------------------------------------------- memory ---

test("memory: round-trips through the block format", () => {
  const text = "## my note #abc12\nI like tea.\n\n## other #def34\nSecond one.";
  const blocks = parseMemoryBlocks(text);
  expect(blocks.length).toBe(2);
  expect(blocks[0].id).toBe("abc12");
  expect(blocks[0].text).toBe("I like tea.");
  expect(serializeMemory(blocks.map((b) => ({ id: b.id, name: b.name, text: b.text, updatedAt: 0 })))).toContain("I like tea.");
});

test("memory: create / edit / delete / undo", () => {
  let text = "";
  let history: any[] = [];
  const c = applyOp(text, history, { op: "create", name: "drink", content: "tea" });
  expect(c.ok).toBe(true);
  text = c.text;
  history = c.history;
  expect(text).toContain("tea");

  const e = applyOp(text, history, { op: "edit", name: "drink", content: "coffee" });
  expect(e.ok).toBe(true);
  expect(e.text).toContain("coffee");

  const d = applyOp(e.text, e.history, { op: "delete", name: "drink" });
  expect(d.ok).toBe(true);
  expect(d.text).not.toContain("coffee");

  const u = applyOp(d.text, d.history, { op: "undo" });
  expect(u.ok).toBe(true);
  expect(u.text).toContain("coffee");
});

test("memory: list and list_deleted report the truth", () => {
  let history: any[] = [];
  const c = applyOp("", history, { op: "create", name: "note", content: "hello" });
  history = c.history;
  const l = applyOp(c.text, history, { op: "list" });
  expect(l.result).toContain("hello");
  const d = applyOp(c.text, history, { op: "delete", name: "note" });
  const ld = applyOp(d.text, d.history, { op: "list_deleted" });
  expect(ld.result).toContain("hello");
});

test("memory: a full memory refuses new notes instead of truncating", () => {
  const history: any[] = [];
  const big = "x".repeat(MEMORY_CAP + 100);
  const r = applyOp("", history, { op: "create", name: "huge", content: big });
  expect(r.ok).toBe(false);
  expect(r.result).toMatch(/full/i);
});

test("memory: model output blocks are stripped from the visible reply", () => {
  const out = 'Here you go.\n```memory\n{"op":"create","name":"x","content":"y"}\n```\nDone.';
  const { clean, ops } = extractMemoryOps(out);
  expect(clean).not.toContain("```memory");
  expect(ops.length).toBe(1);
  expect(ops[0].op).toBe("create");
});

test("memory: a broken block never leaks into the visible reply", () => {
  const out = 'text\n```memory\n{not json}\n```\n';
  const { clean, ops } = extractMemoryOps(out);
  expect(clean).not.toContain("{not json}");
  expect(ops.length).toBe(0);
});

// -------------------------------------------------------------- settings ---

test("settings: the context window never drops below the floor", () => {
  expect(clampSettings({ ...defaultSettings(), contextTokens: 1000 }).contextTokens).toBe(CONTEXT_MIN);
  expect(clampSettings({ ...defaultSettings(), contextTokens: 999999 }).contextTokens).toBe(CONTEXT_MAX);
});

test("settings: vision limits stay in a sane range", () => {
  const s = clampSettings({ ...defaultSettings(), vision: { enabled: true, maxImages: 99, imageMaxMB: 999, videoMaxMB: 0, maxFrames: 99, frameSeconds: 0 } });
  expect(s.vision.maxImages).toBeLessThanOrEqual(8);
  expect(s.vision.imageMaxMB).toBeLessThanOrEqual(12);
  expect(s.vision.videoMaxMB).toBeGreaterThanOrEqual(1);
  expect(s.vision.maxFrames).toBeLessThanOrEqual(16);
  expect(s.vision.frameSeconds).toBeGreaterThanOrEqual(1);
});

test("settings: a session override wins over the global value", () => {
  const g = defaultSettings();
  const m = mergeOverride(g, { temperature: 1.4, languageMode: "manual", languageCode: "ar" });
  expect(m.temperature).toBe(1.4);
  expect(m.language.mode).toBe("manual");
  expect(m.language.code).toBe("ar");
});

test("settings: skills are sanitised on load", () => {
  const s = clampSettings({ ...defaultSettings(), skills: [{ title: "", content: "" }] as any });
  expect(s.skills.length).toBe(0);
});

// ------------------------------------------------------------ system prompt ---

test("system prompt: fancy mode carries identity, about-you and language", () => {
  const g = clampSettings({
    ...defaultSettings(),
    aboutYou: "I build tools and hate long answers.",
    language: { mode: "manual", code: "ar" },
    fancy: { ...defaultSettings().fancy, userName: "Hakora", userCountry: "Germany" },
  });
  const p = buildSystemPrompt({ settings: g, memoryText: "", memoryEnabled: false });
  expect(p).toContain("Hakora");
  expect(p).toContain("Germany");
  expect(p).toContain("I build tools and hate long answers.");
  expect(p.toLowerCase()).toContain("arabic");
});

test("system prompt: raw mode sends exactly what the user wrote", () => {
  const g = clampSettings({ ...defaultSettings(), sysMode: "raw", rawSystemPrompt: "ONLY THIS." });
  const p = buildSystemPrompt({ settings: g, memoryText: "secret", memoryEnabled: true });
  expect(p.startsWith("ONLY THIS.")).toBe(true);
  // Raw mode still gets the time + language — those are not persona text.
  expect(p).toMatch(/Current date and time/);
  // Memories are their own section: on when enabled, gone when not.
  expect(p).toContain("secret");
  const off = buildSystemPrompt({ settings: g, memoryText: "secret", memoryEnabled: false });
  expect(off).not.toContain("secret");
});

test("system prompt: memories ride along only when enabled", () => {
  const g = defaultSettings();
  const off = buildSystemPrompt({ settings: g, memoryText: "MEMFACT", memoryEnabled: false });
  const on = buildSystemPrompt({ settings: g, memoryText: "MEMFACT", memoryEnabled: true });
  expect(off).not.toContain("MEMFACT");
  expect(on).toContain("MEMFACT");
});

test("system prompt: time is injected fresh and names the timezone", () => {
  const g = clampSettings({ ...defaultSettings(), fancy: { ...defaultSettings().fancy, userTimezone: "Asia/Tokyo" } });
  const p = buildSystemPrompt({ settings: g, memoryText: "", memoryEnabled: false });
  expect(p).toContain("Asia/Tokyo");
  expect(p).toMatch(/Current date and time/);
});

test("system prompt: media is announced so the model knows to look", () => {
  const p = buildSystemPrompt({
    settings: defaultSettings(),
    memoryText: "",
    memoryEnabled: false,
    media: [{ name: "cat.png", kind: "image" }, { name: "clip.mp4", kind: "video" }],
  });
  expect(p).toContain("1 image and 1 video");
  expect(p).toContain("frames");
});

test("language: mirror mode, device mode and fixed mode each say something different", () => {
  expect(languageDirective("auto", "", "UTC")).toMatch(/mirror/i);
  expect(languageDirective("manual", "fr", "UTC")).toContain("French");
  expect(languageDirective("device", "", "UTC")).toMatch(/device/i);
});

// ------------------------------------------------------------- namespaces ---

test("namespace: two devices on one account never share Kaggle storage", () => {
  const a = profileNamespace("hakora", "device-a-signature");
  const b = profileNamespace("hakora", "device-b-signature");
  expect(a).not.toBe(b);
  expect(profileNamespace("hakora", "device-a-signature")).toBe(a); // stable
  expect(profileNamespace("hakora")).toBe("hakora"); // no signature → plain
});

// ---------------------------------------------------------- engine script ---

test("engine script: the generated Python compiles", async () => {
  const src = engineScript({ bearer: "KGAT_test", owner: "hakoradev", profile: "hakora", ns: "hakora-abc123", contextTokens: 75000, afkSeconds: 180 });
  expect(src.length).toBeGreaterThan(1000);
  expect(src).toContain("KGAT_test");
  expect(src).not.toContain("__CONFIG__");
  // The script must be syntactically valid Python. (Windows runners call it
  // "python", Linux "python3" — and a machine without python skips it.)
  const { spawnSync } = await import("node:child_process");
  const py = pythonCommand();
  if (!py) return;
  const r = spawnSync(py, ["-c", "import sys;compile(sys.stdin.read(),'engine.py','exec')"], { input: src, encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
});

test("engine script: the config block is baked in before the imports", () => {
  const src = engineScript({ bearer: "KGAT_x", owner: "owner", profile: "p", ns: "p-xyz", contextTokens: 40000, afkSeconds: 60 });
  const cfgAt = src.indexOf("CFG =");
  expect(cfgAt).toBeGreaterThan(0);
  expect(src).toContain('"contextTokens":40000');
  // The kernel must use the namespace the app gave it — not guess one.
  expect(src).toContain("NS = CFG.get(\"ns\")");
});
