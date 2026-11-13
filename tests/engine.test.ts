// Shuggle — core module tests. Run: bun test test/core.test.ts
import { describe, expect, test } from "bun:test";
import { applyOp, extractMemoryOps, parseMemoryBlocks, serializeMemory, MEMORY_CAP } from "../src/core/memory.ts";
import { activeSkills, defaultSkills, sanitizeSkills, MAX_SKILL_CHARS } from "../src/core/skills.ts";
import { clampSettings, defaultSettings, mergeOverride } from "../src/core/settings.ts";
import { buildSystemPrompt, languageDirective } from "../src/core/sysprompt.ts";
import { engineScript } from "../src/core/kernel.ts";
import { hsh16 } from "../src/core/util.ts";
import { execSync } from "node:child_process";


/** The python on this machine — Windows says "python", Linux "python3". */
function pythonCommand(): string | null {
  for (const c of ["python3", "python"]) {
    try {
      const r = execSync(`${c} --version`, { stdio: "pipe" });
      if (r.status === 0) return c;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// ---------------------------------------------------------------- memory ----

describe("memory", () => {
  test("serialize/parse roundtrip keeps names, ids and multi-line text", () => {
    const entries = [
      { id: "abc123", name: "editor", text: "uses Manjaro Linux\nand neovim", updatedAt: 1 },
      { id: "def456", name: "tone", text: "prefers short answers", updatedAt: 2 },
    ];
    const text = serializeMemory(entries);
    const parsed = parseMemoryBlocks(text);
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toEqual({ name: "editor", id: "abc123", text: "uses Manjaro Linux\nand neovim" });
    expect(parsed[1].text).toBe("prefers short answers");
  });

  test("create → edit → delete → list_deleted → undo lifecycle", () => {
    let text = "";
    let hist: any[] = [];
    let r = applyOp(text, hist, { op: "create", name: "lang", content: "user writes Arabic and English" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatch(/created memory #/);
    text = r.text; hist = r.history;
    const id = r.result.match(/#([a-z0-9]+)/)![1];

    r = applyOp(text, hist, { op: "edit", id, content: "user writes Arabic mostly" });
    expect(r.ok).toBe(true);
    text = r.text;
    expect(parseMemoryBlocks(text)[0].text).toBe("user writes Arabic mostly");

    r = applyOp(text, hist, { op: "delete", id });
    expect(r.ok).toBe(true);
    expect(parseMemoryBlocks(r.text).length).toBe(0);
    text = r.text;

    r = applyOp(text, hist, { op: "list" });
    expect(r.result).toBe("memory is empty");
    r = applyOp(text, hist, { op: "list_deleted" });
    expect(r.result).toContain(id);
    r = applyOp(text, hist, { op: "undo", id });
    expect(r.ok).toBe(true);
    expect(parseMemoryBlocks(r.text).length).toBe(1);
  });

  test("cap is enforced honestly", () => {
    const r = applyOp("", [], { op: "create", name: "big", content: "x".repeat(MEMORY_CAP + 10) });
    expect(r.ok).toBe(false);
    expect(r.result).toContain("memory is full");
  });

  test("extractMemoryOps strips fenced blocks and parses JSON", () => {
    const out = 'before\n```memory\n[{"op":"create","name":"n","content":"c"}]\n```\nafter';
    const { clean, ops } = extractMemoryOps(out);
    expect(ops.length).toBe(1);
    expect(ops[0].op).toBe("create");
    expect(clean).toBe("before\n\nafter");
  });
});

// ---------------------------------------------------------------- skills ----

describe("skills", () => {
  test("sanitize caps and drops empty bodies", () => {
    const out = sanitizeSkills([
      { title: "ok", content: "c", enabled: true },
      { title: "", content: "no title" },
      { title: "no body", content: "   " },
      { title: "x".repeat(100), content: "y".repeat(MAX_SKILL_CHARS + 500) },
    ]);
    expect(out.length).toBe(2);
    expect(out[1].title.length).toBe(80);
    expect(out[1].content.length).toBe(MAX_SKILL_CHARS);
  });

  test("defaults exist and pass sanitization", () => {
    const ds = defaultSkills();
    expect(ds.length).toBeGreaterThanOrEqual(4);
    expect(sanitizeSkills(ds).length).toBe(ds.length);
  });

  test("activeSkills: global off + session on = on; session off always wins; disabled ids honored", () => {
    const skills = [
      { id: "a", title: "A", when: "", why: "", content: "aaa", enabled: true },
      { id: "b", title: "B", when: "", why: "", content: "bbb", enabled: false },
      { id: "c", title: "C", when: "", why: "", content: "ccc", enabled: true },
    ];
    expect(activeSkills(skills, false, undefined).length).toBe(0);
    expect(activeSkills(skills, false, true).map((s) => s.id)).toEqual(["a", "c"]);
    expect(activeSkills(skills, true, false).length).toBe(0);
    expect(activeSkills(skills, true, undefined).map((s) => s.id)).toEqual(["a", "c"]);
    expect(activeSkills(skills, true, true, ["a"]).map((s) => s.id)).toEqual(["c"]);
  });
});

// -------------------------------------------------------------- settings ----

describe("settings", () => {
  test("clampSettings enforces context window 32K..75K", () => {
    expect(clampSettings({ ...defaultSettings(), contextTokens: 5000 } as any).contextTokens).toBe(32768);
    expect(clampSettings({ ...defaultSettings(), contextTokens: 999999 } as any).contextTokens).toBe(75000);
  });

  test("clampSettings keeps language + aboutYou within spec", () => {
    const s = clampSettings({ ...defaultSettings(), aboutYou: "x".repeat(5000), language: { mode: "bogus", code: "toolongtag1234567" } } as any);
    expect(s.aboutYou.length).toBe(4000);
    expect(s.language.mode).toBe("auto");
    expect(s.language.code).toBe("toolongtag12");
  });

  test("first load ships starter skills; user deletions persist", () => {
    expect(clampSettings(defaultSettings() as any).skills.length).toBeGreaterThan(0);
    expect(clampSettings({ ...defaultSettings(), skills: [] } as any).skills.length).toBe(0);
  });

  test("mergeOverride applies per-session fields", () => {
    const g = defaultSettings();
    const m = mergeOverride(g, { temperature: 1.2, languageMode: "manual", languageCode: "ar", skillsEnabled: true, disabledSkillIds: ["x"] });
    expect(m.temperature).toBe(1.2);
    expect(m.language).toEqual({ mode: "manual", code: "ar" });
    expect(g.temperature).toBe(0.7);
  });
});

// -------------------------------------------------------------- sysprompt ----

describe("sysprompt", () => {
  const base = { ...defaultSettings(), fancy: { ...defaultSettings().fancy, userName: "HAKORA", userTimezone: "Africa/Cairo" } };

  test("fancy prompt carries identity, about-you, language, memory, per-minute time", () => {
    const p = buildSystemPrompt({
      settings: base,
      memoryText: "## likes #x1\npineapple pizza",
      memoryEnabled: true,
    } as any);
    expect(p).toContain("HAKORA");
    expect(p).toContain("Africa/Cairo");
    expect(p).toContain("pineapple pizza");
    expect(p).toContain("Current date and time at the user's location");
  });

  test("raw mode sends only the user's text + mandatory bits", () => {
    const s = { ...base, sysMode: "raw" as const, rawSystemPrompt: "YOU ARE MINIMAL" };
    const p = buildSystemPrompt({ settings: s, memoryText: "", memoryEnabled: false } as any);
    expect(p).toContain("YOU ARE MINIMAL");
    expect(p).not.toContain("About the person");
  });

  test("language directives", () => {
    expect(languageDirective("manual", "ar", "UTC")).toContain("Arabic");
    expect(languageDirective("auto", "", "UTC")).toContain("mirror the language");
    expect(languageDirective("device", "", "UTC")).toContain("this device's language");
  });

  test("10K char cap", () => {
    const s = { ...base, aboutYou: "y".repeat(4000), rawSystemPrompt: "z".repeat(9000), sysMode: "raw" as const };
    const p = buildSystemPrompt({ settings: s, memoryText: "", memoryEnabled: false } as any);
    expect(p.length).toBeLessThanOrEqual(10_000);
  });
});

// ------------------------------------------------------- kernel template ----

describe("kernel", () => {
  const cfg = {
    bearer: "KGAT_x", owner: "hakoradev", profile: "HAKORA", contextTokens: 75000, afkSeconds: 180,
    memoryTools: true, vision: { enabled: true, maxFrames: 8, frameSeconds: 2, mediaTokenBudget: 8000 },
  };

  test("config bakes memoryTools + vision into the engine script", () => {
    const s = engineScript(cfg);
    const baked = JSON.parse(s.match(/CFG = json.loads\(r'''(.*?)'''/s)![1]);
    expect(baked.memoryTools).toBe(true);
    expect(baked.vision.enabled).toBe(true);
    expect(baked.vision.mediaTokenBudget).toBe(8000);
  });

  test("generated python compiles (py_compile)", () => {
    const src = engineScript(cfg);
    const script = src.replace(/CFG = json.loads\(r'''.*?'''\)/s, "CFG = {}");
    const { writeFileSync } = require("node:fs");
    const out = process.platform === "win32" ? "shuggle_engine_test.py" : "/tmp/shuggle_engine_test.py";
    writeFileSync(out, script);
    const py = pythonCommand();
    if (!py) return; // no python on this machine (the check runs elsewhere)
    execSync(`${py} -m py_compile "${out}"`, { stdio: "pipe" });
  });

  test("hash parity with the engine's python hsh() on tricky payloads", () => {
    const cases: any[] = [
      [{ role: "user", content: "hello world" }],
      [{ role: "user", content: "مرحبا بالعالم — ذكاء اصطناعي 🐱‍👤" }],
      [{ role: "assistant", content: 'line1\nline2 "quoted" \\ backslash', mid: "m1" }],
      [{ role: "user", content: "emoji 🚀 + \t\ttabs" }],
      [],
    ];
    const pyBin = pythonCommand();
    if (!pyBin) return; // no python on this machine (the check runs elsewhere)
    for (const c of cases) {
      const expected = execSync(
        `${pyBin} -c "import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16])"`,
        { input: JSON.stringify(c) },
      ).toString().trim();
      expect(hsh16(c)).toBe(expected);
    }
  });
});
