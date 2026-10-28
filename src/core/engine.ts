// Shuggle — engine manager: one engine slot per Kaggle token (account).
//
// States: idle → seeding → booting → ready ⇄ generating → sleeping
// The slot owns: kernel push, inbox commands (cmd.json + media files), live
// log stream, outbox polling, quota watching, and the AFK heartbeat. All
// failures are translated into human states — raw network errors never reach
// the UI. Vision (mmproj) loads/unloads engine-side on demand; the only
// things that ever need a real engine restart are context-size changes and
// engine upgrades — everything else applies on the next message.

import { Kaggle, sleep } from "./kaggle.ts";
import { engineScript } from "./kernel.ts";
import { hsh16 } from "./util.ts";
import { TokenRecord } from "./tokens.ts";
import { EventEmitter } from "node:events";

export type SlotState = "idle" | "seeding" | "booting" | "waking" | "ready" | "generating" | "sleeping" | "error";
export type VisionState = "unknown" | "ready" | "unavailable" | "off";

/** Profile namespace for private kernel/dataset slugs. */
export function profileNamespace(profile: string): string {
  return profile.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "default";
}

export interface SlotEvent {
  slot: string; // username
  type: string;
  [k: string]: any;
}

export interface MediaItem {
  name: string;
  kind: "image" | "video";
  file: string; // filename inside the inbox version
  bytes?: Uint8Array;
}

export interface ChatTurn {
  sid: string;
  uptoHash: string;
  truncateMid?: string | null; // truncate engine history BEFORE this mid (edits)
  truncateAfterMid?: string | null; // truncate engine history AFTER this mid (retries)
  newMsgs: { role: string; content: string; mid?: string }[];
  system: string;
  settings: { temperature: number; top_p: number; max_tokens: number };
  search?: { enabled: boolean; max_queries: number; pages_per_query: number };
  memoryHash: string | null;
  memoryText: string | null;
  thinking: boolean;
  skills?: { title: string; when: string; why: string; content: string }[];
  media?: MediaItem[]; // images/videos traveling with this turn
  mediaForMid?: string | null; // which new message id carries the media
}

export class EngineSlot {
  readonly username: string;
  private secret: string;
  private kaggle: Kaggle;
  private events: EventEmitter;
  private cmdV = 0;
  private state: SlotState = "idle";
  private abortLog: AbortController | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private profile: string;
  private ns: string; // profile namespace for this slot's private slugs
  private slug: string;
  private contextTokens: number;
  private afkSeconds: number;
  private seenSessionHash: Record<string, string> = {};
  private memHash: string = "";
  private probe: { chars_per_token: Record<string, number>; ctx: number } | null = null;
  private lastError: string | null = null;
  private bootStartedAt = 0;
  private generating = new Set<string>(); // sids with in-flight generation
  private visionState: VisionState = "unknown";
  private visionDetail: string | null = null;
  private bootGraceUntil = 0;
  private pushedAt = 0;
  private lastSseAt = 0;
  private recovering = false;
  private lastCmdSentAt = 0;

  /** True when the relay has fresh evidence (log lines) from the session we
   *  pushed — past that point, COMPLETE/ERROR from the status API is real. */
  private get freshSessionEvidence(): boolean {
    return this.pushedAt > 0 && this.lastSseAt > this.pushedAt;
  }

  constructor(opts: { username: string; secret: string; profile: string; contextTokens: number; afkSeconds: number; events: EventEmitter }) {
    this.username = opts.username;
    this.secret = opts.secret;
    this.profile = opts.profile;
    this.ns = profileNamespace(opts.profile);
    this.slug = `shuggle-engine-${this.ns}`;
    this.contextTokens = opts.contextTokens;
    this.afkSeconds = opts.afkSeconds;
    this.events = opts.events;
    this.kaggle = new Kaggle(opts.secret);
  }

  emit(type: string, data: Record<string, any> = {}): void {
    this.events.emit("engine", { slot: this.username, type, ...data });
  }

