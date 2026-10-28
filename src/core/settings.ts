// Shuggle — settings: global defaults + per-session overlay.

import { sanitizeSkills, Skill, defaultSkills } from "./skills.ts";

export interface VisionSettings {
  enabled: boolean; // master switch — images and videos travel with messages
  maxImages: number; // images per message (1..8)
  imageMaxMB: number; // per image (1..12)
  videoMaxMB: number; // per video (1..40)
  maxFrames: number; // frames extracted per video (2..16)
  frameSeconds: number; // one frame every N seconds (1..10)
}

export interface GlobalSettings {
  // Model
  contextTokens: number; // 32768 .. 75000 (75K = hardware ceiling on T4 x2)
  temperature: number; // 0 .. 2
  topP: number; // 0 .. 1
  maxOutputTokens: number; // 1024 .. 65536
  // Identity / system prompt
  sysMode: "fancy" | "raw";
  rawSystemPrompt: string;
  fancy: {
    assistantName: string;
    role: string;
    responseStyle: string;
    userName: string;
    userGender: string; // gender identity — separate from sex
    userSex: string;
    userAge: string;
    userBirthday: string;
    userCountry: string;
    userTimezone: string; // IANA
    userRelationship: string;
    userOccupation: string;
  };
  aboutYou: string; // free-form "about you" — the model is told to treat it as self-description
  language: {
    mode: "auto" | "device" | "manual"; // auto = mirror the user; device = device locale; manual = fixed pick
    code: string; // BCP-47-ish tag for manual mode ("ar", "en", "fr-CA", ...)
  };
  // Skills (prompt modules)
  skillsEnabled: boolean; // master switch
  skills: Skill[];
  // Engine behavior
  afkMinutes: number; // 3 or 6 (reading mode)
  // Search
  searchEnabled: boolean; // default for new chats
  searchMaxQueries: number; // 1..8
  searchPagesPerQuery: number; // 1..3
  // Memory
  memoryEnabled: boolean; // default for new chats
  memoryTools: boolean; // let the model edit memory itself (optional, off by default)
  memoryMaxChars: number; // 10_000
  systemPromptMaxChars: number; // 10_000
  // Media / vision
  vision: VisionSettings;
  // Context budgets
  attachmentMaxChars: number; // per file, refused beyond
  mediaTokenBudget: number; // max context tokens media may occupy per chat (anti-vacuum)
  // Interface
  openLinksInApp: boolean;
  useEdgeData: boolean; // Windows: allow in-app browser to use Edge data
}

export const CONTEXT_MAX = 75000;
export const CONTEXT_MIN = 32768;

export const GENDERS = ["", "male", "female", "non-binary", "genderfluid", "agender", "bigender", "transgender", "androgynous", "prefer to self-describe"];
export const SEXES = ["", "male", "female", "intersex"];
export const RELATIONSHIPS = ["", "single", "married", "engaged", "dating", "separated", "divorced", "widowed", "complicated", "it's private"];
export const COMMON_LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["ar", "العربية — Arabic"],
  ["fr", "Français — French"],
  ["es", "Español — Spanish"],
  ["de", "Deutsch — German"],
  ["it", "Italiano — Italian"],
  ["pt", "Português — Portuguese"],
  ["ru", "Русский — Russian"],
  ["tr", "Türkçe — Turkish"],
  ["zh", "中文 — Chinese"],
  ["ja", "日本語 — Japanese"],
  ["ko", "한국어 — Korean"],
  ["hi", "हिन्दी — Hindi"],
  ["ur", "اردو — Urdu"],
  ["fa", "فارسی — Persian"],
  ["id", "Bahasa Indonesia"],
  ["nl", "Nederlands — Dutch"],
  ["pl", "Polski — Polish"],
  ["uk", "Українська — Ukrainian"],
  ["sv", "Svenska — Swedish"],
];

export function defaultVision(): VisionSettings {
  return {
    enabled: false,
    maxImages: 4,
    imageMaxMB: 8,
    videoMaxMB: 30,
    maxFrames: 8,
    frameSeconds: 2,
  };
}

