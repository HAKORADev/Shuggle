// Shuggle — shared memory across sessions.
//
// One text file (cap 10K chars), synced with the engine. The engine is the
// live editor when memory tools are on; the app mirrors it and reconciles by
// content hash, so neither side ever blindly overwrites the other.
//
// Optional model-facing tools (off by default): create / edit / delete /
// list / list_deleted / undo — parsed from a fenced block in the model's
// output, never shown to the user, never a tool-call agent loop.

export const MEMORY_CAP = 10_000;

export interface MemoryOp {
  op: "create" | "edit" | "delete" | "list" | "list_deleted" | "undo";
  id?: string;
  name?: string;
  content?: string;
}

export interface MemoryEntry {
  id: string;
  text: string;
  updatedAt: number;
  deleted?: boolean;
  deletedAt?: number;
}

/**
 * Memory file format: one entry per block, separated by a marker line.
 * Human-readable and diff-friendly:
 *
 *   ## <name> #<id>
 *   <text lines...>
 */
export function serializeMemory(entries: MemoryEntry[]): string {
  return entries
    .filter((e) => !e.deleted)
    .map((e) => `## ${e.name || "note"} #${e.id}\n${e.text.trim()}`)
    .join("\n\n");
}

export function parseMemoryBlocks(text: string): { name: string; id: string; text: string }[] {
  const out: { name: string; id: string; text: string }[] = [];
  const re = /^## (.+?) #([A-Za-z0-9]+)\n([\s\S]*?)(?=^## |\Z)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ name: m[1].trim(), id: m[2], text: m[3].trim() });
  }
  return out;
}

export function sha(text: string): string {
  // tiny stable hash (not crypto-critical)
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Apply a model memory op. Returns { text, result } — text is the new memory body. */
export function applyOp(
  text: string,
  history: MemoryEntry[],
  op: MemoryOp,
): { ok: boolean; result: string; text: string; history: MemoryEntry[] } {
  const blocks = parseMemoryBlocks(text);
  let entries: MemoryEntry[] = blocks.map((b) => ({
    id: b.id,
    name: b.name,
    text: b.text,
    updatedAt: Date.now(),
    ...(history.find((h) => h.id === b.id)?.deleted ? { deleted: true, deletedAt: history.find((h) => h.id === b.id)!.deletedAt } : {}),
  }));

  switch (op.op) {
    case "create": {
      if (!op.content) return { ok: false, result: "create needs content", text, history };
      if (serializeMemory(entries).length + op.content.length > MEMORY_CAP) {
        return { ok: false, result: "memory is full — delete something first", text, history };
      }
      const id = Math.random().toString(36).slice(2, 8);
      entries.push({ id, name: op.name || "note", text: op.content, updatedAt: Date.now() });
      history.push({ id, name: op.name || "note", text: op.content, updatedAt: Date.now() });
      return { ok: true, result: `created memory #${id}`, text: serializeMemory(entries), history };
    }
    case "edit": {
      const e = entries.find((x) => x.id === op.id || x.name === op.name);
      if (!e) return { ok: false, result: `no memory matches ${op.id ?? op.name}`, text, history };
      e.text = op.content ?? e.text;
      e.updatedAt = Date.now();
      const h = history.find((x) => x.id === e.id);
      if (h) h.text = e.text;
      return { ok: true, result: `updated memory #${e.id}`, text: serializeMemory(entries), history };
    }
    case "delete": {
      const e = entries.find((x) => x.id === op.id || x.name === op.name);
      if (!e) return { ok: false, result: `no memory matches ${op.id ?? op.name}`, text, history };
      e.deleted = true;
      e.deletedAt = Date.now();
      const h = history.find((x) => x.id === e.id);
      if (h) {
        h.deleted = true;
        h.deletedAt = e.deletedAt;
      }
      return { ok: true, result: `deleted memory #${e.id} (undo available)`, text: serializeMemory(entries), history };
    }
    case "list": {
      if (entries.filter((e) => !e.deleted).length === 0) return { ok: true, result: "memory is empty", text, history };
      const listing = entries
        .filter((e) => !e.deleted)
        .map((e) => `#${e.id} ${e.name}: ${e.text.slice(0, 80)}${e.text.length > 80 ? "…" : ""}`)
        .join("\n");
      return { ok: true, result: listing, text, history };
    }
    case "list_deleted": {
      const del = history.filter((h) => h.deleted);
      if (!del.length) return { ok: true, result: "nothing deleted", text, history };
      return {
        ok: true,
        result: del.map((d) => `#${d.id} ${d.name}: ${d.text.slice(0, 60)}…`).join("\n"),
        text,
        history,
      };
    }
    case "undo": {
      const del = history.filter((h) => h.deleted).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))[0];
      if (!del) return { ok: false, result: "nothing to undo", text, history };
      del.deleted = false;
      del.deletedAt = undefined;
      return { ok: true, result: `restored memory #${del.id}`, text: serializeMemory(parseMemoryBlocks(del.text) ? serializeMemory(rebuild(entries, history)) : entries), history };
    }
    default:
      return { ok: false, result: "unknown op", text, history };
  }
}

function rebuild(entries: MemoryEntry[], history: MemoryEntry[]): MemoryEntry[] {
  // Rebuild live entries from history (source of truth).
  return history
    .filter((h) => !h.deleted)
    .map((h) => ({ id: h.id, name: h.name, text: h.text, updatedAt: h.updatedAt }));
}

/** Extract and strip memory op blocks from model output (```memory ... ```). */
export function extractMemoryOps(output: string): { clean: string; ops: MemoryOp[] } {
  const ops: MemoryOp[] = [];
  const clean = output.replace(/```memory\n([\s\S]*?)```/g, (_all, body: string) => {
    try {
      const parsed = JSON.parse(body.trim());
      if (Array.isArray(parsed)) ops.push(...parsed);
      else ops.push(parsed);
    } catch {
      /* not valid ops — leave it invisible anyway */
    }
    return "";
  });
  return { clean, ops };
}
