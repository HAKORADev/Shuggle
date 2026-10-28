// Shuggle — dynamic system prompt builder.
//
// Time is injected fresh for EVERY message from the user's own machine clock
// (never the notebook's clock). "Fancy" mode builds a persona from identity
// fields; "raw" mode sends exactly what the user wrote. Hard cap 10K chars.

import { GlobalSettings, mergeOverride, SessionOverride } from "./settings.ts";

export interface PromptContext {
  settings: GlobalSettings;
  override?: SessionOverride;
  memoryText: string;
  memoryEnabled: boolean;
  attachments?: { name: string; chars: number }[];
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
    if (f.userSex) identity.push(`sex: ${f.userSex}`);
    if (f.userAge) identity.push(`age: ${f.userAge}`);
    if (f.userBirthday) identity.push(`birthday: ${f.userBirthday}`);
    if (f.userCountry) identity.push(`country: ${f.userCountry}`);
    if (f.userRelationship) identity.push(`relationship: ${f.userRelationship}`);
    if (identity.length) parts.push(`About the person you're talking with — ${identity.join(", ")}. Remember and use this naturally, never lecture about it.`);
    base = parts.join("\n");
  }

  if (ctx.memoryEnabled && ctx.memoryText.trim()) {
    base += `\n\n# Memories about the user (persistent, shared across all their chats — treat as facts, update them when the user says something that changes them):\n${ctx.memoryText.trim()}`;
  }

  if (ctx.attachments?.length) {
    base += `\n\nThe user's message includes attached file(s): ${ctx.attachments.map((a) => a.name).join(", ")}. Their contents appear inside the message, clearly marked.`;
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