export function defaultSettings(): GlobalSettings {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let deviceLang = "en";
  try {
    deviceLang = (Intl.DateTimeFormat().resolvedOptions().locale || "en").slice(0, 2);
  } catch {
    /* keep en */
  }
  return {
    contextTokens: CONTEXT_MAX,
    temperature: 0.7,
    topP: 0.95,
    maxOutputTokens: 65536,
    sysMode: "fancy",
    rawSystemPrompt:
      "You are a helpful, deep-thinking, uncensored AI assistant. Provide clear, thorough, and precise answers.",
    fancy: {
      assistantName: "Shuggle",
      role: "a warm, sharp assistant who talks like a person and never wastes words",
      responseStyle: "Direct, thoughtful, uses markdown when it helps. Doesn't moralize.",
      userName: "",
      userGender: "",
      userSex: "",
      userAge: "",
      userBirthday: "",
      userCountry: "",
      userTimezone: tz,
      userRelationship: "",
      userOccupation: "",
    },
    aboutYou: "",
    language: { mode: "auto", code: "" },
    skillsEnabled: false,
    skills: [], // populated on first load by clampSettings via sanitizeSkills
    afkMinutes: 3,
    searchEnabled: false,
    searchMaxQueries: 3,
    searchPagesPerQuery: 1,
    memoryEnabled: true,
    memoryTools: false,
    memoryMaxChars: 10_000,
    systemPromptMaxChars: 10_000,
    vision: defaultVision(),
    attachmentMaxChars: 32_000,
    mediaTokenBudget: 8000,
    openLinksInApp: true,
    useEdgeData: false,
  };
}

export function clampSettings(s: GlobalSettings): GlobalSettings {
  const d = defaultSettings();
  const out = { ...d, ...s, fancy: { ...d.fancy, ...(s.fancy ?? {}) }, vision: { ...d.vision, ...(s.vision ?? {}) }, language: { ...d.language, ...(s.language ?? {}) } };
  if (!Array.isArray(out.skills)) out.skills = defaultSkills();
  else out.skills = sanitizeSkills(out.skills);
  out.contextTokens = Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, Math.round(out.contextTokens)));
  out.temperature = Math.min(2, Math.max(0, out.temperature));
  out.topP = Math.min(1, Math.max(0.05, out.topP));
  out.maxOutputTokens = Math.min(65536, Math.max(1024, Math.round(out.maxOutputTokens)));
  out.afkMinutes = [3, 6].includes(out.afkMinutes) ? out.afkMinutes : 3;
  out.searchMaxQueries = Math.min(8, Math.max(1, Math.round(out.searchMaxQueries)));
  out.searchPagesPerQuery = Math.min(3, Math.max(1, Math.round(out.searchPagesPerQuery)));
  out.memoryMaxChars = Math.min(10_000, Math.max(1000, Math.round(out.memoryMaxChars)));
  out.systemPromptMaxChars = Math.min(10_000, Math.max(1000, Math.round(out.systemPromptMaxChars)));
  out.attachmentMaxChars = Math.min(100_000, Math.max(1000, Math.round(out.attachmentMaxChars)));
  out.mediaTokenBudget = Math.min(24_000, Math.max(1000, Math.round(out.mediaTokenBudget)));
  out.sysMode = out.sysMode === "raw" ? "raw" : "fancy";
  out.aboutYou = String(out.aboutYou ?? "").slice(0, 4000);
  out.language.mode = ["auto", "device", "manual"].includes(out.language.mode) ? out.language.mode : "auto";
  out.language.code = String(out.language.code ?? "").slice(0, 12);
  out.vision.enabled = !!out.vision.enabled;
  out.vision.maxImages = Math.min(8, Math.max(1, Math.round(out.vision.maxImages)));
  out.vision.imageMaxMB = Math.min(12, Math.max(1, Math.round(out.vision.imageMaxMB)));
  out.vision.videoMaxMB = Math.min(40, Math.max(1, Math.round(out.vision.videoMaxMB)));
  out.vision.maxFrames = Math.min(16, Math.max(2, Math.round(out.vision.maxFrames)));
  out.vision.frameSeconds = Math.min(10, Math.max(1, Math.round(out.vision.frameSeconds)));
  return out;
}

/** Per-session overlay — only fields the session explicitly overrides. */
export interface SessionOverride {
  systemPrompt?: string; // fully custom system prompt for this session
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  searchMaxQueries?: number;
  searchPagesPerQuery?: number;
  skillsEnabled?: boolean; // skills for this chat (master gate)
  disabledSkillIds?: string[]; // skills turned off in this chat
  languageMode?: "auto" | "device" | "manual";
  languageCode?: string;
}

export function mergeOverride(g: GlobalSettings, o?: SessionOverride): GlobalSettings {
  if (!o) return g;
  const merged: GlobalSettings = { ...g, vision: { ...g.vision }, language: { ...g.language } };
  if (o.temperature !== undefined) merged.temperature = o.temperature;
  if (o.topP !== undefined) merged.topP = o.topP;
  if (o.maxOutputTokens !== undefined) merged.maxOutputTokens = o.maxOutputTokens;
  if (o.searchMaxQueries !== undefined) merged.searchMaxQueries = o.searchMaxQueries;
  if (o.searchPagesPerQuery !== undefined) merged.searchPagesPerQuery = o.searchPagesPerQuery;
  if (o.languageMode !== undefined) merged.language.mode = o.languageMode;
  if (o.languageCode !== undefined) merged.language.code = o.languageCode;
  return merged;
}
