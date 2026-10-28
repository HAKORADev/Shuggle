// Shuggle — engine manager: one engine slot per Kaggle token (account).
//
// States: idle → seeding → booting → ready ⇄ generating → sleeping
// The slot owns: kernel push, inbox commands, live log stream, outbox polling,
// quota watching, and the AFK heartbeat. All failures are translated into
// human states — raw network errors never reach the UI.

import { Kaggle, sleep } from "./kaggle.ts";
import { engineScript } from "./kernel.ts";
import { hsh16 } from "./util.ts";
import { TokenRecord } from "./tokens.ts";
import { EventEmitter } from "node:events";

export type SlotState = "idle" | "seeding" | "booting" | "waking" | "ready" | "generating" | "sleeping" | "error";

export interface SlotEvent {
  slot: string; // username
  type: string;
  [k: string]: any;
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
}

export class EngineSlot {
  readonly username: string;
  private secret: string;
  private kaggle: Kaggle;
  private slug = "shuggle-engine";
  private events: EventEmitter;
  private cmdV = 0;
  private state: SlotState = "idle";
  private abortLog: AbortController | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private profile: string;
  private contextTokens: number;
  private afkSeconds: number;
  private seenSessionHash: Record<string, string> = {};
  private memHash: string = "";
  private probe: { chars_per_token: Record<string, number>; ctx: number } | null = null;
  private lastError: string | null = null;
  private bootStartedAt = 0;
  private generating = new Set<string>(); // sids with in-flight generation

