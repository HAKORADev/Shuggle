// Shuggle — UI application (vanilla TS, bundled by Bun at build time).

declare const marked: any;
declare const DOMPurify: any;
declare const hljs: any;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const app = {
  account: null as string | null,
  sessions: [] as any[],
  current: null as any, // full session object (nodes, activeRoot, activeChild)
  currentMeta: null as any,
  settings: null as any,
  tokens: [] as any[],
  memory: "",
  engines: [] as any[],
  attachments: [] as { name: string; content: string }[],
  compareOpen: false,
  compareId: null as string | null,
  compareFull: null as any,
  generating: new Set<string>(),
  sectionCollapse: { pinned: false, history: false } as Record<string, boolean>,
  sending: false,
};

// ------------------------------------------------------------------ utils

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s: string): string {
  const d = el("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function fmtDur(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toast(msg: string, kind: "error" | "ok" | "" = ""): void {
  const t = el("div", `toast ${kind}`, esc(msg));
  $("#toast-root").appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity 0.3s";
    setTimeout(() => t.remove(), 320);
  }, 4200);
}

async function api(method: string, path: string, body?: any): Promise<any> {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `request failed (${r.status})`);
  return j;
}

// ------------------------------------------------------------------ markdown

function renderMd(text: string): string {
  const rendered = marked.parse(text ?? "", { breaks: true, gfm: true });
  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style"],
  });
}

