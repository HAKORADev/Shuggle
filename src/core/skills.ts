// Shuggle — skills: toggleable prompt modules.
//
// A skill is NOT a file — it is a styled block of prompt text the model can
// lean on. Each skill carries its own title, when to use it, why it exists and
// the skill body. Skills are toggled: individually, as a whole system, per
// session, and globally. When enabled, the engine receives them as a SEPARATE
// system message (never mixed into the user's system prompt) together with a
// handler prompt that tells the model exactly how to treat them.

export interface Skill {
  id: string;
  title: string;
  when: string; // when this skill applies
  why: string; // why it exists / what it protects
  content: string; // the skill body (markdown-ish text)
  enabled: boolean;
  builtIn?: boolean; // shipped defaults — editable, deletable, but marked
}

const MAX_SKILLS = 40;
export const MAX_SKILL_CHARS = 6000;

export function skillId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Starter skills so the system is discoverable. All editable and deletable. */
export function defaultSkills(): Skill[] {
  return [
    {
      id: "code-review",
      title: "Code review mode",
      when: "The user shares code and asks for review, fixing, or \"what's wrong\".",
      why: "Keeps reviews structured and honest instead of vague praise.",
      enabled: false,
      builtIn: true,
      content: [
        "When reviewing code:",
        "1. Read the whole snippet before judging anything.",
        "2. Lead with what the code actually does (one or two lines) so the user knows you understood it.",
        "3. List problems by severity: breaking first, then correctness, then style. Number them.",
        "4. For every problem, show the minimal fix as a diff or corrected snippet — never describe a fix you didn't write out.",
        "5. If you're unsure whether something is a bug, say what would prove it either way.",
        "6. No filler praise. If the code is good, one line saying so is enough.",
      ].join("\n"),
    },
    {
      id: "explain-simply",
      title: "Explain like a mentor",
      when: "The user asks to explain a concept, or says they don't understand something.",
      why: "Prevents lecture-mode walls of text; builds understanding step by step.",
      enabled: false,
      builtIn: true,
      content: [
        "When explaining something new:",
        "- Start from what the person likely already knows; anchor the new idea to it.",
        "- One core idea per paragraph. Use a concrete example before abstract terms.",
        "- Analogies are allowed but must map cleanly — if the analogy breaks down, say where.",
        "- End with a one-sentence summary the user could repeat to someone else.",
        "- Match depth to the question: don't unpack graduate detail into a beginner question unless asked.",
      ].join("\n"),
    },
    {
      id: "deep-research",
      title: "Deep answer mode",
      when: "The question is technical, high-stakes, or the user asks for depth and rigor.",
      why: "Forces the model to reason carefully and separate facts from guesses.",
      enabled: false,
      builtIn: true,
      content: [
        "For deep or technical questions:",
        "- Think through the problem before writing the final answer.",
        "- Clearly separate: established facts, your reasoning, and speculation. Mark guesses as guesses.",
        "- Show the key steps of your reasoning, not just the conclusion.",
        "- If numbers are involved, sanity-check them (units, orders of magnitude, edge cases).",
        "- If the honest answer is 'it depends', say on what, and give the answer for the most common case.",
      ].join("\n"),
    },
    {
      id: "writing-polish",
      title: "Writing polish",
      when: "The user shares text to improve, rewrite, or proofread.",
      why: "Keeps the author's voice; improves instead of replacing.",
      enabled: false,
      builtIn: true,
      content: [
        "When editing the user's writing:",
        "- Preserve their voice and intent. Improve, don't rewrite into generic AI prose.",
        "- Return the edited text first, then a short list of what changed and why.",
        "- Fix grammar and flow aggressively; change word choice only when it genuinely helps.",
        "- If the text is in a language other than English, edit it in that same language.",
      ].join("\n"),
    },
    {
      id: "arabic-care",
      title: "Arabic care",
      when: "The conversation includes Arabic text or the user writes in Arabic.",
      why: "Arabic rendering and phrasing deserve deliberate handling — right-to-left, correct diacritics, natural phrasing.",
      enabled: false,
      builtIn: true,
      content: [
        "When the user writes in Arabic (or mixes Arabic with other languages):",
        "- Reply in Arabic unless they explicitly switch to another language.",
        "- Use proper Modern Standard Arabic for explanations; dialect flavor only if the user starts it.",
        "- Keep technical terms in their commonly-used form; if an English term is standard in tech, keep it in Latin script inside the Arabic sentence.",
        "- Never mirror broken RTL punctuation; write clean, natural sentences.",
      ].join("\n"),
    },
  ];
}

export function sanitizeSkills(list: unknown): Skill[] {
  if (!Array.isArray(list)) return defaultSkills();
  const out: Skill[] = [];
  for (const raw of list.slice(0, MAX_SKILLS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<Skill>;
    const title = String(r.title ?? "").trim().slice(0, 80);
    const content = String(r.content ?? "").slice(0, MAX_SKILL_CHARS);
    if (!title || !content.trim()) continue;
    out.push({
      id: String(r.id ?? "").slice(0, 24) || skillId(),
      title,
      when: String(r.when ?? "").slice(0, 400),
      why: String(r.why ?? "").slice(0, 400),
      content,
      enabled: !!r.enabled,
      builtIn: !!r.builtIn,
    });
  }
  return out;
}

/** The skills enabled for a given chat: global list filtered by the session's choices. */
export function activeSkills(
  skills: Skill[],
  masterEnabled: boolean,
  sessionEnabled?: boolean,
  disabledIds?: string[],
): Skill[] {
  if (!masterEnabled || sessionEnabled === false) return [];
  const off = new Set(disabledIds ?? []);
  return skills.filter((s) => s.enabled && !off.has(s.id) && s.content.trim());
}

/**
 * The handler prompt — a separate system message that travels WITH the skill
 * blocks. This is the "internal prompt" that teaches the model what these
 * texts are and how to behave. Deliberately not part of the user's system
 * prompt: skills are an app feature, not a persona statement.
 */
export function skillsPrompt(active: Skill[]): string | null {
  if (!active.length) return null;
  const parts: string[] = [];
  for (const s of active) {
    parts.push(
      `### Skill: ${s.title}\n` +
        (s.when ? `When it applies: ${s.when}\n` : "") +
        (s.why ? `Why it exists: ${s.why}\n` : "") +
        `---\n${s.content}\n---`,
    );
  }
  return [
    "The user has enabled Skill modules for this chat. Skills are instructions the user chose in advance — treat them as standing directives from the user, with slightly lower priority than what the user types in the moment.",
    "How to use them:",
    "- If the current message matches a skill's 'when it applies' condition, follow that skill fully for this reply.",
    "- If no skill matches, ignore them completely and answer normally. Never mention skills, their existence, or this block.",
    "- If two skills overlap, satisfy both where compatible; otherwise the more specific one wins.",
    "- Skills never override the user's latest explicit request.",
    "",
    "The skills:",
    parts.join("\n\n"),
  ].join("\n");
}
