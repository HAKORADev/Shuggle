// Shuggle — dynamic system prompt builder.
//
// Time is injected fresh for EVERY message from the user's own machine clock
// (never the notebook's clock). "Fancy" mode builds a persona from identity
// fields; "raw" mode sends exactly what the user wrote. Hard cap 10K chars.
//
// Skills are deliberately NOT part of this prompt — they travel as a separate
// system message with their own handler instructions (see skills.ts).

import { GlobalSettings, mergeOverride, SessionOverride } from "./settings.ts";

export interface PromptContext {
  settings: GlobalSettings;
  override?: SessionOverride;
  memoryText: string;
  memoryEnabled: boolean;
  attachments?: { name: string; chars: number }[];
  media?: { name: string; kind: string }[];
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", ar: "Arabic", fr: "French", es: "Spanish", de: "German",
  it: "Italian", pt: "Portuguese", ru: "Russian", tr: "Turkish", zh: "Chinese",
  ja: "Japanese", ko: "Korean", hi: "Hindi", ur: "Urdu", fa: "Persian",
  id: "Indonesian", nl: "Dutch", pl: "Polish", uk: "Ukrainian", sv: "Swedish",
};

export function languageDirective(mode: "auto" | "device" | "manual", code: string, tz: string): string | null {
  if (mode === "manual" && code) {
    const name = LANGUAGE_NAMES[code.slice(0, 2).toLowerCase()] ?? code;
    return `Language: always reply in ${name}${code.length > 2 ? ` (${code})` : ""}, even if the user writes in another language. If the user explicitly asks for a different language, follow the user.`;
  }
  if (mode === "device") {
    let lang = "English";
    try {
      const loc = new Intl.Locale((typeof navigator !== "undefined" ? navigator.language : "en"));
      const c = (loc.language || "en").toLowerCase();
      lang = LANGUAGE_NAMES[c] ?? loc.language ?? "English";
    } catch {
      /* default */
    }
    void tz;
    return `Language: reply in ${lang} (this device's language) unless the user writes in another language — then mirror the user.`;
  }
  return "Language: mirror the language the user writes in. If they mix languages, lean toward the language of their latest message.";
}

function fancyDateLine(tz: string): string {
  try {
    const now = new Date();
    const date = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: tz,
    }).format(now);
    const time = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
      hour12: false,
    }).format(now);
    return `Current date and time at the user's location: ${date}, ${time} (${tz}). This is real time — it updates every minute.`;
  } catch {
    return `Current date and time: ${new Date().toUTCString()} (UTC).`;
  }
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const g = mergeOverride(ctx.settings, ctx.override);
  let base: string;

  if (g.sysMode === "raw") {
    base = g.rawSystemPrompt.trim();
  } else {
    const f = g.fancy;
    const parts: string[] = [];
    parts.push(`You are ${f.assistantName || "a thoughtful AI assistant"} — ${f.role || "a warm, sharp assistant who talks like a person and never wastes words"}.`);
    if (f.responseStyle) parts.push(`How you respond: ${f.responseStyle}`);
    const identity: string[] = [];
    if (f.userName) identity.push(`name: ${f.userName}`);
    if (f.userGender) identity.push(`gender: ${f.userGender}`);
    if (f.userSex) identity.push(`sex: ${f.userSex}`);
    if (f.userAge) identity.push(`age: ${f.userAge}`);
    if (f.userBirthday) identity.push(`birthday: ${f.userBirthday}`);
    if (f.userCountry) identity.push(`country: ${f.userCountry}`);
    if (f.userOccupation) identity.push(`occupation: ${f.userOccupation}`);
    if (f.userRelationship && f.userRelationship !== "it's private") identity.push(`relationship: ${f.userRelationship}`);
    if (identity.length) parts.push(`About the person you're talking with — ${identity.join(", ")}. Remember and use this naturally, never lecture about it.`);
    base = parts.join("\n");
  }

  const about = (g.aboutYou ?? "").trim();
  if (about) {
    base += `\n\n# About the user (written by the user — treat as their self-description, keep it in mind, never recite it back unless it helps):\n${about}`;
  }

  const lang = languageDirective(g.language.mode, g.language.code, g.fancy.userTimezone);
  if (lang) base += `\n\n${lang}`;

  if (ctx.memoryEnabled && ctx.memoryText.trim()) {
    base += `\n\n# Memories about the user (persistent, shared across all their chats — treat as facts, update them when the user says something that changes them):\n${ctx.memoryText.trim()}`;
  }

  if (ctx.attachments?.length) {
    base += `\n\nThe user's message includes attached file(s): ${ctx.attachments.map((a) => a.name).join(", ")}. Their contents appear inside the message, clearly marked.`;
  }

  if (ctx.media?.length) {
    const imgs = ctx.media.filter((m) => m.kind === "image").length;
    const vids = ctx.media.filter((m) => m.kind === "video").length;
    const bits: string[] = [];
    if (imgs) bits.push(`${imgs} image${imgs > 1 ? "s" : ""}`);
    if (vids) bits.push(`${vids} video${vids > 1 ? "s" : ""} (shown as extracted frames)`);
    base += `\n\nThe user's message includes ${bits.join(" and ")}. Look at them carefully and factor them into your reply.`;
  }

  base += `\n\n${fancyDateLine(g.fancy.userTimezone)}`;

  if (base.length > g.systemPromptMaxChars) {
    base = base.slice(0, g.systemPromptMaxChars - 1) + "…";
  }
  return base;
}

/** Estimated token count (chars/3.2 heuristic; real ratio probed by the engine at boot). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.2);
}