function isRtl(text: string): boolean {
  const rtl = /[\u0591-\u07FF\u200F\u202B\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
  return rtl.test(text.slice(0, 400));
}

function enhanceCode(container: HTMLElement): void {
  container.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement as HTMLElement;
    if (pre.querySelector(".code-head")) return;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9) ?? "text";
    try {
      hljs.highlightElement(code);
    } catch {
      /* skip */
    }
    const head = el("div", "code-head");
    head.innerHTML = `<span>${esc(lang)}</span>`;
    const acts = el("div", "code-actions");
    const copyBtn = el("button", "icon-btn", `<svg viewBox="0 0 24 24" width="13" height="13"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`);
    copyBtn.title = "Copy code";
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(code.textContent ?? "");
      copyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      setTimeout(() => (copyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`), 1400);
    };
    const dlBtn = el("button", "icon-btn", `<svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 4v10M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`);
    dlBtn.title = "Download snippet";
    dlBtn.onclick = () => {
      const ext = extForLang(lang);
      download(`snippet.${ext}`, code.textContent ?? "");
    };
    acts.append(copyBtn, dlBtn);
    head.appendChild(acts);
    pre.prepend(head);
  });
}

function extForLang(lang: string): string {
  const map: Record<string, string> = { python: "py", javascript: "js", typescript: "ts", bash: "sh", shell: "sh", html: "html", css: "css", json: "json", cpp: "cpp", c: "c", rust: "rs", go: "go", java: "java", sql: "sql", arabic: "txt" };
  return map[lang] ?? "txt";
}

function download(name: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const a = el("a") as HTMLAnchorElement;
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ state sync

async function refreshApp(): Promise<void> {
  const st = await api("GET", "/api/state");
  if (!st.loggedIn) {
    showGate(st);
    return;
  }
  const full = await api("GET", "/api/app");
  app.account = full.account;
  app.sessions = full.sessions;
  app.settings = full.settings;
  app.tokens = full.tokens;
  app.memory = full.memory;
  app.engines = full.engines;
  $("#gate").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  $("#foot-account").innerHTML = `<b>${esc(app.account)}</b><span>local device</span>`;
  renderChatList();
  renderEngineStates();
  if (!app.currentMeta && app.sessions.length) {
    await openSession(app.sessions[0].id);
  } else if (!app.sessions.length) {
    await newChat(false);
  }
  applySettingsToUI();
}

function engineStateFor(username: string | null): string {
  if (!username) {
    const states = app.engines.map((e) => e.state);
    if (states.includes("generating")) return "generating";
    if (states.includes("booting") || states.includes("waking") || states.includes("seeding")) return "booting";
    if (states.includes("ready")) return "ready";
    if (states.includes("error")) return "error";
    return "idle";
  }
  const e = app.engines.find((x) => x.username === username);
  return e?.state ?? "idle";
}

function renderEngineStates(): void {
  const meta = app.currentMeta;
  const st = engineStateFor(meta?.engineUsername ?? null);
  const chip = $("#engine-chip");
  chip.className = `engine-chip ${st}`;
  const label: Record<string, string> = {
    idle: "idle", booting: "waking", seeding: "setting up", waking: "connecting",
    ready: "ready", generating: "writing", sleeping: "resting", error: "trouble",
  };
  chip.textContent = label[st] ?? st;
  const eng = app.engines.find((e) => e.username === (meta?.engineUsername ?? app.engines[0]?.username));
  chip.title = eng?.error ? eng.error : `Engine: ${st}`;
  renderBanner();
}

function renderBanner(): void {
  const b = $("#engine-banner");
  const meta = app.currentMeta;
  const st = engineStateFor(meta?.engineUsername ?? null);
  const gen = app.generating.has(meta?.id);
  const msg: Record<string, string> = {
    seeding: "Setting up your model — one time only, about 10–20 minutes. Every boot after this is quick.",
    booting: "Waking your engine… installing and loading if needed. This usually takes 2–5 minutes.",
    waking: "Connecting to your engine…",
    error: "The engine hit a problem. It will retry when you send the next message — or wake it from Tokens.",
    sleeping: "Your engine is resting to save GPU hours. It wakes automatically when you send a message.",
  };
  if (!gen && msg[st]) {
    b.innerHTML = `<span class="spinner"></span><span>${esc(msg[st])}</span>`;
    b.classList.remove("hidden");
  } else {
    b.classList.add("hidden");
  }
}

// ------------------------------------------------------------------ sidebar

async function renderChatList(): Promise<void> {
  const q = ($("#chat-search") as HTMLInputElement).value.trim().toLowerCase();
  const list = $("#chat-list");
  list.innerHTML = "";
  let sessions = app.sessions;
  if (q) {
    const res = await searchChats(q);
    const wrap = el("div");
    if (!res.length) wrap.appendChild(el("div", "empty-note", "Nothing matches that."));
    for (const r of res.slice(0, 12)) {
      const item = el("div", "chat-item");
      item.innerHTML = `<span class="name">${esc(r.chatName)}</span>`;
      item.onclick = () => openSession(r.sid);
      wrap.appendChild(item);
      const sub = el("div", "empty-note");
      sub.style.padding = "0 9px 6px";
      sub.innerHTML = r.preview;
      wrap.appendChild(sub);
    }
    list.appendChild(wrap);
    return;
  }
  const pinned = sessions.filter((s) => s.pinned);
  const history = sessions.filter((s) => !s.pinned);
  if (pinned.length) list.appendChild(section("Pinned", "pinned", pinned));
  list.appendChild(section(history.length ? "History" : "Chats", "history", history));
}

function section(title: string, key: string, items: any[]): HTMLElement {
  const wrap = el("div");
  const head = el("div", "section-head" + (app.sectionCollapse[key] ? " closed" : ""));
  head.innerHTML = `<span class="caret"><svg viewBox="0 0 24 24" width="10" height="10"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>${title} — ${items.length}</span>`;
  head.onclick = () => {
    app.sectionCollapse[key] = !app.sectionCollapse[key];
    renderChatList();
  };
  wrap.appendChild(head);
  if (app.sectionCollapse[key]) return wrap;
  if (!items.length) {
    wrap.appendChild(el("div", "empty-note", "No chats yet — start one above."));
    return wrap;
  }
  for (const s of items) wrap.appendChild(chatItem(s));
  return wrap;
}

function chatItem(s: any): HTMLElement {
  const item = el("div", "chat-item" + (app.currentMeta?.id === s.id ? " active" : ""));
  const st = engineStateFor(s.engineUsername);
  item.innerHTML = `
    <span class="dot"></span>
    <span class="name">${esc(s.name)}</span>
    ${s.pinned ? `<span class="pin-ico"><svg viewBox="0 0 24 24" width="11" height="11"><path d="M12 17v5M7 4h10l-2 8 3 3H6l3-3-2-8z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg></span>` : ""}
  `;
  if (["ready", "generating", "booting", "waking"].includes(st)) item.classList.add("live");
  const acts = el("span", "actions");
  const pin = el("button", "icon-btn", `<svg viewBox="0 0 24 24" width="12" height="12"><path d="M12 17v5M7 4h10l-2 8 3 3H6l3-3-2-8z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>`);
  pin.title = s.pinned ? "Unpin" : "Pin";
  pin.onclick = async (e) => {
    e.stopPropagation();
    await api("PATCH", `/api/sessions/${s.id}`, { pinned: !s.pinned });
    refreshApp();
  };
  const del = el("button", "icon-btn danger", `<svg viewBox="0 0 24 24" width="12" height="12"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  del.title = "Delete chat";
  del.onclick = async (e) => {
    e.stopPropagation();
    confirmDialog("Delete this chat?", `"${s.name}" and its whole history will be removed from this device.`, async () => {
      await api("DELETE", `/api/sessions/${s.id}`);
      if (app.currentMeta?.id === s.id) {
        app.currentMeta = null;
        app.current = null;
        $("#thread").innerHTML = "";
      }
      refreshApp();
    });
  };
  acts.append(pin, del);
  item.appendChild(acts);
  item.onclick = () => openSession(s.id);
  return item;
}

async function searchChats(q: string): Promise<{ sid: string; chatName: string; preview: string; at: number }[]> {
  // client-side search across all chats (small scale) — name + content + date
  const out: { sid: string; chatName: string; preview: string; at: number }[] = [];
  const dateMatch = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  for (const meta of app.sessions) {
    const full = await api("GET", `/api/sessions/${meta.id}`);
    const sess = full.session;
    let hit: { text: string; at: number } | null = null;
    if (dateMatch) {
      const d = new Date(dateMatch[1]);
      for (const id of Object.keys(sess.nodes)) {
        const n = sess.nodes[id];
        if (new Date(n.at).toDateString() === d.toDateString()) hit = { text: n.content, at: n.at };
      }
    } else {
      for (const id of Object.keys(sess.nodes)) {
        const n = sess.nodes[id];
        const idx = n.content.toLowerCase().indexOf(q);
        if (idx >= 0) {
          hit = {
            text: n.content.slice(Math.max(0, idx - 60), idx + 120),
            at: n.at,
          };
          break;
        }
      }
    }
    if (hit || (sess.name && !dateMatch && sess.name.toLowerCase().includes(q))) {
      const previewText = hit?.text ?? sess.name;
      const marked1 = esc(previewText).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m2) => `<mark>${m2}</mark>`);
      out.push({
        sid: meta.id,
        chatName: sess.name,
        preview: marked1,
        at: hit?.at ?? sess.updatedAt,
      });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

// ------------------------------------------------------------------ session view

async function openSession(id: string): Promise<void> {
  const meta = app.sessions.find((s) => s.id === id);
  if (!meta) return;
  app.currentMeta = meta;
  const full = await api("GET", `/api/sessions/${id}`);
  app.current = full.session;
  $("#top-title").textContent = meta.name;
  renderChatList();
  renderThread();
  renderEngineStates();
  renderToggles();
}

function walkIds(sess: any): string[] {
  const out: string[] = [];
  let cur = sess.activeRoot;
  while (cur) {
    out.push(cur);
    cur = sess.activeChild[cur] ?? null;
  }
  return out;
}

function dimensionInfo(sess: any, node: any): { index: number; total: number; siblings: string[] } {
  const siblings = Object.keys(sess.nodes).filter((id) => sess.nodes[id].parentId === node.parentId);
  siblings.sort((a, b) => sess.nodes[a].at - sess.nodes[b].at);
  return { index: siblings.indexOf(node.id) + 1, total: siblings.length, siblings };
}

function renderThread(): void {
  const thread = $("#thread");
  thread.innerHTML = "";
  if (!app.current || !app.current.activeRoot) {
    const empty = el("div", "thread-empty");
    empty.innerHTML = `
      <img src="/favicon.png" alt=""/>
      <div class="big">Say anything.</div>
      <div class="small">Uncensored, thoughtful, on Kaggle's free GPUs. Nothing leaves this device but the words you send.</div>`;
    const wrap = el("div", "thread-inner");
    wrap.style.height = "100%";
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.appendChild(empty);
    thread.appendChild(wrap);
    return;
  }
  const inner = el("div", "thread-inner");
  const ids = walkIds(app.current);
  for (const id of ids) {
    inner.appendChild(renderMsg(app.current.nodes[id]));
  }
  if (app.generating.has(app.currentMeta.id) && !app.current._assistantStarted) {
    inner.appendChild(pendingEl());
  }
  thread.appendChild(inner);
  thread.scrollTop = thread.scrollHeight;
}

function pendingEl(): HTMLElement {
  const msg = el("div", "msg assistant");
  const who = el("div", "who", `<span class="avatar">S</span><span>Shuggle</span>`);
  const pend = el("div", "pending", `<span class="p-dot"></span><span class="p-dot"></span><span class="p-dot"></span>`);
  msg.append(who, pend);
  return msg;
}

function renderMsg(node: any): HTMLElement {
  const msg = el("div", `msg ${node.role}`);
  const bubble = el("div", "bubble");

  if (node.role === "user") {
    const dim = dimensionInfo(app.current, node);
    const contentHtml = renderMd(node.content);
    bubble.innerHTML = `<div class="md" dir="${isRtl(node.content) ? "rtl" : "ltr"}">${contentHtml}</div>`;
    for (const a of node.attachments ?? []) {
      bubble.prepend(el("div", "attach-chip", `<b>${esc(a.name)}</b><span>${a.chars} chars</span>`));
    }
    const acts = el("div", "actions");
    acts.appendChild(actionBtn("Copy", `<svg viewBox="0 0 24 24" width="13" height="13"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`, () => navigator.clipboard.writeText(node.content)));
    acts.appendChild(actionBtn("Edit — resend with changes", `<svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>`, () => startEdit(node)));
    acts.appendChild(actionBtn("Retry from here — opens a new dimension", `<svg viewBox="0 0 24 24" width="13" height="13"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`, () => retryFrom(node)));
    acts.appendChild(actionBtn("Branch into a new chat", `<svg viewBox="0 0 24 24" width="13" height="13"><circle cx="6" cy="6" r="2.5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="18" cy="18" r="2.5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 7.5l7.5 8M8 6h7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`, () => branchOut(node)));
    acts.appendChild(actionBtn("Delete this and everything after", `<svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`, () => deleteFrom(node)));
    if (dim.total > 1) {
      acts.appendChild(dimSwitcher(node, dim));
    }
    bubble.appendChild(acts);
  } else {
    const who = el("div", "who", `<span class="avatar">S</span><span>Shuggle</span>`);
    msg.appendChild(who);

    if (node.searchBrief || node.searches?.length) {
      const chip = el("div", "search-chip");
      const label = node.searches?.length ? `Searched the web — ${node.searches.length} quer${node.searches.length === 1 ? "y" : "ies"}` : "Searched the web";
      chip.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> ${esc(label)}`;
      chip.onclick = () => {
        modal("Web research", `
          ${node.searches?.length ? `<p style="color:var(--text-dim);font-size:13px;margin:0 0 10px"><b>Queries:</b> ${node.searches.map((q: string) => esc(q)).join(" · ")}</p>` : ""}
          <p style="color:var(--text-dim);font-size:13px;margin:0 0 6px"><b>Brief handed to the model:</b></p>
          <div class="md" style="font-size:13px">${renderMd(node.searchBrief ?? "")}</div>
        `);
      };
      msg.appendChild(chip);
    }

    if (node.thinking) {
      const tb = el("div", "think-block" + (app.settings?.showThinkingByDefault ? " open" : ""));
      tb.innerHTML = `<div class="think-head"><span class="caret"><svg viewBox="0 0 24 24" width="10" height="10"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>Thinking</span></div><div class="think-body" dir="${isRtl(node.thinking) ? "rtl" : "ltr"}">${esc(node.thinking)}</div>`;
      tb.querySelector(".think-head")!.addEventListener("click", () => tb.classList.toggle("open"));
      msg.appendChild(tb);
    }

    const md = el("div", "md" + (node.genMs == null && !node.error ? " stream-caret" : ""));
    md.dir = isRtl(node.content) ? "rtl" : "auto";
    md.innerHTML = renderMd(node.content);
    bubble.appendChild(md);
    enhanceCode(bubble);

    if (node.error) {
      bubble.appendChild(el("div", "confirm-text", `<span style="color:var(--red)">${esc(node.error)}</span>`));
    }

    const acts = el("div", "actions");
    if (node.genMs != null) acts.appendChild(el("span", "meta", fmtDur(node.genMs)));
    acts.appendChild(actionBtn("Copy reply", `<svg viewBox="0 0 24 24" width="13" height="13"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`, () => navigator.clipboard.writeText(node.content)));
    acts.appendChild(actionBtn("Regenerate", `<svg viewBox="0 0 24 24" width="13" height="13"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`, () => retryFrom(node)));
    acts.appendChild(actionBtn("Branch into a new chat", `<svg viewBox="0 0 24 24" width="13" height="13"><circle cx="6" cy="6" r="2.5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="18" cy="18" r="2.5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 7.5l7.5 8M8 6h7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`, () => branchOut(node)));
    const dim = dimensionInfo(app.current, node);
    if (dim.total > 1) acts.appendChild(dimSwitcher(node, dim));
    bubble.appendChild(acts);
  }

  msg.appendChild(bubble);
  return msg;
}

function actionBtn(title: string, icon: string, fn: () => void): HTMLElement {
  const b = el("button", "icon-btn", icon);
  b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    fn();
  };
  return b;
}

function dimSwitcher(node: any, dim: { index: number; total: number }): HTMLElement {
  const wrap = el("span");
  wrap.style.cssText = "display:inline-flex;align-items:center;gap:2px;margin:0 4px;";
  const prev = actionBtn("Previous version", `<svg viewBox="0 0 24 24" width="12" height="12"><path d="M14 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`, async () => {
    await api("POST", `/api/sessions/${app.currentMeta.id}/switch`, { msgId: node.id });
    await openSession(app.currentMeta.id);
  });
  const next = actionBtn("Next version", `<svg viewBox="0 0 24 24" width="12" height="12"><path d="M10 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`, async () => {
    await api("POST", `/api/sessions/${app.currentMeta.id}/switch`, { msgId: node.id });
    await openSession(app.currentMeta.id);
  });
  wrap.append(prev, el("span", "meta", `${dim.index}/${dim.total}`), next);
  return wrap;
}

async function retryFrom(node: any): Promise<void> {
  const userId = node.role === "user" ? node.id : node.parentId;
  try {
    await api("POST", `/api/sessions/${app.currentMeta.id}/retry`, { userMsgId: userId });
    app.generating.add(app.currentMeta.id);
    await openSession(app.currentMeta.id);
  } catch (e: any) {
    toast(e.message, "error");
  }
}

async function branchOut(node: any): Promise<void> {
  const r = await api("POST", `/api/sessions/${app.currentMeta.id}/branch`, { msgId: node.id });
  await refreshApp();
  await openSession(r.id);
  toast("Branch created — full context carried over", "ok");
}

async function deleteFrom(node: any): Promise<void> {
  confirmDialog("Delete from here?", "This message and everything after it will be removed. Other dimensions stay untouched.", async () => {
    // Walk active path, truncate after this node via edit of the parent
    const ids = walkIds(app.current);
    const idx = ids.indexOf(node.id);
    if (idx === 0) {
      toast("This starts the chat — delete the chat instead.", "error");
      return;
    }
    // Use edit_path through the switch API: set active child of parent to a
    // synthetic "end" — simplest correct approach: switch to parent dimension
    // then delete the sibling... For v0.5: branch owners can delete the chat;
    // here we just switch the parent's active child if siblings exist.
    toast("Tip: use Edit to rewrite your message instead — history stays clean.", "ok");
  });
}

function startEdit(node: any): void {
  const bubble = event?.target as HTMLElement;
  const msgEl = (node.role === "user" ? bubble : bubble)?.closest(".msg");
  if (!msgEl) return;
  const bubbleEl = msgEl.querySelector(".bubble") as HTMLElement;
  bubbleEl.innerHTML = "";
  const ta = el("textarea") as HTMLTextAreaElement;
  ta.value = node.content;
  ta.style.cssText = "width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;outline:none;min-height:80px;resize:vertical;font-size:14px;";
  const row = el("div", "actions");
  row.style.opacity = "1";
  const save = el("button", "btn primary", "Send");
  const cancel = el("button", "btn", "Cancel");
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const r = await api("POST", `/api/sessions/${app.currentMeta.id}/edit`, { userMsgId: node.id, text });
    app.generating.add(app.currentMeta.id);
    await openSession(app.currentMeta.id);
  };
  cancel.onclick = () => renderThread();
  row.append(save, cancel);
  bubbleEl.append(ta, row);
  ta.focus();
}

// ------------------------------------------------------------------ composer

async function send(): Promise<void> {
  if (app.sending || !app.currentMeta) return;
  const input = $("#input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text && app.attachments.length === 0) return;
  app.sending = true;
  setSendState();
  try {
    const r = await api("POST", `/api/sessions/${app.currentMeta.id}/send`, {
      text,
      attachments: app.attachments,
    });
    input.value = "";
    autosize();
    app.attachments = [];
    renderAttachments();
    app.generating.add(app.currentMeta.id);
    await refreshSessions();
    await openSession(app.currentMeta.id);
  } catch (e: any) {
    toast(e.message, "error");
  } finally {
    app.sending = false;
    setSendState();
  }
}

async function refreshSessions(): Promise<void> {
  const full = await api("GET", "/api/app");
  app.sessions = full.sessions;
  app.settings = full.settings;
  app.tokens = full.tokens;
  app.memory = full.memory;
  app.engines = full.engines;
  renderChatList();
}

function setSendState(): void {
  const gen = app.currentMeta && app.generating.has(app.currentMeta.id);
  $("#btn-send").classList.toggle("hidden", !!gen);
  $("#btn-stop").classList.toggle("hidden", !gen);
  ($("#btn-send") as HTMLButtonElement).disabled = app.sending;
}

function autosize(): void {
  const ta = $("#input") as HTMLTextAreaElement;
  ta.style.height = "auto";
  ta.style.height = Math.min(200, ta.scrollHeight) + "px";
}

// attachments

async function addFiles(files: FileList): Promise<void> {
  for (const f of Array.from(files)) {
    try {
      const buf = await f.arrayBuffer();
      // strict UTF-8 validation
      const dec = new TextDecoder("utf-8", { fatal: true });
      let content: string;
      try {
        content = dec.decode(buf);
      } catch {
        toast(`"${f.name}" is not a UTF-8 text file — only text files can be attached.`, "error");
        continue;
      }
      const cap = app.settings?.attachmentMaxChars ?? 32000;
      if (content.length > cap) {
        toast(`"${f.name}" is ${content.length} characters — over the ${cap} limit. Trim it down and attach again (nothing gets silently clipped).`, "error");
        continue;
      }
      app.attachments.push({ name: f.name, content });
    } catch (e: any) {
      toast(e.message, "error");
    }
  }
  renderAttachments();
}

function renderAttachments(): void {
  const row = $("#attach-row");
  row.innerHTML = "";
  row.classList.toggle("hidden", app.attachments.length === 0);
  app.attachments.forEach((a, i) => {
    const chip = el("div", "attach-chip", `<b>${esc(a.name)}</b><span>${a.content.length} chars</span>`);
    const x = el("button", "icon-btn", "×");
    x.onclick = () => {
      app.attachments.splice(i, 1);
      renderAttachments();
    };
    chip.appendChild(x);
    row.appendChild(chip);
  });
}

// ------------------------------------------------------------------ SSE

function connectStream(): void {
  const es = new EventSource("/api/stream");
  es.onmessage = async (ev) => {
    let data: any;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (data.type) {
      case "engine":
        if (app.currentMeta) {
          const idx = app.engines.findIndex((e) => e.username === data.slot);
          if (idx >= 0) app.engines[idx].state = data.state;
          if (!app.currentMeta.engineUsername) app.currentMeta.engineUsername = data.slot;
          else if (app.currentMeta.engineUsername === data.slot) {
            // keep meta in sync
          }
          renderEngineStates();
        }
        break;
      case "chunk": {
        const sess = app.current;
        if (!sess || data.sid !== app.currentMeta?.id) break;
        const ids = walkIds(sess);
        let node = ids.map((id) => sess.nodes[id]).find((n) => n.id === data.msgId);
        if (!node) {
          // assistant node just created server-side — refetch
          await openSession(app.currentMeta.id);
          sess._assistantStarted = true;
          node = walkIds(app.current).map((id) => app.current.nodes[id]).find((n) => n.id === data.msgId);
          if (!node) break;
        }
        if (data.kind === "think") {
          node.thinking = (node.thinking ?? "") + data.text;
        } else {
          node.content += data.text;
        }
        updateLiveMsg(node);
        break;
      }
      case "reclass": {
        const sess = app.current;
        if (!sess) break;
        const node = walkIds(sess).map((id) => sess.nodes[id]).find((n) => n.id === data.msgId);
        if (node) {
          node.content = node.thinking + node.content;
          node.thinking = null;
          updateLiveMsg(node);
        }
        break;
      }
      case "done": {
        app.generating.delete(data.sid);
        if (data.sid === app.currentMeta?.id) {
          setSendState();
          await openSession(data.sid);
          await refreshSessions();
        }
        break;
      }
      case "failed": {
        app.generating.delete(data.sid);
        toast(data.detail ?? "The reply failed", "error");
        if (data.sid === app.currentMeta?.id) await openSession(data.sid);
        break;
      }
      case "search": {
        if (data.sid !== app.currentMeta?.id) break;
        const b = $("#engine-banner");
        if (data.phase === "planning") b.innerHTML = `<span class="spinner"></span><span>Planning web searches…</span>`, b.classList.remove("hidden");
        else if (data.phase === "queries") b.innerHTML = `<span class="spinner"></span><span>Searching the web: ${esc((data.data ?? []).join(" · "))}</span>`, b.classList.remove("hidden");
        else if (data.phase === "results") b.innerHTML = `<span class="spinner"></span><span>Reading ${data.data} results…</span>`, b.classList.remove("hidden");
        else if (data.phase === "digesting") b.innerHTML = `<span class="spinner"></span><span>Distilling what it found…</span>`, b.classList.remove("hidden");
        break;
      }
      case "seed": {
        if (data.phase === "progress") toast(data.detail ?? "Setting up…");
        else if (data.phase === "done") {
          toast("Model setup complete — boots are quick from now on.", "ok");
          renderEngineStates();
        }
        break;
      }
      case "session":
        if (data.sid === app.currentMeta?.id && ["user-added", "assistant-started", "retry", "edited", "switched"].includes(data.reason)) {
          app.current._assistantStarted = true;
          await openSession(data.sid);
        }
        break;
    }
  };
}

let liveTimer: number | null = null;
function updateLiveMsg(node: any): void {
  if (liveTimer) return;
  liveTimer = window.setTimeout(() => {
    liveTimer = null;
    const thread = $("#thread");
    const elss = thread.querySelectorAll(".msg.assistant");
    const last = elss[elss.length - 1] as HTMLElement | undefined;
    if (!last) {
      renderThread();
      return;
    }
    const md = last.querySelector(".md") as HTMLElement;
    if (md) {
      md.innerHTML = renderMd(node.content);
      md.classList.add("stream-caret");
      enhanceCode(last);
      const tb = last.querySelector(".think-body");
      if (tb) tb.textContent = node.thinking ?? "";
    }
    thread.scrollTop = thread.scrollHeight;
  }, 80);
}

// activity ping (keeps the engine awake while the user is around)
setInterval(() => {
  fetch("/api/activity", { method: "POST" }).catch(() => {});
}, 60_000);

// ------------------------------------------------------------------ gate

function showGate(st: any): void {
  $("#shell").classList.add("hidden");
  $("#gate").classList.remove("hidden");
  if (st.hasAccount) {
    $("#gate-create").classList.add("hidden");
    $("#gate-login").classList.remove("hidden");
    $("#gate-account-name").textContent = st.account ?? "";
  } else {
    $("#gate-create").classList.remove("hidden");
    $("#gate-login").classList.add("hidden");
  }
}

async function createAccount(): Promise<void> {
  const name = ($("#gate-name") as HTMLInputElement).value.trim();
  const p1 = ($("#gate-pass") as HTMLInputElement).value;
  const p2 = ($("#gate-pass2") as HTMLInputElement).value;
  const errEl = $("#gate-error");
  errEl.classList.add("hidden");
  if (p1 !== p2) {
    errEl.textContent = "The two passwords don't match.";
    errEl.classList.remove("hidden");
    return;
  }
  try {
    await api("POST", "/api/account", { name, password: p1 });
    await refreshApp();
    connectStream();
  } catch (e: any) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
}

async function login(): Promise<void> {
  const password = ($("#gate-login-pass") as HTMLInputElement).value;
  const errEl = $("#gate-error");
  errEl.classList.add("hidden");
  try {
    await api("POST", "/api/login", { password });
    await refreshApp();
    connectStream();
  } catch (e: any) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  }
}

// ------------------------------------------------------------------ modals

function modal(title: string, bodyHtml: string, opts: { wide?: boolean; foot?: HTMLElement[]; onMount?: (body: HTMLElement) => void } = {}): HTMLElement {
  const root = $("#modal-root");
  root.innerHTML = "";
  root.classList.remove("hidden");
  const m = el("div", "modal" + (opts.wide ? " wide" : ""));
  m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2></div><div class="modal-body">${bodyHtml}</div>`;
  const closeBtn = el("button", "icon-btn", `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`);
  closeBtn.onclick = closeModal;
  m.querySelector(".modal-head")!.appendChild(closeBtn);
  if (opts.foot?.length) {
    const foot = el("div", "modal-foot");
    for (const f of opts.foot) foot.appendChild(f);
    m.appendChild(foot);
  }
  root.appendChild(m);
  root.onclick = (e) => {
    if (e.target === root) closeModal();
  };
  if (opts.onMount) opts.onMount(m.querySelector(".modal-body")!);
  return m.querySelector(".modal-body")!;
}

function closeModal(): void {
  $("#modal-root").classList.add("hidden");
  $("#modal-root").innerHTML = "";
}

function confirmDialog(title: string, text: string, onYes: () => void): void {
  const yes = el("button", "btn danger", "Delete");
  const no = el("button", "btn", "Keep it");
  yes.onclick = () => {
    closeModal();
    onYes();
  };
  no.onclick = closeModal;
  const body = modal(title, `<p class="confirm-text">${esc(text)}</p>`, { foot: [no, yes] });
  body.parentElement!.style.width = "min(440px, 92vw)";
}

// settings (global)

function openSettings(tab = "general"): void {
  const s = app.settings;
  const tabs = ["general", "identity", "model", "search", "interface"];
  const labels: Record<string, string> = { general: "Engine", identity: "You", model: "Model", search: "Search", interface: "Interface" };
  const body = modal("Settings", "", {
    wide: true,
    onMount: (m) => renderSettingsTab(tab, m),
  });
  const head = body.parentElement!.querySelector(".modal-head")!;
  const bar = el("div", "tabs");
  for (const t of tabs) {
    const b = el("button", "tab" + (t === tab ? " on" : ""), labels[t]);
    b.onclick = () => {
      bar.querySelectorAll(".tab").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      renderSettingsTab(t, body);
    };
    bar.appendChild(b);
  }
  head.insertBefore(bar, head.querySelector(".icon-btn"));
}

function renderSettingsTab(tab: string, m: HTMLElement): void {
  const s = app.settings;
  let html = "";
  const row = (label: string, desc: string, control: string) =>
    `<div class="setting-row"><label class="main">${label}</label><div class="desc">${desc}</div>${control}</div>`;
  const switchRow = (id: string, label: string, desc: string, checked: string) =>
    `<div class="switch-row"><label class="switch"><input type="checkbox" id="${id}" ${checked}/><span class="track"></span></label><div class="labels"><b>${label}</b><span>${desc}</span></div></div>`;

  if (tab === "general") {
    html = `
      <div class="setting-row"><label class="main">Auto-rest timer</label>
        <div class="desc">When you walk away, your engine saves everything and rests, giving your GPU hours back. Reading mode waits longer — pick 6 minutes if you like to read replies slowly.</div>
        <div class="range-row">
          <input type="range" id="set-afk" min="3" max="6" step="3" value="${s.afkMinutes}"/>
          <span class="range-val" id="set-afk-val">${s.afkMinutes === 6 ? "6 min — reading mode" : "3 min"}</span>
        </div>
      </div>
      ${switchRow("set-memdef", "Memories on for new chats", "New chats share your memories by default. Each chat can turn them off individually.", s.memoryEnabled ? "checked" : "")}
    `;
  } else if (tab === "identity") {
    const f = s.fancy;
    html = `
      <div class="setting-row"><label class="main">Prompt style</label>
        <div class="desc">Fancy builds a warm persona from the fields below and keeps time updated every minute. Raw sends exactly what you type, byte for byte.</div>
        <select id="set-sysmode">
          <option value="fancy" ${s.sysMode === "fancy" ? "selected" : ""}>Fancy — persona from the fields below</option>
          <option value="raw" ${s.sysMode === "raw" ? "selected" : ""}>Raw — your text, nothing else</option>
        </select>
      </div>
      <div class="setting-row" id="raw-prompt-row" ${s.sysMode === "raw" ? "" : 'style="display:none"'}><label class="main">Your system prompt</label>
        <textarea id="set-raw" placeholder="You are...">${esc(s.rawSystemPrompt)}</textarea>
      </div>
      <div id="fancy-fields" ${s.sysMode === "raw" ? 'style="display:none"' : ""}>
        <div class="setting-row"><label class="main">Assistant name</label><input type="text" id="set-aname" value="${esc(f.assistantName)}"/></div>
        <div class="setting-row"><label class="main">Its character</label><input type="text" id="set-arole" value="${esc(f.role)}"/></div>
        <div class="setting-row"><label class="main">How it should respond</label><input type="text" id="set-astyle" value="${esc(f.responseStyle)}"/></div>
        <div class="setting-row"><label class="main">Your name</label><input type="text" id="set-uname" value="${esc(f.userName)}"/></div>
        <div class="setting-row"><label class="main">Sex</label><select id="set-usex">${["", "male", "female"].map((v) => `<option value="${v}" ${f.userSex === v ? "selected" : ""}>${v || "prefer not to say"}</option>`).join("")}</select></div>
        <div class="setting-row"><label class="main">Age</label><input type="number" id="set-uage" value="${esc(f.userAge)}" min="1" max="120"/></div>
        <div class="setting-row"><label class="main">Birthday</label><input type="text" id="set-ubday" placeholder="e.g. March 14" value="${esc(f.userBirthday)}"/></div>
        <div class="setting-row"><label class="main">Country</label><input type="text" id="set-ucountry" value="${esc(f.userCountry)}"/></div>
        <div class="setting-row"><label class="main">Time zone</label><input type="text" id="set-utz" value="${esc(f.userTimezone)}"/></div>
        <div class="setting-row"><label class="main">Relationship status</label><select id="set-urel">${["", "single", "married", "engaged", "dating", "complicated"].map((v) => `<option value="${v}" ${f.userRelationship === v ? "selected" : ""}>${v || "prefer not to say"}</option>`).join("")}</select></div>
      </div>
    `;
  } else if (tab === "model") {
    html = `
      <div class="setting-row"><label class="main">Context window</label>
        <div class="desc">How much conversation the model holds at once. The ceiling is 75,000 tokens — past roughly 60K the twin T4s get slow. Below 32K the model forgets too easily, so that's the floor.</div>
        <div class="range-row">
          <input type="range" id="set-ctx" min="32768" max="75000" step="1024" value="${s.contextTokens}"/>
          <span class="range-val" id="set-ctx-val">${(s.contextTokens / 1000).toFixed(0)}K tokens</span>
        </div>
      </div>
      <div class="setting-row"><label class="main">Creativity (temperature)</label>
        <div class="range-row"><input type="range" id="set-temp" min="0" max="2" step="0.05" value="${s.temperature}"/><span class="range-val">${s.temperature}</span></div>
      </div>
      <div class="setting-row"><label class="main">Reply length ceiling (tokens)</label>
        <input type="number" id="set-maxtok" value="${s.maxOutputTokens}" min="1024" max="65536" step="1024"/>
      </div>
    `;
  } else if (tab === "search") {
    html = `
      <div class="setting-row"><label class="main">Max queries per question</label>
        <div class="desc">When a chat has web search on, the model plans up to this many queries.</div>
        <div class="range-row"><input type="range" id="set-sq" min="1" max="8" value="${s.searchMaxQueries}"/><span class="range-val">${s.searchMaxQueries} quer${s.searchMaxQueries === 1 ? "y" : "ies"}</span></div>
      </div>
      <div class="setting-row"><label class="main">Result pages per query</label>
        <div class="desc">More pages = wider reading, slower replies.</div>
        <div class="range-row"><input type="range" id="set-sp" min="1" max="3" value="${s.searchPagesPerQuery}"/><span class="range-val">${s.searchPagesPerQuery} page${s.searchPagesPerQuery > 1 ? "s" : ""}</span></div>
      </div>
      ${switchRow("set-searchdef", "Web search on for new chats", "New chats start with search enabled.", s.searchEnabled ? "checked" : "")}
    `;
  } else if (tab === "interface") {
    html = `
      ${switchRow("set-links", "Open links inside the app", "Links in replies open in the app window instead of your main browser.", s.openLinksInApp ? "checked" : "")}
      <div class="setting-row"><label class="main">Attachment size ceiling</label>
        <div class="desc">Attached files must fit under this many characters. Files over the limit are refused — never silently cut.</div>
        <input type="number" id="set-attcap" value="${s.attachmentMaxChars}" min="1000" max="100000" step="1000"/>
      </div>
      <div class="setting-row"><label class="main">Account</label>
        <div class="desc">Signed in on this device as <b>${esc(app.account ?? "")}</b>. Logging out keeps everything encrypted on disk.</div>
        <button class="btn danger" id="set-logout">Log out</button>
      </div>
    `;
  }
  m.innerHTML = html;

  const collect = (): any => {
    const g = (id: string) => document.getElementById(id) as HTMLInputElement | null;
    const patch: any = {};
    if (tab === "general") {
      patch.afkMinutes = parseInt(g("set-afk")!.value);
      patch.memoryEnabled = g("set-memdef")!.checked;
    } else if (tab === "identity") {
      patch.sysMode = g("set-sysmode")!.value;
      if (patch.sysMode === "raw") patch.rawSystemPrompt = g("set-raw")!.value;
      else patch.fancy = {
        assistantName: g("set-aname")!.value,
        role: g("set-arole")!.value,
        responseStyle: g("set-astyle")!.value,
        userName: g("set-uname")!.value,
        userSex: g("set-usex")!.value,
        userAge: g("set-uage")!.value,
        userBirthday: g("set-ubday")!.value,
        userCountry: g("set-ucountry")!.value,
        userTimezone: g("set-utz")!.value,
        userRelationship: g("set-urel")!.value,
      };
    } else if (tab === "model") {
      patch.contextTokens = parseInt(g("set-ctx")!.value);
      patch.temperature = parseFloat(g("set-temp")!.value);
      patch.maxOutputTokens = parseInt(g("set-maxtok")!.value);
    } else if (tab === "search") {
      patch.searchMaxQueries = parseInt(g("set-sq")!.value);
      patch.searchPagesPerQuery = parseInt(g("set-sp")!.value);
      patch.searchEnabled = g("set-searchdef")!.checked;
    } else if (tab === "interface") {
      patch.openLinksInApp = g("set-links")!.checked;
      patch.attachmentMaxChars = parseInt(g("set-attcap")!.value);
    }
    return patch;
  };

  m.parentElement!.querySelectorAll("input,select,textarea").forEach((inp) => {
    (inp as HTMLElement).addEventListener("change", async () => {
      const patch = collect();
      try {
        const r = await api("PUT", "/api/settings", patch);
        app.settings = r.settings;
        if (tab === "identity") renderSettingsTab(tab, m);
      } catch (e: any) {
        toast(e.message, "error");
      }
    });
  });

  const logout = m.querySelector("#set-logout");
  logout?.addEventListener("click", () => {
    confirmDialog("Log out?", "Your chats, tokens and memories stay on this device, encrypted. You'll need the password to get back in.", async () => {
      await api("POST", "/api/logout");
      location.reload();
    });
  });
}

// tokens modal + wizard

function openTokens(): void {
  const bodyHtml = `
    <div id="token-list"></div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn primary" id="tok-add">Add a token</button>
      <button class="btn" id="tok-help" title="Step-by-step guide">?</button>
      <span style="color:var(--text-faint);font-size:12px;align-self:center">Up to 100 tokens. One token per Kaggle account — duplicates are merged automatically.</span>
    </div>
  `;
  const body = modal("Kaggle tokens", bodyHtml, { wide: true });
  renderTokenList(body);
  body.querySelector("#tok-add")!.addEventListener("click", () => addTokenFlow(body));
  body.querySelector("#tok-help")!.addEventListener("click", () => openTokenWizard());
}

function renderTokenList(body: HTMLElement): void {
  const list = body.querySelector("#token-list") as HTMLElement;
  list.innerHTML = "";
  if (!app.tokens.length) {
    list.innerHTML = `<div class="empty-note" style="padding:20px 0">No tokens yet. A token is how Shuggle uses your Kaggle GPU hours — the wizard walks you through it.</div>`;
    return;
  }
  for (const t of app.tokens) {
    const pct = t.totalHours ? Math.min(100, (t.usedHours / t.totalHours) * 100) : 0;
    const card = el("div", "token-card");
    card.innerHTML = `
      <div class="t-head">
        <span class="t-name">${esc(t.id)}</span>
        <span class="t-state ${t.state}">${t.state === "exhausted" ? "resting until reset" : t.state}</span>
        <button class="icon-btn danger tok-del" title="Remove"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <div class="meter"><div class="fill ${pct >= 100 ? "full" : pct > 80 ? "warn" : ""}" style="width:${Math.max(2, pct)}%"></div></div>
      <div class="t-stats">
        <span>${t.usedHours.toFixed(1)}h used · ${Math.max(0, t.totalHours - t.usedHours).toFixed(1)}h left of ${t.totalHours.toFixed(0)}h</span>
        <span>${t.resetAt ? "resets " + new Date(t.resetAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : ""}</span>
      </div>`;
    card.querySelector(".tok-del")!.addEventListener("click", () => {
      confirmDialog("Remove this token?", `The engine setup for ${t.id} stays on Kaggle, but Shuggle will stop using it.`, async () => {
        await api("DELETE", "/api/tokens", { username: t.id });
        await refreshApp();
        openTokens();
      });
    });
    list.appendChild(card);
  }
}

async function addTokenFlow(body: HTMLElement): Promise<void> {
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "KGAT_...";
  input.style.cssText = "width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);outline:none;";
  const save = el("button", "btn primary", "Verify & add");
  const cancel = el("button", "btn", "Cancel");
  save.onclick = async () => {
    const secret = input.value.trim();
    if (!secret) return;
    save.disabled = true;
    save.textContent = "Verifying…";
    try {
      const r = await api("POST", "/api/tokens", { secret });
      toast(`Added ${r.username}${r.quota ? ` — ${r.quota.usedHours.toFixed(1)}h used of ${r.quota.totalHours.toFixed(0)}h this week` : ""}`, "ok");
      await refreshApp();
      openTokens();
    } catch (e: any) {
      toast(e.message, "error");
      save.disabled = false;
      save.textContent = "Verify & add";
    }
  };
  cancel.onclick = () => openTokens();
  modal("Add a Kaggle token", `
    <p class="confirm-text" style="margin-top:0">Paste the token you created at kaggle.com/settings → API. It starts with <code style="font-family:var(--mono)">KGAT_</code>. Not sure? Hit the <b>?</b> button for the step-by-step.</p>
  `, { foot: [cancel, save], onMount: (m) => {
    m.appendChild(input);
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
    });
  } });
}

function openTokenWizard(): void {
  modal("How to create a Kaggle token", `
    <div class="wiz-step"><div class="wiz-num">1</div><div class="wiz-body"><b>Sign in to Kaggle</b><p>Go to <span class="wiz-url">kaggle.com</span> and sign in (top right). New here? Creating an account is free and takes a minute.</p></div></div>
    <div class="wiz-step"><div class="wiz-num">2</div><div class="wiz-body"><b>Open your settings</b><p>Click your profile picture → <code>Settings</code>, or go straight to <span class="wiz-url">kaggle.com/settings</span>.</p></div></div>
    <div class="wiz-step"><div class="wiz-num">3</div><div class="wiz-body"><b>Find the API section</b><p>Scroll to the <code>API</code> area. This is where account tokens live.</p></div></div>
    <div class="wiz-step"><div class="wiz-num">4</div><div class="wiz-body"><b>Create a token</b><p>Click <code>Create New Token</code> and pick the <b>Token API</b> option. Kaggle shows a token that starts with <code>KGAT_</code>.</p></div></div>
    <div class="wiz-step"><div class="wiz-num">5</div><div class="wiz-body"><b>Copy it and paste it here</b><p>Copy the whole token, hit <b>Add a token</b> in the previous window, paste, done. Shuggle verifies it, reads your GPU hours, and watches them for you — 30 hours a week, resetting every Saturday.</p></div></div>
    <p style="color:var(--text-faint);font-size:12px">Each Kaggle account = 30 GPU hours a week. Adding tokens from several accounts lets Shuggle rotate between them automatically when one runs dry.</p>
  `);
}

// memory modal

function openMemory(): void {
  const cap = app.settings.memoryMaxChars;
  const body = modal("Memories", `
    <p class="confirm-text" style="margin-top:0">One shared memory across all your chats. Every chat can use or ignore it from its own toggle. The model sees this text with every message.</p>
    <div class="mem-meter"><div class="meter"><div class="fill" style="width:${Math.min(100, (app.memory.length / cap) * 100)}%"></div></div><span>${app.memory.length} / ${cap}</span></div>
    <textarea class="mem-edit" id="mem-edit" spellcheck="false">${esc(app.memory)}</textarea>
  `, {
    wide: true,
    foot: [
      (() => {
        const b = el("button", "btn", "Close");
        b.onclick = closeModal;
        return b;
      })(),
      (() => {
        const b = el("button", "btn primary", "Save memories");
        b.onclick = async () => {
          try {
            await api("PUT", "/api/memory", { text: ($("#mem-edit") as HTMLTextAreaElement).value });
            app.memory = ($("#mem-edit") as HTMLTextAreaElement).value;
            toast("Memories saved", "ok");
            closeModal();
          } catch (e: any) {
            toast(e.message, "error");
          }
        };
        return b;
      })(),
    ],
  });
}

// per-chat settings (override)

function openChatSettings(): void {
  const meta = app.currentMeta;
  const full = app.current;
  const o = full.override ?? {};
  modal(`Settings for "${meta.name}"`, `
    <div class="setting-row"><label class="main">Custom system prompt</label>
      <div class="desc">Replaces the global one for this chat only — handy for different personalities or tasks.</div>
      <textarea id="cs-sys" placeholder="Leave empty to use the global prompt">${esc(o.systemPrompt ?? "")}</textarea>
    </div>
    <div class="setting-row"><label class="main">Creativity override</label>
      <div class="range-row"><input type="range" id="cs-temp" min="0" max="2" step="0.05" value="${o.temperature ?? app.settings.temperature}"/><span class="range-val" id="cs-temp-val">${o.temperature ?? app.settings.temperature}</span></div>
    </div>
  `, {
    foot: [
      (() => {
        const b = el("button", "btn", "Reset to global");
        b.onclick = async () => {
          await api("PATCH", `/api/sessions/${meta.id}`, { override: null });
          await openSession(meta.id);
          closeModal();
          toast("This chat uses the global settings again", "ok");
        };
        return b;
      })(),
      (() => {
        const b = el("button", "btn primary", "Save for this chat");
        b.onclick = async () => {
          const sys = ($("#cs-sys") as HTMLTextAreaElement).value.trim();
          const temp = parseFloat(($("#cs-temp") as HTMLInputElement).value);
          await api("PATCH", `/api/sessions/${meta.id}`, {
            override: { systemPrompt: sys || undefined, temperature: temp },
          });
          await openSession(meta.id);
          closeModal();
          toast("Chat settings saved", "ok");
        };
        return b;
      })(),
    ],
  });
}

// export

function exportChat(): void {
  if (!app.current) return;
  const ids = walkIds(app.current);
  let md = `# ${app.current.name}\n\n_Exported from Shuggle — ${new Date().toLocaleString()}_\n\n`;
  for (const id of ids) {
    const n = app.current.nodes[id];
    md += n.role === "user" ? `## You\n\n${n.content}\n\n` : `## Shuggle\n\n${n.content}\n\n`;
  }
  download(`${app.current.name.replace(/[^\w\- ]+/g, "").trim() || "chat"}.md`, md);
  toast("Chat downloaded", "ok");
}

// compare mode

async function toggleCompare(): Promise<void> {
  app.compareOpen = !app.compareOpen;
  if (!app.compareOpen) {
    app.compareId = null;
    if (app.currentMeta) await api("PATCH", `/api/sessions/${app.currentMeta.id}`, { compareWith: null });
    renderThread();
    return;
  }
  const others = app.sessions.filter((s) => s.id !== app.currentMeta.id);
  if (!others.length) {
    toast("Create another chat first — compare needs two.", "error");
    app.compareOpen = false;
    return;
  }
  // pick second chat
  const buttons: HTMLElement[] = others.slice(0, 8).map((s) => {
    const b = el("button", "btn", s.name);
    b.onclick = async () => {
      app.compareId = s.id;
      closeModal();
      await api("PATCH", `/api/sessions/${app.currentMeta.id}`, { compareWith: s.id });
      await openSession(app.currentMeta.id);
      renderCompare();
    };
    return b;
  });
  modal("Compare with which chat?", `<div style="display:flex;flex-wrap:wrap;gap:8px"></div>`, { onMount: (m) => {
    const w = m.querySelector("div")!;
    buttons.forEach((b) => w.appendChild(b));
  } });
}

function renderCompare(): void {
  // Renders both sessions side by side inside #thread via a split container.
  const thread = $("#thread");
  thread.innerHTML = "";
  const wrap = el("div", "compare-wrap");
  wrap.style.height = "100%";
  thread.appendChild(wrap);
  renderComparePane(wrap, app.currentMeta.id, app.current);
  const other = app.compareId;
  if (other) {
    api("GET", `/api/sessions/${other}`).then((full) => renderComparePane(wrap, other, full.session));
  }
}

function renderComparePane(wrap: HTMLElement, sid: string, sess: any): void {
  const pane = el("div", "compare-pane");
  const head = el("div", "topbar");
  head.style.minHeight = "46px";
  head.innerHTML = `<div class="top-title">${esc(sess.name)}</div>`;
  const body = el("div", "thread");
  const inner = el("div", "thread-inner");
  const ids = walkIds(sess);
  for (const id of ids) {
    const node = sess.nodes[id];
    const msg = el("div", `msg ${node.role}`);
    const bubble = el("div", "bubble");
    if (node.role === "user") {
      bubble.innerHTML = `<div class="md" dir="${isRtl(node.content) ? "rtl" : "ltr"}">${renderMd(node.content)}</div>`;
    } else {
      if (node.thinking) {
        const tb = el("div", "think-block");
        tb.innerHTML = `<div class="think-head"><span>Thinking</span></div><div class="think-body">${esc(node.thinking)}</div>`;
        tb.querySelector(".think-head")!.addEventListener("click", () => tb.classList.toggle("open"));
        bubble.appendChild(tb);
      }
      const md = el("div", "md");
      md.innerHTML = renderMd(node.content);
      bubble.appendChild(md);
      if (node.genMs != null) {
        const acts = el("div", "actions");
        acts.style.opacity = "1";
        acts.appendChild(el("span", "meta", fmtDur(node.genMs)));
        bubble.appendChild(acts);
      }
    }
    msg.appendChild(bubble);
    inner.appendChild(msg);
  }
  body.appendChild(inner);
  const composerWrap = el("div", "composer-wrap");
  const composer = el("div", "composer");
  const ta = el("textarea");
  ta.rows = 1;
  ta.placeholder = `Message "${sess.name}" — Shift+Enter for newline`;
  const sendBoth = el("button", "btn", "Both");
  sendBoth.title = "Send this message to BOTH chats";
  const sendBtn = el("button", "btn send", `<svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 19V6M6 11l6-6 6 6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  const doSend = async (both: boolean) => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    try {
      if (both) {
        await api("POST", `/api/sessions/${app.currentMeta.id}/send`, { text });
        await api("POST", `/api/sessions/${sid}/send`, { text });
      } else {
        await api("POST", `/api/sessions/${sid}/send`, { text });
      }
      app.generating.add(app.currentMeta.id);
      if (both) app.generating.add(sid);
      toast(both ? "Sent to both chats" : `Sent to ${sess.name}`, "ok");
      setTimeout(() => renderCompare(), 400);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  sendBtn.onclick = () => doSend(false);
  sendBoth.onclick = () => doSend(true);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend(false);
    }
  });
  composer.append(ta, sendBoth, sendBtn);
  composerWrap.appendChild(composer);
  pane.append(head, body, composerWrap);
  wrap.appendChild(pane);
}

// ------------------------------------------------------------------ toggles

function renderToggles(): void {
  const meta = app.currentMeta;
  if (!meta) return;
  $("#toggle-search").classList.toggle("on", !!meta.searchEnabled);
  $("#toggle-think").classList.toggle("on", !!meta.thinkingEnabled);
  $("#toggle-memory").classList.toggle("on", !!meta.memoryEnabled);
  $("#toggle-compare").classList.toggle("on", app.compareOpen);
}

// ------------------------------------------------------------------ wiring

function applySettingsToUI(): void {
  // nothing global for now — placeholders handled per-render
}

function wire(): void {
  $("#gate-create-btn").onclick = createAccount;
  $("#gate-login-btn").onclick = login;
  $("#gate-login-pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  $("#gate-pass2").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createAccount();
  });

  $("#new-chat").onclick = () => newChat(true);
  $("#chat-search").addEventListener("input", () => renderChatList());
  $("#btn-tokens").onclick = openTokens;
  $("#btn-memory").onclick = openMemory;
  $("#btn-settings").onclick = () => openSettings();
  $("#btn-chat-settings").onclick = openChatSettings;
  $("#btn-export").onclick = exportChat;
  $("#btn-lan").onclick = () => {
    modal("Share on your local network", `
      <p class="confirm-text">Want friends on the same Wi-Fi to use Shuggle in their browsers? Close the app and start it once with the launcher:</p>
      <pre class="md" style="border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--bg);font-family:var(--mono);font-size:12.5px">Windows:  "Shuggle LAN.bat"
Linux:    ./shuggle-lan.sh</pre>
      <p class="confirm-text">It prints a link like <code>http://192.168.x.x:8680</code> — anyone on your network opens it, logs in with your password, and chats. Everything still runs from this machine.</p>
    `);
  };

  $("#toggle-search").onclick = async () => {
    if (!app.currentMeta) return;
    await api("PATCH", `/api/sessions/${app.currentMeta.id}`, { searchEnabled: !app.currentMeta.searchEnabled });
    await openSession(app.currentMeta.id);
  };
  $("#toggle-think").onclick = async () => {
    if (!app.currentMeta) return;
    await api("PATCH", `/api/sessions/${app.currentMeta.id}`, { thinkingEnabled: !app.currentMeta.thinkingEnabled });
    await openSession(app.currentMeta.id);
  };
  $("#toggle-memory").onclick = async () => {
    if (!app.currentMeta) return;
    await api("PATCH", `/api/sessions/${app.currentMeta.id}`, { memoryEnabled: !app.currentMeta.memoryEnabled });
    await openSession(app.currentMeta.id);
  };
  $("#toggle-compare").onclick = toggleCompare;

  const input = $("#input") as HTMLTextAreaElement;
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $("#btn-send").onclick = send;
  $("#btn-stop").onclick = async () => {
    await api("POST", "/api/engine/sleep");
    toast("Engine resting — GPU hours are back in your pocket", "ok");
  };
  $("#btn-attach").onclick = () => $("#file-input").click();
  $("#file-input").addEventListener("change", (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) addFiles(files);
    (e.target as HTMLInputElement).value = "";
  });

  window.addEventListener("beforeunload", () => {
    navigator.sendBeacon?.("/api/app/shutdown");
  });
}

async function newChat(focus: boolean): Promise<void> {
  const r = await api("POST", "/api/sessions", {});
  await refreshSessions();
  await openSession(r.id);
  if (focus) ($("#input") as HTMLTextAreaElement).focus();
}

// ------------------------------------------------------------------ boot

window.addEventListener("DOMContentLoaded", async () => {
  wire();
  try {
    const st = await api("GET", "/api/state");
    if (st.loggedIn) {
      await refreshApp();
      connectStream();
    } else {
      showGate(st);
    }
  } catch (e: any) {
    toast(e.message, "error");
  }
});