  constructor(opts: { username: string; secret: string; profile: string; contextTokens: number; afkSeconds: number; events: EventEmitter }) {
    this.username = opts.username;
    this.secret = opts.secret;
    this.profile = opts.profile;
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
      ["shuggle-inbox", "Shuggle Inbox", "Shuggle command relay for the Shuggle engine. Managed automatically."],
      ["shuggle-outbox", "Shuggle Outbox", "Shuggle response relay for the Shuggle engine. Managed automatically."],
      ["shuggle-store", "Shuggle Store", "Shuggle engine storage for chats and memories. Managed automatically."],
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

  /** Push (or re-push) the engine notebook and wait for it to be ready. */
  async boot(record: TokenRecord): Promise<void> {
    this.lastError = null;
    const st = await this.kaggle.kernelStatus(this.username, this.slug);
    if (st.status === "RUNNING") {
      // Already alive (e.g. app restarted) — adopt it.
      this.setState("waking", "Connecting to your engine");
      await this.attachStreams();
      return;
    }
    this.setState("booting", "Starting your engine");
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
      title: "Shuggle Engine",
      script,
      run: true,
      gpu: true,
      internet: true,
      machineShape: "NvidiaTeslaT4",
      datasetSources: [`${this.username}/shuggle-model`],
      timeoutSeconds: 3600 * 6,
    });
    this.slug = res.slug;
    await this.attachStreams();
  }

  /** One-time model seeding: a CPU-only kernel downloads the model once and
   *  stores it as a private dataset on this account. Never needs redoing.
   *  If a seed kernel is already running (app restarted mid-seed), adopt it. */
  private async seedModel(record: TokenRecord): Promise<void> {
    this.setState("seeding", "Setting up your model (one time only — about 10–20 minutes)");
    this.emit("seed", { phase: "start" });
    // Adopt an in-flight seed kernel instead of re-pushing a duplicate.
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
    // status watcher: detects external death (timeout, manual stop)
    this.statusTimer = setInterval(async () => {
      if (this.state === "generating" || this.state === "ready" || this.state === "waking" || this.state === "booting") {
        try {
          const st = await this.kaggle.kernelStatus(this.username, this.slug);
          if (st.status === "COMPLETE" || st.status === "ERROR" || st.status === "CANCEL_ACKNOWLEDGED") {
            this.setState(st.status === "ERROR" ? "error" : "sleeping", st.status === "ERROR" ? "The engine hit a problem" : "Your engine is resting");
            if (st.status === "ERROR") this.lastError = st.failureMessage ?? "engine error";
            this.stopTimers();
          }
        } catch {
          /* transient */
        }
      }
    }, 20_000);

    // outbox poller: durable fallback + boot completion signal
    let lastOutbox = "";
    this.outboxTimer = setInterval(async () => {
      if (this.state === "sleeping" || this.state === "idle") return;
      try {
        const text = await this.kaggle.datasetDownloadText(this.username, "shuggle-outbox", "state.json");
        if (!text || text === lastOutbox) return;
        lastOutbox = text;
        const j = JSON.parse(text);
        if (j.ev === "done" && j.sid) {
          // authoritative turn completion (log stream may have been missed)
          this.lastDone = j;
          this.emit("outbox-done", j);
          this.generating.delete(j.sid);
        } else if (j.ev === "sleeping") {
          this.setState("sleeping", "Your engine is resting");
        }
      } catch {
        /* not ready */
      }
    }, 5_000);

    // live log reader
    await this.readLogLoop();
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
            this.handleEvent(j);
          }
        }
      } catch {
        /* drop */
      }
      if (signal.aborted) return;
      // Stream ended — reconnect unless the engine is gone.
      try {
        const st = await this.kaggle.kernelStatus(this.username, this.slug);
        if (st.status !== "RUNNING") {
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
        } else if (["booting", "installing-deps", "finding-model", "loading-model", "model-from-dataset", "model-download-fallback", "store-loaded", "model-ready"].includes(j.phase)) {
          if (this.state !== "generating") this.setState("booting", humanBootPhase(j.phase, j.detail));
        }
        break;
      case "probe":
        this.probe = { chars_per_token: j.chars_per_token, ctx: j.ctx };
        this.emit("probe", this.probe);
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
      case "sleeping":
        this.setState("sleeping", "Your engine is resting");
        this.stopTimers();
        break;
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

  /** Push a command into the engine's inbox. */
  private async sendCmd(cmd: Record<string, any>): Promise<void> {
    cmd.v = this.nextV();
    cmd.profile = this.profile;
    await this.kaggle.datasetUpsert(this.username, "shuggle-inbox", "Shuggle Inbox", { "cmd.json": JSON.stringify(cmd) }, `v${cmd.v}`);
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
    await this.sendCmd({
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
    });
  }

  async resyncPath(sid: string, history: { role: string; content: string; mid?: string }[]): Promise<void> {
    await this.sendCmd({ type: "edit_path", sid, history });
  }

  async setMemory(text: string, hash: string): Promise<void> {
    this.memHash = hash;
    await this.sendCmd({ type: "mem_set", text, hash });
  }

  async memoryHashRequest(): Promise<string> {
    await this.sendCmd({ type: "mem_get" });
    return this.memHash;
  }

  async ping(): Promise<void> {
    if (this.state === "ready" || this.state === "generating" || this.state === "booting") {
      try {
        await this.sendCmd({ type: "stay" });
      } catch {
        /* ping loss is fine */
      }
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
}

function humanBootPhase(phase: string, detail?: string): string {
  switch (phase) {
    case "booting":
      return "Starting your engine";
    case "installing-deps":
      return "Preparing the engine (first boot only)";
    case "finding-model":
      return "Locating the model";
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
# Shuggle Model Seed — one-time setup. Downloads the model once and stores it
# as a private Kaggle dataset so every future boot mounts it instantly.
import json, os, sys, time, urllib.request, urllib.error

BEARER = "__BEARER__"
OWNER = "__OWNER__"
REPO_ID = "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"
FILENAME = "Qwen3.8-27B-Uncensored-Q4_K_M.gguf"
BASE = "https://www.kaggle.com/api/v1"
CHUNK = 64 * 1024 * 1024

def slog(m):
    print("SHUGGLE_SEED " + json.dumps({"m": m}, ensure_ascii=False), flush=True)

def rpc(method, body, timeout=600):
    req = urllib.request.Request(BASE + "/" + method, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + BEARER, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

slog("Fetching the model from Hugging Face (one time)")
from huggingface_hub import hf_hub_download
t0 = time.time()
path = hf_hub_download(repo_id=REPO_ID, filename=FILENAME, local_dir="/kaggle/tmp")
slog("Model downloaded in " + str(int(time.time() - t0)) + "s")

size = os.path.getsize(path)
j = rpc("blobs.BlobApiService/StartBlobUpload", {"type": "DATASET", "name": FILENAME,
    "contentType": "application/octet-stream", "contentLength": size,
    "lastModifiedEpochSeconds": int(time.time())})
token, create_url = j["token"], j["createUrl"]
slog("Uploading to your Kaggle storage (16.8 GB, this takes a while)")
t0 = time.time()
sent = 0
with open(path, "rb") as f:
    while sent < size:
        chunk = f.read(CHUNK)
        end = sent + len(chunk) - 1
        headers = {"Content-Length": str(len(chunk)), "Content-Type": "application/octet-stream"}
        if sent > 0 or len(chunk) < size:
            headers["Content-Range"] = "bytes " + str(sent) + "-" + str(end) + "/" + str(size)
        req = urllib.request.Request(create_url, data=chunk, headers=headers, method="PUT")
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                pass
        except urllib.error.HTTPError as e:
            if e.code not in (200, 201):
                f.seek(sent)
                time.sleep(3)
                continue
        sent += len(chunk)
        if sent % (CHUNK * 16) == 0 or sent >= size:
            rate = sent / max(1e-9, time.time() - t0) / 1e6
            slog("Uploaded " + str(round(sent / 1e9, 2)) + " / " + str(round(size / 1e9, 2)) + " GB (" + str(int(rate)) + " MB/s)")
slog("Storing as your private model dataset")
try:
    st = rpc("datasets.DatasetApiService/GetDatasetStatus", {"ownerSlug": OWNER, "datasetSlug": "shuggle-model"})
    exists = "NOT_FOUND" not in json.dumps(st)
except Exception:
    exists = False
body = {"files": [{"token": token, "description": "", "columns": []}],
        "subtitle": "Shuggle engine model",
        "description": "Shuggle engine model storage. Managed automatically.",
        "categoryIds": [], "versionNotes": "seed"}
if exists:
    rpc("datasets.DatasetApiService/CreateDatasetVersion", {"ownerSlug": OWNER, "datasetSlug": "shuggle-model", "body": body}, 900)
else:
    rpc("datasets.DatasetApiService/CreateDataset", {"ownerSlug": OWNER, "slug": "shuggle-model", "title": "Shuggle Model",
        "licenseName": "CC0-1.0", "isPrivate": True, **body}, 900)
slog("Setup complete — the model now loads instantly on every boot")
print("SEED_DONE", flush=True)
`;