  getState(): SlotState {
    return this.state;
  }
  getProbe() {
    return this.probe;
  }
  getError(): string | null {
    return this.lastError;
  }
  getVision(): { state: VisionState; detail: string | null } {
    return { state: this.visionState, detail: this.visionDetail };
  }
  sessionHash(sid: string): string | null {
    return this.seenSessionHash[sid] ?? null;
  }
  isGenerating(sid?: string): boolean {
    return sid ? this.generating.has(sid) : this.generating.size > 0;
  }

  private setState(s: SlotState, detail?: string): void {
    if (this.state !== s) {
      this.state = s;
      this.emit("state", { state: s, detail });
    }
  }

  /** Ensure the private relay datasets exist. Cheap (one status check each). */
  private async ensureDatasets(): Promise<void> {
    const jobs: [string, string, string][] = [
      [`shuggle-inbox-${this.ns}`, "Shuggle Inbox", "Shuggle command relay for the Shuggle engine. Managed automatically."],
      [`shuggle-outbox-${this.ns}`, "Shuggle Outbox", "Shuggle response relay for the Shuggle engine. Managed automatically."],
      [`shuggle-store-${this.ns}`, "Shuggle Store", "Shuggle engine storage for chats and memories. Managed automatically."],
    ];
    for (const [slug, title, desc] of jobs) {
      if (!(await this.kaggle.datasetExists(this.username, slug))) {
        await this.kaggle.datasetUpsert(this.username, slug, title, { ".keep": "shuggle" }, "create");
      }
    }
  }

  async modelDatasetReady(): Promise<boolean> {
    return this.kaggle.datasetExists(this.username, "shuggle-model");
  }

  /** Push (or re-push) the engine notebook and wait for it to be ready.
   *  force=true re-pushes even if a session is alive (the Restart button). */
  async boot(record: TokenRecord, force = false): Promise<void> {
    this.lastError = null;
    const st = await this.kaggle.kernelStatus(this.username, this.slug);
    if (st.status === "RUNNING" && !force) {
      // A session claims to be alive. Verify it actually produces output —
      // Kaggle occasionally leaves zombie sessions (RUNNING with no logs)
      // that would silently queue every new push behind them for hours.
      const alive = await this.sessionProducesOutput(12_000);
      if (alive) {
        this.setState("waking", "Connecting to your engine");
        this.lastSseAt = Date.now();
        await this.attachStreams();
        return;
      }
      this.setState("booting", "Clearing a stuck engine session");
      await this.kaggle.deleteKernel(this.username, this.slug).catch(() => {});
      await sleep(4_000);
    }
    await this.pushAndAttach(record, force ? "Restarting your engine" : "Starting your engine");
  }

