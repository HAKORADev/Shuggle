// Shuggle — local server: REST API + SSE + static UI. Also the LAN server.

import { join, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { AppContext } from "../core/app.ts";
import { newSession, activePath, addNode, renameAuto, switchDimension, branchOut, Msg, SessionData, childrenOf } from "../core/sessions.ts";
import { buildSystemPrompt } from "../core/sysprompt.ts";
import { mergeOverride } from "../core/settings.ts";
import { activeSkills, skillsPrompt } from "../core/skills.ts";
import { poolAdd, poolRefresh, poolSummary, poolAutoPick } from "../core/tokens.ts";
import { hsh16 } from "../core/util.ts";

interface ChatTask {
  sid: string;
  userMsgId: string | null;
  assistantMsgId: string | null;
  kind: "send" | "retry";
  text: string;
  startedAt: number;
  chunks: { think: string; text: string };
}

interface IncomingMedia {
  name: string;
  kind: "image" | "video";
  dataB64: string;
}

export class Server {
  private app: AppContext;
  private cookieName = "shuggle_session";
  private sessionCookie: string | null = null;
  private lastActivity = Date.now();
  private tasks = new Map<string, ChatTask>(); // sid -> in-flight task
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private opts: { dataDir: string; port: number; lan: boolean; appWindow: boolean; onExit: () => void },
  ) {
    this.app = new AppContext(opts.dataDir);
    this.app.events.on("engine", (ev: any) => this.onEngineEvent(ev));
  }

  // ===================================================================
  // engine event handling → session updates + UI fanout
  // ===================================================================

  private broadcast(type: string, data: any): void {
    this.app.events.emit("sse", { type, ...data });
  }

  private taskFor(sid: string): ChatTask | null {
    return this.tasks.get(sid) ?? null;
  }

  private onEngineEvent(ev: any): void {
    const slot = ev.slot;
    switch (ev.type) {
      case "state":
        this.broadcast("engine", { slot, state: ev.state, detail: ev.detail });
        break;
      case "chunk": {
        const task = this.taskFor(ev.sid);
        if (!task) break;
        task.chunks[ev.kind === "think" ? "think" : "text"] += ev.text;
        this.ensureAssistantNode(task);
        this.broadcast("chunk", {
          sid: task.sid,
          msgId: task.assistantMsgId,
          kind: ev.kind,
          text: ev.text,
        });
        break;
      }
      case "reclass": {
        const task = this.taskFor(ev.sid);
        if (task && task.assistantMsgId) {
          task.chunks.text = task.chunks.think + task.chunks.text;
          task.chunks.think = "";
          this.broadcast("reclass", { sid: task.sid, msgId: task.assistantMsgId });
        }
        break;
      }
      case "search":
        this.broadcast("search", { sid: ev.sid, phase: ev.phase, data: ev.data });
        break;
      case "done": {
        const task = this.taskFor(ev.sid);
        if (!task) break;
        this.finalizeTask(task, ev);
        if (ev.memResults?.length) {
          this.broadcast("memory-chip", { sid: ev.sid, results: ev.memResults });
        }
        break;
      }
      case "failed": {
        const task = this.taskFor(ev.sid);
        if (!task) break;
        const s = this.app.sessions.sessions[task.sid];
        if (s && task.assistantMsgId && s.nodes[task.assistantMsgId]) {
          s.nodes[task.assistantMsgId].error = humanError(ev.detail);
        }
        this.tasks.delete(task.sid);
        this.persist("sessions");
        this.broadcast("failed", { sid: task.sid, msgId: task.assistantMsgId, detail: humanError(ev.detail) });
        break;
      }
      case "resync": {
        // The engine's history diverged — push the active path fully.
        const task = this.taskFor(ev.sid);
        if (!task) break;
        const s = this.app.sessions.sessions[task.sid];
        if (!s) break;
        void this.pushFullPath(ev.slot, s);
        break;
      }
      case "probe":
        this.broadcast("probe", { slot, ...ev });
        break;
      case "outbox-done": {
        // Durable turn completion from the engine's outbox. Normal flow: it
        // backs up the live stream for the finalize step. Recovery flow: if
        // the app (or the whole machine) restarted mid-generation, nobody is
        // tracking this sid anymore — adopt the finished reply directly.
        const j = ev;
        this.app.lastOutboxBySid.set(j.sid, j);
        if (!this.tasks.has(j.sid)) {
          const s = this.app.sessions.sessions[j.sid];
          if (s && j.content) {
            const path = activePath(s);
            const last = path.length ? path[path.length - 1] : null;
            if (last && last.role === "assistant" && !last.content) {
              last.content = j.content;
              last.thinking = j.thinking ?? null;
              last.genMs = j.gen_ms ?? null;
              this.persist("sessions");
              this.broadcast("done", { sid: j.sid, msgId: last.id, genMs: j.gen_ms ?? null, adopted: true });
            } else if (!last || last.role === "user") {
              const node = addNode(s, j.msg_id ?? (last?.id ?? null), {
                role: "assistant",
                content: j.content,
                thinking: j.thinking ?? null,
                genMs: j.gen_ms ?? null,
                attachments: [],
              });
              this.persist("sessions");
              this.broadcast("done", { sid: j.sid, msgId: node.id, genMs: j.gen_ms ?? null, adopted: true });
            }
          }
        }
        break;
      }
      case "vision":
        this.broadcast("vision", { slot, state: ev.state, detail: ev.detail ?? null });
        break;
      case "mem": {
        // Engine-side memory operations changed the memory text — mirror it.
        if (typeof ev.text === "string") {
          this.app.memory.text = ev.text;
          this.persist("memory");
          this.broadcast("memory-updated", { hash: ev.hash ?? null, text: ev.text });
        } else {
          this.broadcast("memory-touched", { hash: ev.hash ?? null });
        }
        break;
      }
      case "seed":
        this.broadcast("seed", { slot, phase: ev.phase, detail: ev.detail });
        break;
      case "engine-log":
        this.broadcast("engine-log", { slot, where: ev.where, detail: ev.detail });
        break;
    }
  }

  private ensureAssistantNode(task: ChatTask): void {
    if (task.assistantMsgId) return;
    const s = this.app.sessions.sessions[task.sid];
    if (!s) return;
    const node = addNode(s, task.userMsgId, {
      role: "assistant",
      content: "",
      thinking: task.chunks.think || null,
      genMs: null,
      attachments: [],
    });
    task.assistantMsgId = node.id;
    this.persist("sessions");
    this.broadcast("session", { sid: task.sid, reason: "assistant-started", msgId: node.id });
  }

  private finalizeTask(task: ChatTask, ev: any): void {
    const s = this.app.sessions.sessions[task.sid];
    this.tasks.delete(task.sid);
    if (!s) return;
    let content = task.chunks.text;
    let thinking = task.chunks.think || null;
    // Authoritative correction from the outbox (covers any missed log lines)
    const outbox = this.app.lastOutboxBySid.get(task.sid);
    if (ev.chars !== undefined && content.length !== ev.chars && outbox?.content) {
      content = outbox.content;
      thinking = outbox.thinking ?? null;
    }
    if (task.assistantMsgId && s.nodes[task.assistantMsgId]) {
      const n = s.nodes[task.assistantMsgId];
      n.content = content;
      n.thinking = thinking;
      n.genMs = ev.genMs ?? null;
      n.searchBrief = ev.searchBrief ?? null;
      n.searches = ev.searchQueries ?? null;
    }
    this.persist("sessions");
    this.broadcast("done", {
      sid: task.sid,
      msgId: task.assistantMsgId,
      genMs: ev.genMs,
      searchBrief: ev.searchBrief ?? null,
      searchQueries: ev.searchQueries ?? null,
    });
  }

  private async pushFullPath(slotUsername: string, s: SessionData): Promise<void> {
    try {
      const slot = this.app.slots.get(slotUsername);
      if (!slot) return;
      const entries = engineEntries(activePath(s));
      await slot.resyncPath(s.id, entries);
    } catch {
      /* retried on next divergence */
    }
  }

  private persist(domain: "sessions" | "settings" | "tokens" | "memory"): void {
    this.app.save(domain);
  }

  // ===================================================================
  // auth helpers
  // ===================================================================

  private authorized(req: Request): boolean {
    const url = new URL(req.url);
    if (!this.app.profile) return false;
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return true; // local trust
    const cookie = req.headers.get("cookie") ?? "";
    return cookie.includes(`${this.cookieName}=${this.sessionCookie}`);
  }

  private json(data: any, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  private fail(err: any, status = 400): Response {
    return this.json({ error: String(err?.message ?? err) }, status);
  }

  // ===================================================================
  // HTTP handler
  // ===================================================================

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // static UI
    if (method === "GET" && !path.startsWith("/api/")) {
      return this.static(path);
    }

    if (path === "/api/health") return this.json({ ok: true, app: "shuggle" });

    // auth endpoints (work even when locked)
    if (path === "/api/state") {
      return this.json({
        device: { signature: this.app.device.signature.slice(0, 12) },
        hasAccount: this.app.hasAccount(),
        account: this.app.accountName(),
        loggedIn: !!this.app.profile,
        profiles: this.app.hasAccount() ? undefined : undefined,
      });
    }

    if (path === "/api/account" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      try {
        this.app.createAccount(String(b.name ?? ""), String(b.password ?? ""));
        this.app.login(String(b.password ?? ""));
        this.sessionCookie = randomUUID();
        return this.json({ ok: true }, 200, {
          "Set-Cookie": `${this.cookieName}=${this.sessionCookie}; Path=/; SameSite=Lax`,
        });
      } catch (e) {
        return this.fail(e);
      }
    }

    if (path === "/api/login" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      try {
        this.app.login(String(b.password ?? ""));
        this.sessionCookie = randomUUID();
        return this.json({ ok: true, account: this.app.accountName() }, 200, {
          "Set-Cookie": `${this.cookieName}=${this.sessionCookie}; Path=/; SameSite=Lax`,
        });
      } catch (e) {
        return this.fail(e, 401);
      }
    }

    if (!this.authorized(req)) {
      return this.json({ error: this.app.profile ? "locked" : "not logged in" }, 401);
    }

    if (path === "/api/logout" && method === "POST") {
      this.app.logout();
      this.sessionCookie = null;
      return this.json({ ok: true });
    }

    // ---- app state dump
    if (path === "/api/app" && method === "GET") {
      return this.json({
        account: this.app.accountName(),
        settings: this.app.settings,
        sessions: this.sessionList(),
        tokens: poolSummary(this.app.tokens),
        memory: this.app.memory.text,
        engines: [...this.app.slots.entries()].map(([u, s]) => ({
          username: u,
          state: s.getState(),
          error: s.getError(),
          probe: s.getProbe(),
          vision: s.getVision(),
        })),
        skills: this.app.settings.skills ?? [],
      });
    }

    // ---- settings (vision/afk changes apply to live engines — no restart)
    if (path === "/api/settings" && method === "PUT") {
      const b = await req.json().catch(() => ({}));
      const prevAfk = this.app.settings.afkMinutes;
      const prevVision = JSON.stringify(this.app.settings.vision);
      this.app.settings = mergeUser(this.app.settings, b);
      // Clamp skills through the settings module for safety.
      this.app.settings = { ...this.app.settings, skills: this.app.settings.skills ?? [] };
      this.persist("settings");
      if (this.app.settings.afkMinutes !== prevAfk || JSON.stringify(this.app.settings.vision) !== prevVision) {
        for (const slot of this.app.slots.values()) {
          void slot.configure({
            afkSeconds: this.app.settings.afkMinutes * 60,
            vision: {
              enabled: this.app.settings.vision.enabled,
              maxFrames: this.app.settings.vision.maxFrames,
              frameSeconds: this.app.settings.vision.frameSeconds,
              mediaTokenBudget: this.app.settings.mediaTokenBudget,
            },
          });
        }
      }
      return this.json({ ok: true, settings: this.app.settings });
    }

    // ---- tokens
    if (path === "/api/tokens" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const secret = String(b.secret ?? "").trim();
      if (!secret) return this.fail("paste a Kaggle token first");
      try {
        const r = await poolAdd(this.app.tokens, secret);
        if (!r.ok) return this.fail(r.error);
        this.persist("tokens");
        return this.json({ ok: true, username: r.username, quota: r.quota });
      } catch (e) {
        return this.fail(e);
      }
    }
    if (path === "/api/tokens/refresh" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const user = String(b.username ?? "");
      const rec = await poolRefresh(this.app.tokens, user);
      this.persist("tokens");
      if (!rec) return this.fail("no such token");
      return this.json({ ok: true, token: poolSummary(this.app.tokens).find((t) => t.id === user) });
    }
    if (path === "/api/tokens" && method === "DELETE") {
      const b = await req.json().catch(() => ({}));
      const user = String(b.username ?? "");
      this.app.tokens.tokens = this.app.tokens.tokens.filter((t) => t.id !== user);
      this.persist("tokens");
      return this.json({ ok: true });
    }

    // ---- sessions
    if (path === "/api/sessions" && method === "GET") {
      return this.json({ sessions: this.sessionList() });
    }
    if (path === "/api/sessions" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const s = newSession(typeof b.name === "string" && b.name.trim() ? b.name.trim() : "New chat");
      s.searchEnabled = !!this.app.settings.searchEnabled;
      s.memoryEnabled = !!this.app.settings.memoryEnabled;
      s.visionEnabled = !!this.app.settings.vision.enabled;
      this.app.sessions.sessions[s.id] = s;
      this.app.sessions.order = [s.id, ...this.app.sessions.order];
      this.persist("sessions");
      return this.json({ ok: true, id: s.id, session: this.sessionMeta(s) });
    }
    {
      const m = path.match(/^\/api\/sessions\/([a-f0-9-]+)(\/([a-z]+))?$/);
      if (m) {
        const sid = m[1];
        const action = m[3] ?? null;
        const s = this.app.sessions.sessions[sid];
        if (path === `/api/sessions/${sid}` && method === "GET" && !action) {
          if (!s) return this.fail("no such chat", 404);
          return this.json({ ok: true, session: this.fullSession(s) });
        }
        if (!s) return this.fail("no such chat", 404);
        if (!action && method === "PATCH") {
          const b = await req.json().catch(() => ({}));
          if (typeof b.name === "string" && b.name.trim()) {
            s.name = b.name.trim();
            s.autoNamed = true;
          }
          if (typeof b.pinned === "boolean") s.pinned = b.pinned;
          if (typeof b.searchEnabled === "boolean") s.searchEnabled = b.searchEnabled;
          if (typeof b.thinkingEnabled === "boolean") s.thinkingEnabled = b.thinkingEnabled;
          if (typeof b.memoryEnabled === "boolean") s.memoryEnabled = b.memoryEnabled;
          if (typeof b.visionEnabled === "boolean") s.visionEnabled = b.visionEnabled;
          if (typeof b.compareWith === "string" || b.compareWith === null) s.compareWith = b.compareWith;
          if (b.override !== undefined) s.override = b.override;
          this.persist("sessions");
          return this.json({ ok: true });
        }
        if (!action && method === "DELETE") {
          // remove from engine too (fire and forget)
          for (const [u, slot] of this.app.slots) {
            if (slot.sessionHash(sid) !== undefined) {
              void slot.resyncPath(sid, []).catch(() => {});
            }
          }
          delete this.app.sessions.sessions[sid];
          this.app.sessions.order = this.app.sessions.order.filter((x) => x !== sid);
          this.persist("sessions");
          return this.json({ ok: true });
        }
        if (action === "send" && method === "POST") {
          const b = await req.json().catch(() => ({}));
          return this.send(s, String(b.text ?? ""), Array.isArray(b.attachments) ? b.attachments : [], Array.isArray(b.media) ? (b.media as IncomingMedia[]) : []);
        }
        if (action === "retry" && method === "POST") {
          const b = await req.json().catch(() => ({}));
          return this.retry(s, String(b.userMsgId ?? ""));
        }
        if (action === "edit" && method === "POST") {
          const b = await req.json().catch(() => ({}));
          return this.edit(s, String(b.userMsgId ?? ""), String(b.text ?? ""), Array.isArray(b.attachments) ? b.attachments : []);
        }
        if (action === "switch" && method === "POST") {
          const b = await req.json().catch(() => ({}));
          return this.switchDim(s, String(b.msgId ?? ""));
        }
        if (action === "branch" && method === "POST") {
          const b = await req.json().catch(() => ({}));
          const node = s.nodes[String(b.msgId ?? "")];
          if (!node) return this.fail("no such message");
          const ns = branchOut(this.app.sessions, s, node.id);
          this.persist("sessions");
          return this.json({ ok: true, id: ns.id, session: this.sessionMeta(ns) });
        }
      }
    }

    // ---- memory
    if (path === "/api/memory" && method === "PUT") {
      const b = await req.json().catch(() => ({}));
      const text = String(b.text ?? "");
      if (text.length > this.app.settings.memoryMaxChars) {
        return this.fail(`memories are limited to ${this.app.settings.memoryMaxChars} characters`);
      }
      this.app.memory.text = text;
      this.persist("memory");
      return this.json({ ok: true });
    }

    // ---- engine controls
    if (path === "/api/engine/restart" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const user = String(b.username ?? "") || poolAutoPick(this.app.tokens)?.id;
      const rec = this.app.tokens.tokens.find((t) => t.id === user);
      if (!user || !rec) return this.fail("no such token");
      try {
        const slot = this.app.slotFor(user);
        void slot.boot({ id: user, secret: rec.secret } as any, true);
        return this.json({ ok: true, username: user });
      } catch (e) {
        return this.fail(e);
      }
    }
    if (path === "/api/engine/wake" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const user = String(b.username ?? "") || poolAutoPick(this.app.tokens)?.id;
      if (!user) return this.fail("no usable token");
      try {
        const slot = this.app.slotFor(user);
        void slot.boot({ id: user, secret: this.app.tokens.tokens.find((t) => t.id === user)!.secret } as any);
        return this.json({ ok: true, username: user });
      } catch (e) {
        return this.fail(e);
      }
    }
    if (path === "/api/engine/sleep" && method === "POST") {
      for (const slot of this.app.slots.values()) await slot.sleepNow();
      return this.json({ ok: true });
    }
    if (path === "/api/engine/sleep" && method === "DELETE") {
      // sleep a specific slot
      return this.json({ ok: true });
    }

    // ---- activity ping (keeps the engine awake while the user is active)
    if (path === "/api/activity" && method === "POST") {
      this.lastActivity = Date.now();
      return this.json({ ok: true });
    }

    // ---- app window closed
    if (path === "/api/app/shutdown" && method === "POST") {
      if (this.opts.appWindow) {
        setTimeout(() => this.opts.onExit(), 300);
      }
      return this.json({ ok: true });
    }

    // ---- SSE stream
    if (path === "/api/stream" && method === "GET") {
      const encoder = new TextEncoder();
      const sub = (ev: any) => {
        /* placeholder — real send handled via listener below */
      };
      const stream = new ReadableStream({
        start: (ctrl) => {
          const send = (data: any) => {
            try {
              ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              /* closed */
            }
          };
          send({ type: "hello" });
          const listener = (ev: any) => send(ev);
          this.app.events.on("sse", listener);
          // keepalive
          const ka = setInterval(() => {
            try {
              ctrl.enqueue(encoder.encode(`: ka\n\n`));
            } catch {
              clearInterval(ka);
            }
          }, 15_000);
          // @ts-ignore cleanup on cancel
          ctrl._cleanup = () => {
            clearInterval(ka);
            this.app.events.off("sse", listener);
          };
        },
        cancel: (ctrlAny: any) => {
          /* handled via _cleanup on close below */
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return this.json({ error: "not found" }, 404);
  }

  // ===================================================================
  // chat flows
  // ===================================================================

  private attachmentsBlock(atts: any[]): { block: string; meta: any[] } {
    const parts: string[] = [];
    const meta: any[] = [];
    for (const a of atts) {
      const name = String(a.name ?? "file").slice(0, 120);
      const content = String(a.content ?? "");
      if (content.length > this.app.settings.attachmentMaxChars) {
        throw new Error(`"${name}" is too long (${content.length} characters) — the limit is ${this.app.settings.attachmentMaxChars}. Remove some of it and try again.`);
      }
      parts.push(`--- Attached file: ${name} ---\n${content}\n--- End of file: ${name} ---`);
      meta.push({ name, size: content.length, chars: content.length });
    }
    return { block: parts.join("\n\n"), meta };
  }

  private async send(s: SessionData, text: string, attachments: any[], media: IncomingMedia[] = []): Promise<Response> {
    try {
      let full = text;
      let meta: any[] = [];
      if (attachments.length) {
        const { block, meta: m } = this.attachmentsBlock(attachments);
        meta = m;
        full = `${text}\n\n${block}`;
      }
      if (!full.trim() && !media.length) return this.fail("write something first");
      if (this.tasks.has(s.id)) return this.json({ error: "still answering the previous message" }, 409);

      // Media validation — honest refusals, never silent truncation.
      const mediaFiles: { name: string; kind: "image" | "video"; file: string; bytes: Uint8Array }[] = [];
      if (media.length) {
        if (!this.app.settings.vision.enabled || !s.visionEnabled) {
          return this.fail("vision is off — turn it on in Settings → Model (or this chat's toggle) to send images and videos");
        }
        const v = this.app.settings.vision;
        if (media.length > v.maxImages) {
          return this.fail(`up to ${v.maxImages} images/videos per message`);
        }
        for (const m of media) {
          const bytes = Buffer.from(m.dataB64, "base64");
          const capMB = m.kind === "video" ? v.videoMaxMB : v.imageMaxMB;
          if (bytes.length > capMB * 1024 * 1024) {
            return this.fail(`"${m.name}" is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — the limit for ${m.kind === "video" ? "videos" : "images"} is ${capMB} MB`);
          }
          const safe = m.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-60) || (m.kind === "video" ? "video.mp4" : "image.jpg");
          mediaFiles.push({ name: m.name.slice(0, 80), kind: m.kind, file: randomUUID().slice(0, 8) + "_" + safe, bytes: new Uint8Array(bytes) });
        }
        const note = mediaFiles.map((m) => (m.kind === "video" ? `[video: ${m.name}]` : `[image: ${m.name}]`)).join("\n");
        full = `${full || "(see attachments)"}\n\n${note}`;
      }

      const path = activePath(s);
      const uptoEntries = engineEntriesFrom(path, null);
      const uptoHash = hsh16(uptoEntries);

      const slot = await this.app.ensureEngine(s);
      const g = mergeOverride(this.app.settings, s.override);
      const system = s.override?.systemPrompt ?? buildSystemPrompt({
        settings: this.app.settings,
        override: s.override,
        memoryText: this.app.memory.text,
        memoryEnabled: s.memoryEnabled,
        attachments: meta,
        media: mediaFiles.map((m) => ({ name: m.name, kind: m.kind })),
      });
      const skills = activeSkills(
        this.app.settings.skills,
        this.app.settings.skillsEnabled,
        s.override?.skillsEnabled === undefined ? undefined : s.override.skillsEnabled,
        s.override?.disabledSkillIds,
      );

      const userNode = addNode(s, path.length ? path[path.length - 1].id : null, {
        role: "user",
        content: text,
        thinking: null,
        genMs: null,
        attachments: [...meta, ...mediaFiles.map((m) => ({ name: m.name, size: m.bytes.length, chars: 0, media: m.kind }))],
      });
      renameAuto(s, text);
      this.persist("sessions");

      const task: ChatTask = {
        sid: s.id,
        userMsgId: userNode.id,
        assistantMsgId: null,
        kind: "send",
        text,
        startedAt: Date.now(),
        chunks: { think: "", text: "" },
      };
      this.tasks.set(s.id, task);

      await slot.wakeAndSend({
        sid: s.id,
        uptoHash,
        newMsgs: [{ role: "user", content: full, mid: userNode.id }],
        system,
        settings: { temperature: g.temperature, top_p: g.topP, max_tokens: g.maxOutputTokens },
        search: { enabled: s.searchEnabled, max_queries: g.searchMaxQueries, pages_per_query: g.searchPagesPerQuery },
        memoryHash: s.memoryEnabled ? hsh16(this.app.memory.text) : null,
        memoryText: s.memoryEnabled ? this.app.memory.text : null,
        thinking: s.thinkingEnabled,
        skills: skills.map((sk) => ({ title: sk.title, when: sk.when, why: sk.why, content: sk.content })),
        media: mediaFiles.length ? mediaFiles.map((m) => ({ name: m.name, kind: m.kind, file: m.file, bytes: m.bytes })) : undefined,
        mediaForMid: mediaFiles.length ? userNode.id : null,
      });

      this.broadcast("session", { sid: s.id, reason: "user-added", msgId: userNode.id });
      return this.json({ ok: true, userMsgId: userNode.id });
    } catch (e: any) {
      return this.fail(e, 500);
    }
  }

  private async retry(s: SessionData, userMsgId: string): Promise<Response> {
    try {
      const userNode = s.nodes[userMsgId];
      if (!userNode || userNode.role !== "user") return this.fail("retry needs one of your messages");
      if (this.tasks.has(s.id)) return this.json({ error: "still answering the previous message" }, 409);

      const path = activePath(s);
      const idx = path.findIndex((m) => m.id === userMsgId);
      const uptoEntries = engineEntriesFrom(path, userMsgId); // up to AND including the user msg
      const uptoHash = hsh16(uptoEntries);

      const slot = await this.app.ensureEngine(s);
      const g = mergeOverride(this.app.settings, s.override);
      const system = s.override?.systemPrompt ?? buildSystemPrompt({
        settings: this.app.settings,
        override: s.override,
        memoryText: this.app.memory.text,
        memoryEnabled: s.memoryEnabled,
      });
      const skills = activeSkills(
        this.app.settings.skills,
        this.app.settings.skillsEnabled,
        s.override?.skillsEnabled === undefined ? undefined : s.override.skillsEnabled,
        s.override?.disabledSkillIds,
      );

      const task: ChatTask = {
        sid: s.id,
        userMsgId,
        assistantMsgId: null,
        kind: "retry",
        text: userNode.content,
        startedAt: Date.now(),
        chunks: { think: "", text: "" },
      };
      this.tasks.set(s.id, task);

      await slot.wakeAndSend({
        sid: s.id,
        uptoHash,
        truncateAfterMid: userMsgId,
        newMsgs: [],
        system,
        settings: { temperature: g.temperature, top_p: g.topP, max_tokens: g.maxOutputTokens },
        search: { enabled: s.searchEnabled, max_queries: g.searchMaxQueries, pages_per_query: g.searchPagesPerQuery },
        memoryHash: s.memoryEnabled ? hsh16(this.app.memory.text) : null,
        memoryText: s.memoryEnabled ? this.app.memory.text : null,
        thinking: s.thinkingEnabled,
        skills: skills.map((sk) => ({ title: sk.title, when: sk.when, why: sk.why, content: sk.content })),
      });

      this.broadcast("session", { sid: s.id, reason: "retry", userMsgId });
      return this.json({ ok: true });
    } catch (e: any) {
      return this.fail(e, 500);
    }
  }

  private async edit(s: SessionData, userMsgId: string, text: string, attachments: any[]): Promise<Response> {
    try {
      const old = s.nodes[userMsgId];
      if (!old || old.role !== "user") return this.fail("edit needs one of your messages");
      if (this.tasks.has(s.id)) return this.json({ error: "still answering the previous message" }, 409);
      let full = text;
      let meta: any[] = [];
      if (attachments.length) {
        const { block, meta: m } = this.attachmentsBlock(attachments);
        meta = m;
        full = `${text}\n\n${block}`;
      }
      if (!full.trim()) return this.fail("write something first");

      const uptoEntries = engineEntriesBefore(activePath(s), old.id); // strictly before the old user msg
      const uptoHash = hsh16(uptoEntries);

      const slot = await this.app.ensureEngine(s);
      const g = mergeOverride(this.app.settings, s.override);
      const system = s.override?.systemPrompt ?? buildSystemPrompt({
        settings: this.app.settings,
        override: s.override,
        memoryText: this.app.memory.text,
        memoryEnabled: s.memoryEnabled,
        attachments: meta,
      });
      const skills = activeSkills(
        this.app.settings.skills,
        this.app.settings.skillsEnabled,
        s.override?.skillsEnabled === undefined ? undefined : s.override.skillsEnabled,
        s.override?.disabledSkillIds,
      );

      // New sibling user node (a new dimension), active by default.
      const node = addNode(s, old.parentId, {
        role: "user",
        content: text,
        thinking: null,
        genMs: null,
        attachments: meta,
      });

      const task: ChatTask = {
        sid: s.id,
        userMsgId: node.id,
        assistantMsgId: null,
        kind: "send",
        text,
        startedAt: Date.now(),
        chunks: { think: "", text: "" },
      };
      this.tasks.set(s.id, task);

      await slot.wakeAndSend({
        sid: s.id,
        uptoHash,
        truncateMid: old.id,
        newMsgs: [{ role: "user", content: full, mid: node.id }],
        system,
        settings: { temperature: g.temperature, top_p: g.topP, max_tokens: g.maxOutputTokens },
        search: { enabled: s.searchEnabled, max_queries: g.searchMaxQueries, pages_per_query: g.searchPagesPerQuery },
        memoryHash: s.memoryEnabled ? hsh16(this.app.memory.text) : null,
        memoryText: s.memoryEnabled ? this.app.memory.text : null,
        thinking: s.thinkingEnabled,
        skills: skills.map((sk) => ({ title: sk.title, when: sk.when, why: sk.why, content: sk.content })),
      });

      this.persist("sessions");
      this.broadcast("session", { sid: s.id, reason: "edited", msgId: node.id });
      return this.json({ ok: true, userMsgId: node.id });
    } catch (e: any) {
      return this.fail(e, 500);
    }
  }

  private async switchDim(s: SessionData, msgId: string): Promise<Response> {
    try {
      if (!switchDimension(s, msgId)) return this.fail("no other version of this message");
      this.persist("sessions");
      // Full path resync (rare structural change)
      const slot = this.app.slots.get(s.engineUsername ?? "");
      if (slot) {
        void this.pushFullPath(slot.username, s);
      }
      this.broadcast("session", { sid: s.id, reason: "switched" });
      return this.json({ ok: true, session: this.fullSession(s) });
    } catch (e: any) {
      return this.fail(e, 500);
    }
  }

  // ===================================================================
  // views
  // ===================================================================

  private sessionMeta(s: SessionData) {
    return {
      id: s.id,
      name: s.name,
      pinned: s.pinned,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      engineUsername: s.engineUsername ?? null,
      searchEnabled: s.searchEnabled,
      thinkingEnabled: s.thinkingEnabled,
      memoryEnabled: s.memoryEnabled,
      visionEnabled: s.visionEnabled,
      compareWith: s.compareWith ?? null,
      messageCount: activePath(s).length,
    };
  }

  private sessionList() {
    return this.app.sessions.order
      .map((id) => this.app.sessions.sessions[id])
      .filter(Boolean)
      .map((s) => this.sessionMeta(s));
  }

  private fullSession(s: SessionData) {
    return {
      ...this.sessionMeta(s),
      override: s.override ?? null,
      nodes: s.nodes,
      activeRoot: s.activeRoot,
      activeChild: s.activeChild,
    };
  }

  // ===================================================================
  // static files (embedded)
  // ===================================================================

  private static(path: string): Response {
    const { indexHtml, styleCss, appJs, markedJs, purifyJs, hljsJs, hljsCss, faviconPng } = assets;
    let body = "";
    let type = "text/html; charset=utf-8";
    switch (path) {
      case "/":
      case "/index.html":
        body = indexHtml;
        break;
      case "/style.css":
        body = styleCss;
        type = "text/css; charset=utf-8";
        break;
      case "/app.js":
        body = appJs;
        type = "text/javascript; charset=utf-8";
        break;
      case "/vendor/marked.min.js":
        body = markedJs;
        type = "text/javascript; charset=utf-8";
        break;
      case "/vendor/purify.min.js":
        body = purifyJs;
        type = "text/javascript; charset=utf-8";
        break;
      case "/vendor/highlight.min.js":
        body = hljsJs;
        type = "text/javascript; charset=utf-8";
        break;
      case "/vendor/highlight-theme.css":
        body = hljsCss;
        type = "text/css; charset=utf-8";
        break;
      case "/favicon.png":
        return new Response(faviconPng, { headers: { "Content-Type": "image/png" } });
      default:
        body = indexHtml;
    }
    return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
  }

  // ===================================================================
  // lifecycle
  // ===================================================================

  startPings(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      // Keep engines awake only while the user is actually active.
      if (Date.now() - this.lastActivity < 150_000) {
        for (const slot of this.app.slots.values()) void slot.ping();
      }
    }, 60_000);
  }

  get context(): AppContext {
    return this.app;
  }

  get lanPort(): number {
    return this.opts.port;
  }
  get isLan(): boolean {
    return this.opts.lan;
  }
  get appWindowMode(): boolean {
    return this.opts.appWindow;
  }
}

function mergeUser(current: any, patch: any) {
  // shallow merge with clamping (settings module validates ranges)
  const out = { ...current, ...patch };
  if (patch.fancy) out.fancy = { ...current.fancy, ...patch.fancy };
  return out;
}

function humanError(detail: any): string {
  const d = String(detail ?? "");
  if (d.includes("exceed") || d.includes("context")) return "This reply went over the model's context window. Try a shorter message or clear the chat.";
  if (d.includes("CUDA") || d.includes("out of memory") || d.toLowerCase().includes("oom")) return "The GPUs ran out of memory. Restarting the engine usually fixes it.";
  if (d.includes("offline") || d.includes("internet")) return "The engine lost its internet connection. Try again in a moment.";
  return "The engine could not finish this reply. Try again — if it keeps failing, restart the engine from the status panel.";
}

/** Engine-format entries for the active path (mirrors the kernel's history shape). */
function engineEntries(path: Msg[]): { role: string; content: string; mid?: string }[] {
  return path.map((m) =>
    m.role === "user"
      ? { role: "user", content: m.content, mid: m.id }
      : { role: "assistant", content: m.content },
  );
}

/** Entries up to (and excluding, or including when uptoId is given) a message. */
function engineEntriesFrom(path: Msg[], uptoId: string | null): { role: string; content: string; mid?: string }[] {
  if (!uptoId) return engineEntries(path);
  const idx = path.findIndex((m) => m.id === uptoId);
  if (idx < 0) return [];
  return engineEntries(path.slice(0, idx + 1));
}

/** Entries strictly BEFORE a message (exclusive) — used by edits. */
function engineEntriesBefore(path: Msg[], uptoId: string): { role: string; content: string; mid?: string }[] {
  const idx = path.findIndex((m) => m.id === uptoId);
  if (idx < 0) return [];
  return engineEntries(path.slice(0, idx));
}

// assets — embedded at build time (populated by build script; dev mode reads from disk)
import { readFileSync, existsSync } from "node:fs";
const devRoot = new URL("../../", import.meta.url).pathname;
function readAsset(rel: string, binary = false): any {
  const p = join(devRoot, rel);
  if (existsSync(p)) {
    return binary ? readFileSync(p) : readFileSync(p, "utf8");
  }
  return binary ? new Uint8Array() : "";
}
const _uiDir = "src/ui";
const _vendor = "src/ui/vendor";
export const assets = {
  indexHtml: readAsset(`${_uiDir}/index.html`),
  styleCss: readAsset(`${_uiDir}/style.css`),
  appJs: readAsset(`${_uiDir}/app.bundle.js`),
  markedJs: readAsset(`${_vendor}/marked.min.js`),
  purifyJs: readAsset(`${_vendor}/purify.min.js`),
  hljsJs: readAsset(`${_vendor}/highlight.min.js`),
  hljsCss: readAsset(`${_vendor}/highlight-theme.css`),
  faviconPng: readAsset("assets/shuggle_32.png", true),
};
