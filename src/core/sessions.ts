// Shuggle — session store: a real message tree with branch "dimensions".
//
// Every message is a node with a parent. A node's children are ordered; one of
// them is active. The visible chat = walk from the active root following
// activeChild. Retries and edits create siblings (new dimensions), never
// destroy history.

import { randomUUID } from "node:crypto";

export type Role = "user" | "assistant";

export interface Attachment {
  name: string;
  size: number;
  chars: number;
}

export interface Msg {
  id: string;
  parentId: string | null; // null = root child
  role: Role;
  content: string;
  thinking: string | null;
  at: number;
  genMs: number | null;
  attachments: Attachment[];
  error?: string;
  searchBrief?: string | null; // digest shown in a "searched the web" chip
  searches?: string[] | null;
}

export interface SessionData {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  autoNamed: boolean;
  nodes: Record<string, Msg>;
  activeRoot: string | null;
  activeChild: Record<string, string>; // parentId -> active childId
  searchEnabled: boolean;
  thinkingEnabled: boolean;
  memoryEnabled: boolean;
  override?: {
    systemPrompt?: string;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    searchMaxQueries?: number;
    searchPagesPerQuery?: number;
  };
  compareWith?: string | null; // dual-chat mode
  engineUsername?: string | null; // which token's engine this chat is bound to
}

export function newSession(name = "New chat"): SessionData {
  return {
    id: randomUUID(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false,
    autoNamed: false,
    nodes: {},
    activeRoot: null,
    activeChild: {},
    searchEnabled: false,
    thinkingEnabled: true,
    memoryEnabled: true,
    compareWith: null,
    engineUsername: null,
  };
}

export interface Store {
  sessions: Record<string, SessionData>;
  order: string[]; // sidebar order (most recent first)
}

export function emptyStore(): Store {
  return { sessions: {}, order: [] };
}

export function touch(store: Store, s: SessionData): void {
  s.updatedAt = Date.now();
  store.order = [s.id, ...store.order.filter((x) => x !== s.id)];
}

/** Linear active path of a session (the visible conversation). */
export function activePath(s: SessionData): Msg[] {
  const out: Msg[] = [];
  let cur = s.activeRoot;
  while (cur && s.nodes[cur]) {
    out.push(s.nodes[cur]);
    cur = s.activeChild[cur] ?? null;
  }
  return out;
}

export function childrenOf(s: SessionData, parentId: string | null): Msg[] {
  const out: Msg[] = [];
  if (parentId === null) {
    return s.activeRoot ? (s.nodes[s.activeRoot] ? [s.nodes[s.activeRoot]] : []) : [];
  }
  // children are recoverable by scanning (small sessions; fine and simple)
  for (const id of Object.keys(s.nodes)) {
    if (s.nodes[id].parentId === parentId) out.push(s.nodes[id]);
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

export function dimensionIndex(s: SessionData, m: Msg): { index: number; total: number } {
  const siblings = childrenOf(s, m.parentId);
  const i = siblings.findIndex((x) => x.id === m.id);
  return { index: i < 0 ? 0 : i + 1, total: siblings.length };
}

export function addNode(s: SessionData, parentId: string | null, msg: Omit<Msg, "id" | "parentId" | "at">): Msg {
  const node: Msg = { ...msg, id: randomUUID(), parentId, at: Date.now() };
  s.nodes[node.id] = node;
  if (parentId === null) {
    s.activeRoot = node.id;
  } else {
    s.activeChild[parentId] = node.id;
  }
  return node;
}

/** Switch the active dimension of a node (for switching between retries/edits). */
export function switchDimension(s: SessionData, nodeId: string): boolean {
  const node = s.nodes[nodeId];
  if (!node) return false;
  const siblings = childrenOf(s, node.parentId);
  const i = siblings.findIndex((x) => x.id === node.id);
  if (i < 0 || siblings.length < 2) return false;
  const next = siblings[(i + 1) % siblings.length];
  if (node.parentId === null) s.activeRoot = next.id;
  else s.activeChild[node.parentId] = next.id;
  return true;
}

/** The full context (system prompt excluded) as chat messages, for the engine. */
export function historyForEngine(s: SessionData): { role: Role; content: string }[] {
  return activePath(s)
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
}

export function sessionStats(s: SessionData): { messages: number; chars: number } {
  let messages = 0;
  let chars = 0;
  for (const m of activePath(s)) {
    messages++;
    chars += m.content.length + (m.thinking?.length ?? 0);
  }
  return { messages, chars };
}

export function renameAuto(s: SessionData, firstUserText: string): void {
  if (s.autoNamed) return;
  const t = firstUserText.replace(/\s+/g, " ").trim();
  if (!t) return;
  s.name = t.length > 38 ? t.slice(0, 38).trimEnd() + "…" : t;
  s.autoNamed = true;
}

/** Copy the active path up to (and including) nodeId into a fresh session. */
export function branchOut(store: Store, src: SessionData, nodeId: string): SessionData {
  const path = activePath(src);
  const upto: Msg[] = [];
  for (const m of path) {
    upto.push(m);
    if (m.id === nodeId) break;
  }
  const ns = newSession(src.name + " — branch");
  ns.searchEnabled = src.searchEnabled;
  ns.thinkingEnabled = src.thinkingEnabled;
  ns.memoryEnabled = src.memoryEnabled;
  ns.override = src.override ? { ...src.override } : undefined;
  let parent: string | null = null;
  for (const m of upto) {
    const node = addNode(ns, parent, {
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      genMs: m.genMs,
      attachments: m.attachments.map((a) => ({ ...a })),
      searchBrief: m.searchBrief,
      searches: m.searches,
    });
    parent = node.id;
  }
  ns.autoNamed = true;
  store.sessions[ns.id] = ns;
  store.order = [ns.id, ...store.order];
  return ns;
}
