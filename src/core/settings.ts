// Shuggle — settings: global defaults + per-session overlay.

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
    userSex: string;
    userAge: string;
    userBirthday: string;
    userCountry: string;
    userTimezone: string; // IANA
    userRelationship: string;
  };
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
  // Context budgets
  attachmentMaxChars: number; // per file, refused beyond
  // Interface
  openLinksInApp: boolean;
  useEdgeData: boolean; // Windows: allow in-app browser to use Edge data
}

export const CONTEXT_MAX = 75000;
export const CONTEXT_MIN = 32768;

export function defaultSettings(): GlobalSettings {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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
      userSex: "",
      userAge: "",
      userBirthday: "",
      userCountry: "",
      userTimezone: tz,
      userRelationship: "",
    },
    afkMinutes: 3,
    searchEnabled: false,
    searchMaxQueries: 3,
    searchPagesPerQuery: 1,
    memoryEnabled: true,
    memoryTools: false,
    memoryMaxChars: 10_000,
    systemPromptMaxChars: 10_000,
    attachmentMaxChars: 32_000,
    openLinksInApp: true,
    useEdgeData: false,
  };
}

export function clampSettings(s: GlobalSettings): GlobalSettings {
  const d = defaultSettings();
  const out = { ...d, ...s, fancy: { ...d.fancy, ...(s.fancy ?? {}) } };
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
  out.sysMode = out.sysMode === "raw" ? "raw" : "fancy";
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
}

export function mergeOverride(g: GlobalSettings, o?: SessionOverride): GlobalSettings {
  if (!o) return g;
  const merged: GlobalSettings = { ...g };
  if (o.temperature !== undefined) merged.temperature = o.temperature;
  if (o.topP !== undefined) merged.topP = o.topP;
  if (o.maxOutputTokens !== undefined) merged.maxOutputTokens = o.maxOutputTokens;
  if (o.searchMaxQueries !== undefined) merged.searchMaxQueries = o.searchMaxQueries;
  if (o.searchPagesPerQuery !== undefined) merged.searchPagesPerQuery = o.searchPagesPerQuery;
  return merged;
}