  /** True if the kernel's live log yields any line within `windowMs`. */
  private async sessionProducesOutput(windowMs: number): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), windowMs);
      try {
        for await (const raw of this.kaggle.logStream(this.username, this.slug, ctrl.signal)) {
          if (raw.trim()) {
            clearTimeout(timer);
            return true;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* aborted / unavailable */
    }
    return false;
  }

  private async pushAndAttach(record: TokenRecord, bootLabel: string): Promise<void> {
    this.setState("booting", bootLabel);
    this.bootStartedAt = Date.now();
    await this.ensureDatasets();
    if (!(await this.modelDatasetReady())) {
      await this.seedModel(record);
    }
    const script = engineScript({
      bearer: this.secret,
      owner: this.username,
      profile: this.profile,
      contextTokens: this.contextTokens,
      afkSeconds: this.afkSeconds,
    });
    const res = await this.kaggle.pushKernel({
      owner: this.username,
      slug: this.slug,
      title: `Shuggle Engine ${this.ns}`,
      script,
      run: true,
      gpu: true,
      internet: true,
      machineShape: "NvidiaTeslaT4",
      datasetSources: [`${this.username}/shuggle-model`],
      timeoutSeconds: 3600 * 6,
    });
    this.slug = res.slug;
    this.resetRuntime();
    // The status API keeps reporting the PREVIOUS session's COMPLETE/ERROR
    // for the entire queued-boot window (minutes). Shutdown on those is only
    // allowed after the grace period AND without fresh log evidence.
    this.pushedAt = Date.now();
    this.bootGraceUntil = Date.now() + 600_000;
    this.lastSseAt = Date.now();
    await this.attachStreams();
  }

  private resetRuntime(): void {
    this.seenSessionHash = {};
    this.generating.clear();
    this.visionState = "unknown";
    this.visionDetail = null;
  }

  /** One-time model seeding: a CPU-only kernel downloads the model + vision
   *  projector once and stores them as a private dataset on this account.
   *  If a seed kernel is already running (app restarted mid-seed), adopt it. */
  private async seedModel(record: TokenRecord): Promise<void> {
    this.setState("seeding", "Setting up your model (one time only — about 10–20 minutes)");
    this.emit("seed", { phase: "start" });
    let slug = "shuggle-model-seed";
    const existing = await this.kaggle.kernelStatus(this.username, slug);
    if (existing.status !== "RUNNING") {
      const seedScript = SEED_SCRIPT.replace("__BEARER__", this.secret).replace("__OWNER__", this.username);
      const res = await this.kaggle.pushKernel({
        owner: this.username,
        slug,
        title: "Shuggle Model Seed",
        script: seedScript,
        run: true,
        gpu: false,
        internet: true,
        timeoutSeconds: 3600 * 3,
      });
      slug = res.slug;
    }
    // Wait for the seed kernel to complete (poll status; fetch log tail for progress)
    let lastPhase = "";
    while (true) {
      await sleep(20_000);
      const st = await this.kaggle.kernelStatus(this.username, slug);
      if (st.status === "COMPLETE") break;
      if (st.status === "ERROR") {
        this.setState("error", "Model setup failed");
        this.lastError = "model setup failed on Kaggle — will retry next time";
        throw new Error("seed failed");
      }
      try {
        const log = await this.kaggle.kernelLog(this.username, slug);
        const lines = log.split("\n").filter((l) => l.includes("SHUGGLE_SEED"));
        if (lines.length) {
          const last = lines[lines.length - 1];
          const m = last.match(/SHUGGLE_SEED (\{.*\})/);
          if (m) {
            try {
              const j = JSON.parse(m[1]);
              if (j.m !== lastPhase) {
                lastPhase = j.m;
                this.emit("seed", { phase: "progress", detail: j.m });
              }
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* log not ready yet */
      }
    }
    this.emit("seed", { phase: "done" });
  }

  /** Start the log-stream reader + outbox poller + status watcher. */
  attachRelay(): void {
    void this.attachStreams();
  }

  /** Start the log-stream reader + outbox poller + status watcher. */
  private async attachStreams(): Promise<void> {
    this.stopTimers();
    // status watcher: detects external death + zombie sessions
    this.statusTimer = setInterval(async () => {
      if (this.recovering) return;
      if (this.state === "generating" || this.state === "ready" || this.state === "waking" || this.state === "booting") {
        try {
          const st = await this.kaggle.kernelStatus(this.username, this.slug);
          if (st.status === "COMPLETE" || st.status === "ERROR" || st.status === "CANCEL_ACKNOWLEDGED") {
            if (!this.freshSessionEvidence && Date.now() < this.bootGraceUntil) return;
            this.setState(st.status === "ERROR" ? "error" : "sleeping", st.status === "ERROR" ? "The engine hit a problem" : "Your engine is resting");
            if (st.status === "ERROR") this.lastError = st.failureMessage ?? "engine error";
            this.stopTimers();
            return;
          }
          // Zombie watch: a session we SAW producing output went silent.
          if (st.status === "RUNNING" && this.freshSessionEvidence && this.lastSseAt > 0 && Date.now() - this.lastSseAt > 8 * 60_000 && this.state !== "generating") {
            this.recovering = true;
            this.setState("booting", "Clearing a stuck engine session");
            this.stopTimers();
            await this.kaggle.deleteKernel(this.username, this.slug).catch(() => {});
            await sleep(4_000);
            this.recovering = false;
            void this.pushAndAttach({ id: this.username, secret: this.secret } as TokenRecord, "Starting your engine");
          }
        } catch {
          /* transient */
        }
      }
    }, 30_000);

    // outbox poller: durable fallback + boot completion signal
    let lastOutbox = "";
    this.outboxTimer = setInterval(async () => {
      if (this.state === "sleeping" || this.state === "idle") return;
      try {
        const text = await this.kaggle.datasetDownloadText(this.username, `shuggle-outbox-${this.ns}`, "state.json");
        if (!text || text === lastOutbox) return;
        lastOutbox = text;
        const j = JSON.parse(text);
        if ((j.ev === "done" && j.sid) || (j.ev === "sleeping" && j.last_done?.sid)) {
          // authoritative turn completion (log stream may have been missed)
          this.lastDone = j;
          this.emit("outbox-done", j);
          if (j.sid) this.generating.delete(j.sid);
          if (j.last_done?.sid) this.generating.delete(j.last_done.sid);
        } else if (j.ev === "sleeping") {
          // Stale payload guard: a just-pushed session means this "sleeping"
          // belongs to a previous run — confirm with the live status first.
          void (async () => {
            try {
              const st = await this.kaggle.kernelStatus(this.username, this.slug);
              if ((st.status !== "RUNNING" && st.status !== "QUEUED") && Date.now() >= this.bootGraceUntil) {
                this.setState("sleeping", "Your engine is resting");
              }
            } catch {
              /* keep current state */
            }
          })();
        }
      } catch {
        /* not ready */
      }
    }, 5_000);

    // live log reader — fire-and-forget: this loop runs for the engine's
    // whole life, and boot()/adoption must resolve long before it ends.
    void this.readLogLoop();
  }

  private async readLogLoop(): Promise<void> {
    this.abortLog?.abort();
    this.abortLog = new AbortController();
    const signal = this.abortLog.signal;
    let cursor = ""; // dedupe recent lines
    let reconnectDelay = 1000;
    while (!signal.aborted) {
      try {
        for await (const raw of this.kaggle.logStream(this.username, this.slug, signal)) {
          reconnectDelay = 1000;
          for (const line of raw.split("\n")) {
            const m = line.match(/SHUGGLE (\{.*\})\s*$/);
            if (!m) continue;
            let j: any;
            try {
              j = JSON.parse(m[1]);
            } catch {
              continue;
            }
            const key = JSON.stringify(j);
            if (key === cursor) continue;
            cursor = key;
            this.lastSseAt = Date.now();
            this.handleEvent(j);
          }
        }
      } catch {
        /* drop */
      }
      if (signal.aborted) return;
      // Stream ended — reconnect unless the engine is truly gone.
      try {
        const st = await this.kaggle.kernelStatus(this.username, this.slug);
        const alive = st.status === "RUNNING" || st.status === "QUEUED" || st.status === "INITIALIZING";
        if (!alive && (this.freshSessionEvidence || Date.now() >= this.bootGraceUntil)) {
          if (st.status === "COMPLETE") this.setState("sleeping", "Your engine is resting");
          if (st.status === "ERROR") {
            this.setState("error", "The engine hit a problem");
            this.lastError = st.failureMessage ?? "engine error";
          }
          this.stopTimers();
          return;
        }
      } catch {
        /* ignore */
      }
      await sleep(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    }
  }

  private handleEvent(j: any): void {
    switch (j.ev) {
      case "meta":
        if (j.phase === "ready") {
          this.setState("ready");
        } else if (["booting", "installing-deps", "finding-model", "model-copy", "model-copied", "model-local", "loading-model", "model-from-dataset", "model-download-fallback", "store-loaded", "model-ready"].includes(j.phase)) {
          if (this.state !== "generating") this.setState("booting", humanBootPhase(j.phase, j.detail));
        }
        break;
      case "probe":
        this.probe = { chars_per_token: j.chars_per_token, ctx: j.ctx };
        this.emit("probe", this.probe);
        break;
      case "vision-ready":
        this.visionState = "ready";
        this.visionDetail = j.detail ?? null;
        this.emit("vision", { state: "ready", detail: j.detail ?? null });
        break;
      case "vision-unavailable":
        if (this.visionState !== "ready") {
          this.visionState = "unavailable";
          this.visionDetail = j.d ?? null;
          this.emit("vision", { state: "unavailable", detail: j.d ?? null });
        }
        break;
      case "vision-unloaded":
        this.visionState = "off";
        this.visionDetail = null;
        this.emit("vision", { state: "off" });
        break;
      case "config":
        this.emit("config", j.patch ?? {});
        break;
      case "chunk": {
        if (j.k === "text" || j.k === "think") {
          this.emit("chunk", { sid: j.sid, seq: j.seq, kind: j.k, text: j.t });
        }
        break;
      }
      case "reclass":
        this.emit("reclass", { sid: j.sid });
        break;
      case "gen-start":
        this.generating.add(j.sid);
        this.setState("generating");
        break;
      case "done":
        this.generating.delete(j.sid);
        if (this.generating.size === 0) this.setState("ready");
        this.emit("done", {
          sid: j.sid,
          msgId: j.msg_id,
          genMs: j.gen_ms,
          outTokens: j.out_tokens,
          chars: j.chars,
          thinkChars: j.think_chars,
          searchBrief: j.search_brief ?? null,
          searchQueries: j.search_queries ?? null,
          memResults: j.mem_results ?? null,
        });
        break;
      case "failed":
        this.generating.delete(j.sid);
        if (this.generating.size === 0) this.setState("ready");
        this.emit("failed", { sid: j.sid, detail: j.d });
        break;
      case "hash":
        this.seenSessionHash[j.sid] = j.hash;
        this.emit("session-hash", { sid: j.sid, hash: j.hash });
        break;
      case "resync":
        this.seenSessionHash[j.sid] = j.hash;
        this.emit("resync", { sid: j.sid, hash: j.hash });
        break;
      case "mem":
        this.memHash = j.hash ?? "";
        this.emit("mem", { hash: j.hash, text: j.text ?? null });
        break;
      case "store-saved":
        break;
      case "search":
        this.emit("search", { sid: j.sid, phase: j.phase, data: j.data ?? null });
        break;
      case "sleeping": {
        // The log replays past sessions — confirm with the live status before
        // believing an afk-stop.
        void (async () => {
          try {
            const st = await this.kaggle.kernelStatus(this.username, this.slug);
            if (st.status !== "RUNNING" && st.status !== "QUEUED") {
              this.setState("sleeping", "Your engine is resting");
              this.stopTimers();
            }
          } catch {
            /* keep current state */
          }
        })();
        break;
      }
      case "hb":
        break;
      case "cmd":
        break;
      case "err":
        // Non-fatal engine-side error; surface quietly in logs.
        this.emit("engine-log", { where: j.where, detail: j.d });
        break;
    }
  }

  private nextV(): number {
    return ++this.cmdV;
  }

  /** Push a command into the engine's inbox. Media files ride in the same
   *  dataset version as cmd.json — the engine fetches them by name. */
  private async sendCmd(cmd: Record<string, any>, files: Record<string, string | Uint8Array> = {}): Promise<void> {
    cmd.v = this.nextV();
    cmd.profile = this.profile;
    const payload: Record<string, string | Uint8Array> = { "cmd.json": JSON.stringify(cmd), ...files };
    this.lastCmdSentAt = Date.now();
    await this.kaggle.datasetUpsert(this.username, `shuggle-inbox-${this.ns}`, "Shuggle Inbox", payload, `v${cmd.v}`);
  }

  async wakeAndSend(turn: ChatTurn): Promise<void> {
    if (this.state === "idle" || this.state === "sleeping" || this.state === "error") {
      await this.boot({ id: this.username, secret: this.secret } as TokenRecord);
    }
    if (this.seenSessionHash[turn.sid] === undefined) {
      // New session for this engine — create it there, then the delta applies.
      await this.sendCmd({ type: "new_session", sid: turn.sid });
      this.seenSessionHash[turn.sid] = "";
    }
    // Media files ride along in this inbox version.
    const files: Record<string, string | Uint8Array> = {};
    const mediaMeta: any[] = [];
    for (const m of turn.media ?? []) {
      if (m.bytes) {
        files[m.file] = m.bytes;
        mediaMeta.push({ name: m.name, kind: m.kind, file: m.file });
      }
    }
    await this.sendCmd(
      {
        type: "chat",
        sid: turn.sid,
        msg_id: turn.newMsgs[turn.newMsgs.length - 1]?.mid,
        upto_hash: turn.uptoHash,
        truncate_mid: turn.truncateMid ?? null,
        truncate_after_mid: turn.truncateAfterMid ?? null,
        new_msgs: turn.newMsgs,
        system: turn.system,
        settings: turn.settings,
        search: turn.search ?? { enabled: false, max_queries: 3, pages_per_query: 1 },
        memory_hash: turn.memoryHash,
        memory_text: turn.memoryText,
        thinking: turn.thinking,
        skills: turn.skills ?? [],
        media: mediaMeta.length ? mediaMeta : undefined,
      },
      files,
    );
  }

  async resyncPath(sid: string, history: { role: string; content: string; mid?: string }[]): Promise<void> {
    await this.sendCmd({ type: "edit_path", sid, history });
  }

  async setMemory(text: string, hash: string, deleted?: any[]): Promise<void> {
    this.memHash = hash;
    await this.sendCmd({ type: "mem_set", text, hash, deleted: deleted ?? [] });
  }

  async memoryHashRequest(): Promise<string> {
    await this.sendCmd({ type: "mem_get" });
    return this.memHash;
  }

  /** Live engine configuration — applied on the next loop tick, NO restart. */
  async configure(patch: { afkSeconds?: number; vision?: { enabled: boolean; maxFrames?: number; frameSeconds?: number; mediaTokenBudget?: number } }): Promise<void> {
    if (this.state === "idle" || this.state === "sleeping" || this.state === "error") return; // applied at boot
    await this.sendCmd({ type: "config", patch }).catch(() => {});
  }

  async ping(): Promise<void> {
    // Pings ride the same snapshot-semantics inbox as chat commands — a ping
    // must never overwrite a freshly queued chat. Only ping a proven-idle
    // engine, and never within 20s of sending a real command.
    if (this.state !== "ready" && this.state !== "generating") return;
    if (Date.now() - this.lastCmdSentAt < 20_000) return;
    try {
      await this.sendCmd({ type: "stay" });
    } catch {
      /* ping loss is fine */
    }
  }

  async sleepNow(): Promise<void> {
    if (this.state === "idle" || this.state === "sleeping") return;
    try {
      await this.sendCmd({ type: "sleep" });
    } catch {
      /* ignore */
    }
  }

  stopTimers(): void {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.outboxTimer = null;
    this.statusTimer = null;
  }

  shutdown(): void {
    this.stopTimers();
    this.abortLog?.abort();
    this.state = "idle";
  }

  private lastDone: any = null;
}

function humanBootPhase(phase: string, detail?: string): string {
  switch (phase) {
    case "booting":
      return "Starting your engine";
    case "installing-deps":
      return "Preparing the engine (first boot only)";
    case "finding-model":
      return "Locating the model";
    case "model-local":
      return "Model found on engine storage";
    case "model-copy":
      return detail ? `Storing the model (${detail})` : "Storing the model";
    case "model-copied":
      return "Model stored on engine disk";
    case "model-from-dataset":
      return "Model found on your Kaggle storage";
    case "model-download-fallback":
      return "Fetching the model (one time)";
    case "loading-model":
      return "Loading the model into the GPUs";
    case "model-ready":
      return `Model ready${detail ? ` in ${detail}s` : ""}`;
    case "store-loaded":
      return "Restoring your chats";
    default:
      return "Waking up";
  }
}

const SEED_SCRIPT = String.raw`
# Shuggle Model Seed — one-time setup. Downloads the model + vision projector
# once and stores them as a private Kaggle dataset so every future boot mounts
# them instantly.
import json, os, sys, time, urllib.request, urllib.error

BEARER = "__BEARER__"
OWNER = "__OWNER__"
REPO_ID = "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"
FILES = [
    ("Qwen3.8-27B-Uncensored-Q4_K_M.gguf", 16.8),
    ("mmproj-Qwen3.8-27B-Uncensored-F16.gguf", 0.46),
]
BASE = "https://www.kaggle.com/api/v1"
CHUNK = 64 * 1024 * 1024

def slog(m):
    print("SHUGGLE_SEED " + json.dumps({"m": m}, ensure_ascii=False), flush=True)

def rpc(method, body, timeout=600):
    req = urllib.request.Request(BASE + "/" + method, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + BEARER, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

from huggingface_hub import hf_hub_download
tokens = []
for FILENAME, GB in FILES:
    slog("Fetching " + FILENAME + " from Hugging Face (one time)")
    t0 = time.time()
    path = hf_hub_download(repo_id=REPO_ID, filename=FILENAME, local_dir="/kaggle/tmp")
    slog("Downloaded in " + str(int(time.time() - t0)) + "s")
    size = os.path.getsize(path)
    j = rpc("blobs.BlobApiService/StartBlobUpload", {"type": "DATASET", "name": FILENAME,
        "contentType": "application/octet-stream", "contentLength": size,
        "lastModifiedEpochSeconds": int(time.time())})
    slog("Uploading " + FILENAME + " to your Kaggle storage (" + str(GB) + " GB)")
    t0 = time.time()
    sent = 0
    with open(path, "rb") as f:
        while sent < size:
            f.seek(sent)
            chunk = f.read(CHUNK)
            headers = {"Content-Length": str(len(chunk)), "Content-Type": "application/octet-stream"}
            headers["Content-Range"] = "bytes " + str(sent) + "-" + str(sent + len(chunk) - 1) + "/" + str(size)
            req = urllib.request.Request(j["createUrl"], data=chunk, headers=headers, method="PUT")
            try:
                with urllib.request.urlopen(req, timeout=900) as r:
                    code = r.status
                    rng = r.headers.get("Range", "")
            except urllib.error.HTTPError as e:
                code = e.code
                rng = e.headers.get("Range", "") if e.headers else ""
                if code not in (200, 201, 308):
                    time.sleep(3)
                    continue
            if code in (200, 201):
                sent = size
                break
            # 308 Resume Incomplete — the server reports how much it already has
            if rng.startswith("bytes=0-"):
                have = int(rng.split("-")[1]) + 1
                if have <= sent:
                    time.sleep(3)
                    continue
                sent = have
            else:
                sent += len(chunk)
            if sent % (CHUNK * 16) < CHUNK or sent >= size:
                rate = sent / max(1e-9, time.time() - t0) / 1e6
                slog("Uploaded " + str(round(sent / 1e9, 2)) + " / " + str(round(size / 1e9, 2)) + " GB (" + str(int(rate)) + " MB/s)")
    tokens.append({"token": j["token"], "description": FILENAME, "columns": []})
    os.remove(path)
slog("Storing as your private model dataset")
try:
    st = rpc("datasets.DatasetApiService/GetDatasetStatus", {"ownerSlug": OWNER, "datasetSlug": "shuggle-model"})
    exists = "NOT_FOUND" not in json.dumps(st)
except Exception:
    exists = False
body = {"files": tokens,
        "subtitle": "Shuggle engine model",
        "description": "Shuggle engine model storage (weights + vision projector). Managed automatically.",
        "categoryIds": [], "versionNotes": "seed"}
if exists:
    rpc("datasets.DatasetApiService/CreateDatasetVersion", {"ownerSlug": OWNER, "datasetSlug": "shuggle-model", "body": body}, 900)
else:
    rpc("datasets.DatasetApiService/CreateDataset", {"ownerSlug": OWNER, "slug": "shuggle-model", "title": "Shuggle Model",
        "licenseName": "CC0-1.0", "isPrivate": True, **body}, 900)
slog("Setup complete — the model now loads instantly on every boot")
print("SEED_DONE", flush=True)
`;
