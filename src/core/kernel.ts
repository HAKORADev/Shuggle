// Shuggle — engine kernel generator (v3).
//
// Produces the Python script that runs on Kaggle (one engine per token's
// account). Design mirrors HAKORA's unqwen reboot-safe pattern, adapted for
// app-driven operation over pure Kaggle API:
//   - deps: installed into the persistent working folder when possible —
//     later boots skip the install entirely (unqwen "permanent files" trick)
//   - model: mounted from the private `shuggle-model` dataset (GGUF + mmproj),
//     copied once to local disk for fast loads — no mmap-from-FUSE crawl
//   - sessions + memory (incl. soft-deleted memory + revision log): persisted
//     in the private `shuggle-store` dataset, loaded at boot
//   - commands: private `shuggle-inbox` dataset (cmd.json + media files),
//     deduped by `v`
//   - streaming: SHUGGLE lines on stdout (live via the kernel log stream)
//     + durable state in the private `shuggle-outbox` dataset
//   - vision: mmproj handler loaded/unloaded on demand — never a restart
//   - skills: separate system message with its own handler prompt
//   - memory tools: create/edit/delete/list/list_deleted/undo with revisions

import { ENGINE_VERSION } from "../version.ts";

export interface EngineConfig {
  bearer: string;
  owner: string;
  profile: string;
  contextTokens: number;
  afkSeconds: number;
}

interface CmdChat {
  v: number;
  type: "chat";
  sid: string;
  upto_hash: string;
  truncate_mid?: string | null;
  new_msgs: { role: string; content: string; mid?: string }[];
  system: string;
  settings: { temperature: number; top_p: number; max_tokens: number };
  search?: { enabled: boolean; max_queries: number; pages_per_query: number };
  memory_hash?: string | null;
  memory_text?: string | null;
  thinking: boolean;
  skills?: { title: string; when: string; why: string; content: string }[];
  media?: { name: string; kind: "image" | "video"; file: string; mid?: string }[];
}

type Cmd = { v: number; type: string; profile: string } & Record<string, any>;

export function engineScript(cfg: EngineConfig): string {
  const config = JSON.stringify(cfg);
  // The python source avoids backticks and ${} so it embeds cleanly here.
  return ENGINE_BODY.replaceAll("__CONFIG__", config)
    .replaceAll("__ENGINE_VERSION__", String(ENGINE_VERSION));
}

const ENGINE_BODY = String.raw`
# Engine v__ENGINE_VERSION__
import base64
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CFG = json.loads(r'''__CONFIG__''')
BASE = "https://www.kaggle.com/api/v1"
OWNER = CFG["owner"]
PROFILE = CFG["profile"]

MODEL_REPO = "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF"
MODEL_FILE = "Qwen3.8-27B-Uncensored-Q4_K_M.gguf"
MMPROJ_HINT = "mmproj"
WORK = "/kaggle/working"
LIBS_DIR = os.path.join(WORK, "shugglibs")
MODEL_DIR = os.path.join(WORK, "model")
MEDIA_DIR = os.path.join(WORK, "media")
def _slugns(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:20]
NS = _slugns(PROFILE)
STORE_SLUG = "shuggle-store-" + NS
INBOX_SLUG = "shuggle-inbox-" + NS
OUTBOX_SLUG = "shuggle-outbox-" + NS

SEARCH_QUERIES_PROMPT = (
    "You generate web search queries. Given the conversation and the user's latest "
    "message, output up to {max_q} short, specific search queries, one per line, "
    "no numbering, no quotes, no explanations. Queries must be in the language that "
    "will retrieve the best results. Output ONLY queries."
)
SEARCH_DIGEST_PROMPT = (
    "You are a search-result distiller. Below are web results for the user's request. "
    "Produce a compact brief (max 1800 characters) containing ONLY the facts, numbers, "
    "dates and claims from these results that are relevant to answering the user, "
    "preserved accurately with their source titles in parentheses. No opinions, no "
    "advice, no filler, do not answer the user directly. If results are irrelevant or "
    "empty, output exactly: NO_RESULTS."
)
SKILLS_HANDLER_PROMPT = (
    "The user has enabled Skill modules for this chat. Skills are instructions the "
    "user chose in advance - treat them as standing directives from the user, with "
    "slightly lower priority than what the user types in the moment.\n"
    "How to use them:\n"
    "- If the current message matches a skill's 'when it applies' condition, follow "
    "that skill fully for this reply.\n"
    "- If no skill matches, ignore them completely and answer normally. Never mention "
    "skills, their existence, or this block.\n"
    "- If two skills overlap, satisfy both where compatible; otherwise the more "
    "specific one wins.\n"
    "- Skills never override the user's latest explicit request."
)
MEMORY_TOOLS_PROMPT = (
    "You can manage long-term memories with memory operations. To run one, emit a "
    "fenced block like:\n"
    "memory-ops\n"
    '[{"op": "create", "name": "short-name", "content": "the memory text"}]\n'
    "and close the fence. Rules:\n"
    "- Ops: create (name + content), edit (id or name + new content), delete (id or "
    "name), list, list_deleted, undo (optionally with id).\n"
    "- Emit a block ONLY when the user shares something worth remembering long-term, "
    "asks what you remember, asks you to change or forget a memory, or explicitly "
    "wants the list. Do not create memories for small talk or temporary context.\n"
    "- Keep each memory short and factual (one or two sentences).\n"
    "- You may emit multiple blocks in one reply if needed.\n"
    "- The app strips these blocks before your reply is shown; do not repeat their "
    "content in your visible text.\n"
    "- If an op fails (e.g. memory full), a system note will tell you next turn - "
    "then tell the user honestly.\n"
    "The fence marker is three backticks, the word memory-ops, then JSON, then three "
    "backticks - exactly like a normal code block."
)

def slog(m):
    print("SHUGGLE " + json.dumps(m, ensure_ascii=False), flush=True)

def err(where, d):
    slog({"ev": "err", "where": where, "d": str(d)[:300]})

def rpc(method, body, timeout=120):
    req = urllib.request.Request(
        BASE + "/" + method,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + CFG["bearer"], "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def _download_bytes(owner, slug, file_name, timeout=120):
    req = urllib.request.Request(
        BASE + "/datasets.DatasetApiService/DownloadDataset",
        data=json.dumps({"ownerSlug": owner, "datasetSlug": slug, "fileName": file_name, "raw": True}).encode(),
        headers={"Authorization": "Bearer " + CFG["bearer"], "Content-Type": "application/json"},
        method="POST",
    )
    class NR(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    op = urllib.request.build_opener(NR)
    try:
        r = op.open(req, timeout=timeout)
        return r.read()
    except urllib.error.HTTPError as e:
        if e.status in (301, 302, 303, 307, 308):
            with urllib.request.urlopen(e.headers["Location"], timeout=timeout) as r2:
                return r2.read()
        raise

def hsh(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]

# ---------------------------------------------------------------- store ----
STORE = {"sessions": {}, "memory": {"text": "", "hash": "", "deleted": [], "log": []}}

def load_store():
    try:
        raw = _download_bytes(OWNER, STORE_SLUG, "store.json")
        data = json.loads(raw.decode())
        if isinstance(data, dict):
            STORE["sessions"] = data.get("sessions", {})
            mem = data.get("memory", {})
            STORE["memory"] = {
                "text": mem.get("text", ""),
                "hash": mem.get("hash", ""),
                "deleted": mem.get("deleted", []),
                "log": mem.get("log", []),
            }
        slog({"ev": "meta", "phase": "store-loaded", "sessions": len(STORE["sessions"])})
    except Exception as e:
        err("store-load", e)

def save_store():
    try:
        content = json.dumps(STORE, ensure_ascii=False).encode()
        j = rpc("blobs.BlobApiService/StartBlobUpload", {
            "type": "DATASET", "name": "store.json",
            "contentType": "application/octet-stream",
            "contentLength": len(content), "lastModifiedEpochSeconds": int(time.time())})
        req = urllib.request.Request(j["createUrl"], data=content,
            headers={"Content-Type": "application/octet-stream"}, method="PUT")
        with urllib.request.urlopen(req, timeout=300) as r:
            pass
        rpc("datasets.DatasetApiService/CreateDatasetVersion", {
            "ownerSlug": OWNER, "datasetSlug": STORE_SLUG,
            "body": {"files": [{"token": j["token"], "description": "", "columns": []}],
                     "subtitle": "Shuggle store",
                     "description": "Shuggle engine storage (sessions, memory). Managed automatically.",
                     "categoryIds": [], "versionNotes": "t" + str(int(time.time()))}}, 300)
        slog({"ev": "store-saved"})
    except Exception as e:
        err("store-save", e)

# --------------------------------------------------------------- inbox ----
SEEN_V = 0

def read_cmd():
    global SEEN_V
    try:
        raw = _download_bytes(OWNER, INBOX_SLUG, "cmd.json", timeout=30)
        cmd = json.loads(raw.decode())
        if not isinstance(cmd, dict):
            return None
        if cmd.get("v", 0) <= SEEN_V:
            return None
        return cmd
    except Exception:
        return None

def fetch_media(file_name):
    """Download a media file that traveled with the command."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", file_name)
    dest = os.path.join("/kaggle/tmp", "inbox_" + safe)
    try:
        data = _download_bytes(OWNER, INBOX_SLUG, file_name, timeout=300)
        with open(dest, "wb") as f:
            f.write(data)
        return dest
    except Exception as e:
        err("media-fetch", file_name + ": " + str(e))
        return None

def outbox_push(state):
    try:
        content = json.dumps(state, ensure_ascii=False).encode()
        j = rpc("blobs.BlobApiService/StartBlobUpload", {
            "type": "DATASET", "name": "state.json",
            "contentType": "application/octet-stream",
            "contentLength": len(content), "lastModifiedEpochSeconds": int(time.time())})
        req = urllib.request.Request(j["createUrl"], data=content,
            headers={"Content-Type": "application/octet-stream"}, method="PUT")
        with urllib.request.urlopen(req, timeout=120) as r:
            pass
        rpc("datasets.DatasetApiService/CreateDatasetVersion", {
            "ownerSlug": OWNER, "datasetSlug": OUTBOX_SLUG,
            "body": {"files": [{"token": j["token"], "description": "", "columns": []}],
                     "subtitle": "Shuggle outbox",
                     "description": "Shuggle engine responses. Managed automatically.",
                     "categoryIds": [], "versionNotes": "t" + str(int(time.time()))}}, 300)
    except Exception as e:
        err("outbox", e)

# ----------------------------------------------------------------- boot ----
slog({"ev": "meta", "phase": "booting", "engine": "__ENGINE_VERSION__", "profile": PROFILE})

llm = None
VISION = {"handler": None, "mmproj": None, "name": None, "failed": None}
CHARS_PER_TOKEN = 3.2
IMAGE_TOKEN_EST = 600   # 768px ViT, patch16, 2x2 merge -> ~576 embeddings + overhead

def ensure_deps():
    global llm
    # Persistent install: later boots skip pip entirely (unqwen pattern).
    if os.path.isdir(LIBS_DIR) and LIBS_DIR not in sys.path:
        sys.path.insert(0, LIBS_DIR)
    try:
        import llama_cpp  # noqa
        import huggingface_hub  # noqa
        slog({"ev": "meta", "phase": "deps-ready"})
        return
    except ImportError:
        pass
    slog({"ev": "meta", "phase": "installing-deps"})
    for attempt in range(2):
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--upgrade", "pip"], check=False)
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--target", LIBS_DIR,
                            "llama-cpp-python",
                            "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cu121"], check=True)
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--target", LIBS_DIR,
                            "huggingface_hub"], check=True)
            if LIBS_DIR not in sys.path:
                sys.path.insert(0, LIBS_DIR)
            break
        except Exception as e:
            err("deps", e)
            time.sleep(5)
    import llama_cpp  # noqa
    import huggingface_hub  # noqa

def find_file(prefix, suffix):
    for root in (WORK, "/kaggle/input"):
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                low = fn.lower()
                if low.startswith(prefix) and low.endswith(suffix) and "draft" not in low:
                    return os.path.join(dirpath, fn)
    return None

def copy_progress(src, dst, label):
    """Copy with progress events. Resumes if a partial copy exists."""
    total = os.path.getsize(src)
    done = 0
    if os.path.exists(dst):
        done = os.path.getsize(dst)
        if done >= total:
            return dst
        slog({"ev": "meta", "phase": "model-copy", "detail": "resuming at " + str(round(done / 1e9, 1)) + "GB"})
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    t0 = time.time()
    with open(src, "rb") as fsrc, open(dst, "ab" if done else "wb") as fdst:
        fsrc.seek(done)
        while True:
            chunk = fsrc.read(64 * 1024 * 1024)
            if not chunk:
                break
            fdst.write(chunk)
            done += len(chunk)
            if int(time.time() - t0) > 20:
                slog({"ev": "meta", "phase": "model-copy", "detail": str(round(done / 1e9, 1)) + " / " + str(round(total / 1e9, 1)) + " GB"})
                t0 = time.time()
    return dst

def boot_model():
    global llm, CHARS_PER_TOKEN
    ensure_deps()
    slog({"ev": "meta", "phase": "finding-model"})
    mounted = None
    for dirpath, _dirnames, filenames in os.walk("/kaggle/input"):
        for fn in filenames:
            if fn.lower() == MODEL_FILE.lower():
                mounted = os.path.join(dirpath, fn)
                break
        if mounted:
            break
    if mounted:
        local = os.path.join(MODEL_DIR, MODEL_FILE)
        if os.path.exists(local) and os.path.getsize(local) == os.path.getsize(mounted):
            path = local
            slog({"ev": "meta", "phase": "model-local", "detail": "already on engine disk"})
        else:
            slog({"ev": "meta", "phase": "model-copy", "detail": "storing on engine disk"})
            try:
                path = copy_progress(mounted, local, "model")
                slog({"ev": "meta", "phase": "model-copied", "detail": round(os.path.getsize(path) / 1e9, 1)})
            except OSError as e:
                # working folder is full — load straight from the mount instead
                err("model-copy", e)
                try:
                    if os.path.exists(local):
                        os.remove(local)
                except Exception:
                    pass
                path = mounted
    else:
        slog({"ev": "meta", "phase": "model-download-fallback"})
        # /kaggle/tmp — big VM disk, NOT the quota-limited working folder
        from huggingface_hub import hf_hub_download
        try:
            path = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE, local_dir="/kaggle/tmp/model")
        except Exception as e:
            err("hf-download", e)
            path = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE, local_dir="/kaggle/tmp/model",
                                   force_download=True)
    slog({"ev": "meta", "phase": "loading-model"})
    from llama_cpp import Llama
    t0 = time.time()
    llm = Llama(
        model_path=path,
        n_gpu_layers=-1,
        n_ctx=int(CFG.get("contextTokens", 75000)),
        n_batch=512,
        verbose=False,
    )
    slog({"ev": "meta", "phase": "model-ready", "detail": round(time.time() - t0, 1)})
    try:
        samples = {
            "en": "The quick brown fox jumps over the lazy dog while planning its next clever move.",
            "ar": "الذكاء الاصطناعي يغير العالم بسرعة مذهلة في كل المجالات العلمية والعملية.",
            "code": "def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a",
        }
        ratios = {}
        for k, s in samples.items():
            toks = llm.tokenize(s.encode("utf-8"), add_bos=False, special=False)
            ratios[k] = round(len(s) / max(1, len(toks)), 2)
        CHARS_PER_TOKEN = ratios.get("en", 3.2)
        slog({"ev": "probe", "chars_per_token": ratios, "ctx": int(CFG.get("contextTokens", 75000))})
    except Exception as e:
        err("probe", e)

# ---------------------------------------------------------------- vision ----
def vision_available():
    return VISION.get("handler") is not None

def vision_check_ready():
    """Verify an mmproj exists and remember where. Cheap; no model work yet."""
    if VISION.get("mmproj"):
        return True
    p = find_file(MMPROJ_HINT, ".gguf")
    if not p:
        return False
    VISION["mmproj"] = p
    return True

def vision_ensure_loaded():
    """Load the multimodal projector on first use. No engine restart ever."""
    if VISION.get("handler"):
        return True
    if VISION.get("failed"):
        return False
    if not vision_check_ready():
        VISION["failed"] = "no mmproj found on this account's model storage"
        slog({"ev": "vision-unavailable", "d": VISION["failed"]})
        return False
    if llm is None:
        return False
    try:
        import llama_cpp
        names = ["Qwen3VLChatHandler", "Qwen25VLChatHandler", "Qwen2VLChatHandler", "Llava15ChatHandler"]
        handler_cls = None
        picked = None
        for n in names:
            if hasattr(llama_cpp, n):
                handler_cls = getattr(llama_cpp, n)
                picked = n
                break
        if handler_cls is None:
            VISION["failed"] = "installed engine build has no vision handler"
            slog({"ev": "vision-unavailable", "d": VISION["failed"]})
            return False
        t0 = time.time()
        VISION["handler"] = handler_cls(VISION["mmproj"])
        VISION["name"] = picked
        llm.chat_handler = VISION["handler"]
        slog({"ev": "vision-ready", "detail": picked, "load_s": round(time.time() - t0, 1)})
        return True
    except Exception as e:
        VISION["failed"] = str(e)[:300]
        VISION["handler"] = None
        slog({"ev": "vision-unavailable", "d": VISION["failed"]})
        return False

def vision_unload():
    if VISION.get("handler") and llm is not None:
        try:
            llm.chat_handler = None
        except Exception:
            pass
    VISION["handler"] = None
    slog({"ev": "vision-unloaded"})

def media_to_frames(video_path, max_frames, every_n):
    """Extract frames from a video with ffmpeg - hard caps protect the context."""
    outdir = "/kaggle/tmp/frames_" + str(int(time.time() * 1000))
    os.makedirs(outdir, exist_ok=True)
    vf = "fps=1/" + str(max(1, int(every_n))) + ",scale='min(640,iw)':-2"
    try:
        subprocess.run(["ffmpeg", "-y", "-i", video_path, "-vf", vf, "-frames:v",
                        str(max_frames), "-q:v", "7", os.path.join(outdir, "f_%03d.jpg")],
                       check=True, capture_output=True, timeout=180)
    except Exception as e:
        err("ffmpeg", e)
        return []
    frames = sorted(glob.glob(os.path.join(outdir, "f_*.jpg")))[:max_frames]
    return frames

def image_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()

def build_media_message(base_text, media_items, mid):
    """Turn command media into a multimodal user message. Returns (msg, est_tokens)."""
    content_parts = [{"type": "text", "text": base_text}]
    est = 0
    notes = []
    for item in media_items:
        local = item.get("_local")
        if not local:
            notes.append("[attachment unavailable: " + item.get("name", "?") + "]")
            continue
        if item.get("kind") == "video":
            frames = media_to_frames(local, int(CFG.get("visionMaxFrames", 8)), int(CFG.get("visionFrameSeconds", 2)))
            if not frames:
                notes.append("[video could not be read: " + item.get("name", "?") + "]")
                continue
            notes.append("[video: " + item.get("name", "?") + " — " + str(len(frames)) + " frames, one every " + str(CFG.get("visionFrameSeconds", 2)) + "s]")
            for fp in frames:
                content_parts.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64(fp)}})
                est += 350
        else:
            notes.append("[image: " + item.get("name", "?") + "]")
            content_parts.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64(local)}})
            est += IMAGE_TOKEN_EST
    text = base_text
    if notes:
        text = text + "\n\n" + "\n".join(notes)
    content_parts[0] = {"type": "text", "text": text}
    return {"role": "user", "content": content_parts}, est

# ------------------------------------------------------------ generation ----
class Splitter:
    """Qwen3 <think> handling: both explicit <think>...</think> and the
    implicit-open form (template bakes the opener into the prompt).
    If the implicit think never closes, everything is reclassified as text
    (signaled by the reclass event so the app can move its buffer)."""
    def __init__(self):
        self.started = False
        self.explicit = False
        self.in_think = False
        self.done_think = False
        self.buf = ""
        self.think_full = ""
        self.text_full = ""

    def feed(self, piece):
        self.buf += piece
        out = []
        if not self.started:
            if len(self.buf) < 7:
                return out
            self.started = True
            if self.buf.startswith("<think>"):
                self.explicit = True
                self.in_think = True
                self.buf = self.buf[7:]
            else:
                self.in_think = True
        while True:
            if self.in_think:
                idx = self.buf.find("</think>")
                if idx >= 0:
                    chunk = self.buf[:idx]
                    self.buf = self.buf[idx + 8:]
                    if chunk:
                        self.think_full += chunk
                        out.append({"k": "think", "t": chunk})
                    self.in_think = False
                    self.done_think = True
                    continue
                if len(self.buf) > 8:
                    emit = self.buf[:-8]
                    self.buf = self.buf[-8:]
                    if emit:
                        self.think_full += emit
                        out.append({"k": "think", "t": emit})
                break
            else:
                if self.buf:
                    self.text_full += self.buf
                    out.append({"k": "text", "t": self.buf})
                    self.buf = ""
                break
        return out

    def finish(self):
        if self.in_think and not self.done_think:
            if self.explicit:
                self.think_full += self.buf
            else:
                # implicit think never closed — it was plain content all along
                self.text_full += self.buf
                self.buf = ""
                self.in_think = False
                return "reclass"
            self.buf = ""
        elif self.buf:
            self.text_full += self.buf
            self.buf = ""
        return None

def generate(sid, messages, settings, thinking, search_cfg):
    if not thinking:
        messages = [dict(m) for m in messages]
        if messages and messages[-1]["role"] == "user":
            messages[-1]["content"] = messages[-1]["content"].rstrip() + " /no_think"
    t0 = time.time()
    out_tokens = 0
    search_brief = None
    search_queries = []
    if search_cfg and search_cfg.get("enabled"):
        search_brief, search_queries, messages = do_search(messages, search_cfg, settings)
    stream = llm.create_chat_completion(
        messages=messages,
        temperature=float(settings.get("temperature", 0.7)),
        top_p=float(settings.get("top_p", 0.95)),
        max_tokens=int(settings.get("max_tokens", 65536)),
        stream=True,
    )
    sp = Splitter()
    seq = 0
    last_emit = time.time()
    pending = {"think": "", "text": ""}
    for chunk in stream:
        delta = chunk["choices"][0].get("delta", {}) if chunk.get("choices") else {}
        piece = delta.get("content") or ""
        if not piece:
            continue
        out_tokens += 1
        for evk in sp.feed(piece):
            pending[evk["k"]] += evk["t"]
        now = time.time()
        if now - last_emit > 0.45:
            for k in ("think", "text"):
                if pending[k]:
                    slog({"ev": "chunk", "sid": sid, "seq": seq, "k": k, "t": pending[k]})
                    seq += 1
                    pending[k] = ""
            last_emit = now
    fin = sp.finish()
    reclass = fin == "reclass"
    for k in ("think", "text"):
        if pending[k]:
            slog({"ev": "chunk", "sid": sid, "seq": seq, "k": k, "t": pending[k]})
            seq += 1
            pending[k] = ""
    gen_ms = int((time.time() - t0) * 1000)
    thinking_out = sp.think_full if (sp.done_think or sp.explicit) and not reclass else None
    content_out = sp.text_full if not reclass else (sp.think_full + sp.text_full)
    if reclass:
        slog({"ev": "reclass", "sid": sid})
    return {
        "content": content_out,
        "thinking": thinking_out,
        "gen_ms": gen_ms,
        "out_tokens": out_tokens,
        "search_brief": search_brief,
        "search_queries": search_queries,
    }

# ---------------------------------------------------------------- search ----
def ddg_fetch(query, pages):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    results = []
    endpoints = [
        ("https://lite.duckduckgo.com/lite/", True),
        ("https://html.duckduckgo.com/html/", True),
    ]
    for page in range(max(1, pages)):
        form = urllib.parse.urlencode({"q": query, "s": page * 30 if page else 0}).encode()
        got = False
        for url, is_form in endpoints:
            try:
                req = urllib.request.Request(url, data=form if is_form else None,
                                             headers=headers, method="POST" if is_form else "GET")
                if not is_form:
                    req = urllib.request.Request(url + "?" + form.decode(), headers=headers)
                with urllib.request.urlopen(req, timeout=15) as r:
                    html = r.read().decode("utf-8", "ignore")
                parsed = parse_results(html, url)
                if parsed:
                    results.extend(parsed)
                    got = True
                    break
            except Exception:
                continue
        if not got:
            break
        time.sleep(0.4)
    return results

def parse_results(html, url):
    out = []
    if "lite.duckduckgo" in url:
        links = re.findall(r"<a rel=\"nofollow\" href=\"([^\"]+)\" class='result-link'>(.*?)</a>", html, re.S)
        snips = re.findall(r"<td class='result-snippet'>(.*?)</td>", html, re.S)
        for i, (href, title) in enumerate(links):
            title = re.sub(r"<[^>]+>", "", title).strip()
            snip = re.sub(r"<[^>]+>", "", snips[i]).strip() if i < len(snips) else ""
            out.append({"title": title, "snippet": snip[:400], "url": href})
    else:
        blocks = re.findall(r"<a rel=\"nofollow\" class=\"result__a\" href=\"([^\"]+)\">(.*?)</a>", html, re.S)
        snips = re.findall(r"class=\"result__snippet\"[^>]*>(.*?)</a>", html, re.S)
        for i, (href, title) in enumerate(blocks):
            title = re.sub(r"<[^>]+>", "", title).strip()
            snip = re.sub(r"<[^>]+>", "", snips[i]).strip() if i < len(snips) else ""
            out.append({"title": title, "snippet": snip[:400], "url": href})
    return out

def do_search(messages, search_cfg, settings):
    max_q = int(search_cfg.get("max_queries", 3))
    pages = int(search_cfg.get("pages_per_query", 1))
    convo_tail = "\n".join(m.get("content", "")[:600] if isinstance(m.get("content"), str) else "" for m in messages[-6:])
    slog({"ev": "search", "phase": "planning"})
    res = llm.create_chat_completion(
        messages=[{"role": "system", "content": SEARCH_QUERIES_PROMPT.replace("{max_q}", str(max_q))},
                  {"role": "user", "content": convo_tail}],
        temperature=0.2, max_tokens=120)
    raw = res["choices"][0]["message"]["content"].strip()
    queries = [q.strip("-*0123456789. ") for q in raw.splitlines() if q.strip()][:max_q]
    slog({"ev": "search", "phase": "queries", "data": queries})
    all_results = []
    for q in queries:
        all_results.extend(ddg_fetch(q, pages))
    all_results = all_results[:24]
    slog({"ev": "search", "phase": "results", "data": len(all_results)})
    if not all_results:
        return None, queries, messages
    blobs = []
    for i, r in enumerate(all_results):
        blobs.append(f"[{i+1}] {r['title']} — {r['snippet']}")
    results_text = "\n".join(blobs)[:9000]
    slog({"ev": "search", "phase": "digesting"})
    dres = llm.create_chat_completion(
        messages=[{"role": "system", "content": SEARCH_DIGEST_PROMPT},
                  {"role": "user", "content": "User request:\n" + convo_tail[-1500:] + "\n\nResults:\n" + results_text}],
        temperature=0.2, max_tokens=900)
    brief = dres["choices"][0]["message"]["content"].strip()
    if brief == "NO_RESULTS" or not brief:
        slog({"ev": "search", "phase": "empty"})
        return None, queries, messages
    slog({"ev": "search", "phase": "brief", "data": brief[:120]})
    new_messages = list(messages)
    new_messages.insert(len(new_messages) - 1, {
        "role": "system",
        "content": "Fresh web research brief for the user's request (sources in parentheses):\n" + brief,
    })
    return brief, queries, new_messages

# ------------------------------------------------------- memory ops (v3) ----
MEM_CAP = 10000
MEM_DELETED_CAP = 50
MEM_LOG_CAP = 10

def mem_state():
    return STORE["memory"]

def mem_blocks():
    return parse_mem_blocks(mem_state().get("text", ""))

def mem_set_text(new_text):
    mem_state()["text"] = new_text
    mem_state()["hash"] = hsh(new_text)
    slog({"ev": "mem", "hash": mem_state()["hash"], "text": new_text})

def mem_log(line):
    log = mem_state().setdefault("log", [])
    log.append(line)
    mem_state()["log"] = log[-MEM_LOG_CAP:]

def mem_op_create(op):
    content = str(op.get("content", "")).strip()[:2000]
    if not content:
        return "create needs content"
    blocks = mem_blocks()
    new_text = mem_state().get("text", "")
    if len(new_text) + len(content) + 40 > MEM_CAP:
        return "memory is full (" + str(len(new_text)) + "/" + str(MEM_CAP) + " chars) — delete something first"
    mid = str(int(time.time()))[-6:] + str(random_below(1000))
    name = str(op.get("name", "note")).strip()[:40] or "note"
    blocks.append({"name": name, "id": mid, "text": content})
    mem_set_text(serialize_mem_blocks(blocks))
    mem_log("created #" + mid + " (" + name + ")")
    return "created memory #" + mid

def random_below(n):
    import random
    return random.randrange(max(1, n))

def mem_op_edit(op):
    blocks = mem_blocks()
    for b in blocks:
        if b["id"] == op.get("id") or b["name"] == op.get("name"):
            if op.get("content"):
                b["text"] = str(op["content"]).strip()[:2000]
            if op.get("name"):
                b["name"] = str(op["name"]).strip()[:40]
            mem_set_text(serialize_mem_blocks(blocks))
            mem_log("edited #" + b["id"] + " (" + b["name"] + ")")
            return "updated memory #" + b["id"]
    return "no memory matches " + str(op.get("id") or op.get("name"))

def mem_op_delete(op):
    blocks = mem_blocks()
    for i, b in enumerate(blocks):
        if b["id"] == op.get("id") or b["name"] == op.get("name"):
            deleted = mem_state().setdefault("deleted", [])
            deleted.append({"id": b["id"], "name": b["name"], "text": b["text"], "deletedAt": int(time.time())})
            mem_state()["deleted"] = deleted[-MEM_DELETED_CAP:]
            blocks.pop(i)
            mem_set_text(serialize_mem_blocks(blocks))
            mem_log("deleted #" + b["id"] + " (" + b["name"] + ")")
            return "deleted memory #" + b["id"] + " (say undo to restore)"
    return "no memory matches " + str(op.get("id") or op.get("name"))

def mem_op_list(op):
    blocks = mem_blocks()
    if not blocks:
        return "memory is empty"
    lines = []
    for b in blocks:
        lines.append("#" + b["id"] + " " + b["name"] + ": " + b["text"][:80])
    return "\n".join(lines)

def mem_op_list_deleted(op):
    deleted = mem_state().get("deleted", [])
    if not deleted:
        return "nothing deleted"
    return "\n".join("#" + d["id"] + " " + d["name"] + ": " + d["text"][:60] for d in deleted)

def mem_op_undo(op):
    deleted = mem_state().get("deleted", [])
    if not deleted:
        return "nothing to undo"
    target = None
    if op.get("id"):
        target = next((d for d in deleted if d["id"] == op.get("id")), None)
    else:
        target = sorted(deleted, key=lambda d: d.get("deletedAt", 0))[-1]
    if not target:
        return "no deleted memory matches " + str(op.get("id"))
    deleted = [d for d in deleted if d["id"] != target["id"]]
    mem_state()["deleted"] = deleted
    blocks = mem_blocks()
    blocks.append({"name": target["name"], "id": target["id"], "text": target["text"]})
    mem_set_text(serialize_mem_blocks(blocks))
    mem_log("restored #" + target["id"] + " (" + target["name"] + ")")
    return "restored memory #" + target["id"]

MEM_OPS = {
    "create": mem_op_create,
    "edit": mem_op_edit,
    "delete": mem_op_delete,
    "list": mem_op_list,
    "list_deleted": mem_op_list_deleted,
    "undo": mem_op_undo,
}

def apply_memory_ops(ops):
    results = []
    changed = False
    for op in ops:
        if not isinstance(op, dict):
            continue
        fn = MEM_OPS.get(str(op.get("op", "")))
        if not fn:
            results.append("unknown op " + str(op.get("op")))
            continue
        try:
            r = fn(op)
            results.append(r)
            if str(op.get("op")) != "list" and str(op.get("op")) != "list_deleted" and not str(r).startswith(("no memory", "nothing", "memory is full", "create needs", "unknown")):
                changed = True
        except Exception as e:
            results.append("op failed: " + str(e)[:120])
    return results, changed

def extract_memory_ops(text):
    BT = chr(96) * 3
    marker = BT + "memory-ops"
    alt_marker = BT + "memory"
    ops = []
    cleaned_parts = []
    rest = text
    while True:
        start = rest.find(marker)
        used = marker
        if start < 0:
            start = rest.find(alt_marker)
            used = alt_marker
        if start < 0:
            cleaned_parts.append(rest)
            break
        end = rest.find(BT, start + len(used))
        body = rest[start + len(used):end] if end >= 0 else rest[start + len(used):]
        cleaned_parts.append(rest[:start])
        if end >= 0:
            rest = rest[end + 3:]
        else:
            rest = ""
        body = body.strip()
        if body.startswith("json"):
            body = body[4:].strip()
        try:
            parsed = json.loads(body)
            if isinstance(parsed, list):
                ops.extend(parsed)
            else:
                ops.append(parsed)
        except Exception:
            pass
    return ops, "".join(cleaned_parts)

def parse_mem_blocks(text):
    out = []
    cur = None
    for line in text.split("\n"):
        if line.startswith("## ") and " #" in line:
            if cur:
                out.append(cur)
            head = line[3:]
            name, _, mid = head.rpartition(" #")
            cur = {"name": name.strip(), "id": mid.strip(), "text": ""}
        elif cur is not None:
            cur["text"] += line + "\n"
    if cur:
        out.append(cur)
    for b in out:
        b["text"] = b["text"].strip()
    return out

def serialize_mem_blocks(blocks):
    parts = []
    for b in blocks:
        parts.append("## " + b["name"] + " #" + b["id"] + "\n" + b["text"].strip())
    return "\n\n".join(parts)

def handle_mem(cmd):
    if cmd["type"] == "mem_set":
        mem = mem_state()
        mem["text"] = cmd.get("text", "")
        mem["hash"] = cmd.get("hash", "")
        if cmd.get("deleted") is not None:
            mem["deleted"] = cmd.get("deleted", [])
        slog({"ev": "mem", "hash": mem["hash"]})
        save_store()
    elif cmd["type"] == "mem_get":
        mem = mem_state()
        slog({"ev": "mem", "hash": mem.get("hash", ""), "text": mem.get("text", "")[:2000],
              "deleted": len(mem.get("deleted", []))})

# ------------------------------------------------------------- dispatcher ----
def history_projection(hist):
    """Hash-stable projection (media excluded — the app does not track bytes)."""
    return [{"role": m["role"], "content": m["content"], **({"mid": m["mid"]} if m.get("mid") else {})} for m in hist]

def handle_chat(cmd):
    sid = cmd["sid"]
    sess = STORE["sessions"].get(sid, {"history": []})
    hist = sess.get("history", [])
    upto = cmd.get("upto_hash", "")
    cur_hash = hsh(history_projection(hist))
    if cur_hash != upto:
        tm = cmd.get("truncate_mid")
        if tm:
            idx = next((i for i, m in enumerate(hist) if m.get("mid") == tm), -1)
            if idx >= 0 and hsh(history_projection(hist[:idx])) == upto:
                hist = hist[:idx]
                cur_hash = hsh(history_projection(hist))
    if cur_hash != upto:
        ta = cmd.get("truncate_after_mid")
        if ta:
            idx = next((i for i, m in enumerate(hist) if m.get("mid") == ta), -1)
            if idx >= 0 and hsh(history_projection(hist[: idx + 1])) == upto:
                hist = hist[: idx + 1]
                cur_hash = hsh(history_projection(hist))
    if cur_hash != upto:
        tb = cmd.get("truncate_before_mid")
        if tb:
            idx = next((i for i, m in enumerate(hist) if m.get("mid") == tb), -1)
            if idx >= 0 and hsh(history_projection(hist[:idx])) == upto:
                hist = hist[:idx]
                cur_hash = hsh(history_projection(hist))
    if cur_hash != upto:
        slog({"ev": "resync", "sid": sid, "hash": hsh(history_projection(hist))})
        STORE["sessions"][sid] = {"history": hist}
        save_store()
        return

    # media for THIS turn (files traveled with the command)
    media_items = []
    if cmd.get("media"):
        for item in cmd["media"]:
            local = fetch_media(item.get("file", ""))
            if local:
                item["_local"] = local
                media_items.append(item)

    for m in cmd.get("new_msgs", []):
        entry = {"role": m["role"], "content": m["content"], "mid": m.get("mid")}
        if m.get("mid") and str(m.get("mid")) == str(cmd.get("msg_id")) and media_items:
            entry["media"] = [{"name": mi.get("name"), "kind": mi.get("kind"), "file": os.path.basename(mi.get("_local", ""))} for mi in media_items]
        hist.append(entry)

    # sliding window: keep under ~98% of the context window (chars estimate)
    limit = int(CFG.get("contextTokens", 75000)) * 0.98 * CHARS_PER_TOKEN
    def total_chars(h, syslen):
        return syslen + sum(len(m["content"]) for m in h)
    while total_chars(hist, len(cmd.get("system", ""))) > limit and len(hist) > 3:
        hist.pop(0)

    if cmd.get("memory_text") is not None and cmd.get("memory_hash") is not None:
        if mem_state().get("hash") != cmd["memory_hash"]:
            mem_state()["text"] = cmd["memory_text"]
            mem_state()["hash"] = cmd["memory_hash"]

    msgs = [{"role": "system", "content": cmd.get("system", "")}]
    skills = cmd.get("skills") or []
    if skills:
        blocks = []
        for s in skills:
            b = "### Skill: " + s.get("title", "skill") + "\n"
            if s.get("when"):
                b += "When it applies: " + s["when"] + "\n"
            if s.get("why"):
                b += "Why it exists: " + s["why"] + "\n"
            b += "---\n" + s.get("content", "") + "\n---"
            blocks.append(b)
        msgs.append({"role": "system", "content": SKILLS_HANDLER_PROMPT + "\n\nThe skills:\n\n" + "\n\n".join(blocks)})
    if bool(CFG.get("memoryTools", False)):
        msgs.append({"role": "system", "content": MEMORY_TOOLS_PROMPT})
        log_lines = mem_state().get("log", [])
        if log_lines:
            msgs.append({"role": "system", "content": "Memory system results from your last operations:\n" + "\n".join(log_lines[-6:])})

    # build the LLM message list (media attached to the current user turn;
    # older media replaced with honest placeholders once the budget is spent)
    budget = int(CFG.get("mediaBudget", 8000))
    spent = 0
    media_pending = {str(cmd.get("msg_id")): media_items} if media_items else {}
    for m in hist:
        key = str(m.get("mid"))
        if key in media_pending:
            m["_turn_media"] = media_pending[key]
            spent += sum(IMAGE_TOKEN_EST if mi.get("kind") == "image" else 350 * int(CFG.get("visionMaxFrames", 8)) for mi in media_items)
            continue
        if m.get("media"):
            if spent >= budget:
                m["media_dropped"] = True
                m.pop("_turn_media", None)
            else:
                ready = []
                for mi in m.get("media", []):
                    p = os.path.join(MEDIA_DIR, str(mi.get("file", "")))
                    if os.path.exists(p):
                        ready.append({**mi, "_local": p})
                if ready:
                    m["_turn_media"] = ready
                    spent += sum(IMAGE_TOKEN_EST if mi.get("kind") == "image" else 350 * int(CFG.get("visionMaxFrames", 8)) for mi in ready)
                else:
                    m["media_dropped"] = True

    llm_msgs = list(msgs)
    for m in hist:
        turn_media = m.pop("_turn_media", None)
        text = m["content"]
        if m.get("media_dropped") and m.get("role") == "user":
            text = text + "\n\n[media from an earlier message was removed to leave room for the conversation]"
            m["media_dropped"] = False
        if turn_media and vision_ensure_loaded():
            mm, est = build_media_message(text, turn_media, m.get("mid"))
            llm_msgs.append(mm)
        else:
            if turn_media and not vision_available():
                text = text + "\n\n[this message had images/video but vision is not available right now]"
            llm_msgs.append({"role": m["role"], "content": text})

    # persist new media so later turns can still see it
    if media_items:
        os.makedirs(MEDIA_DIR, exist_ok=True)
        for mi in media_items:
            try:
                dest = os.path.join(MEDIA_DIR, os.path.basename(mi["_local"]))
                if not os.path.exists(dest):
                    shutil.copyfile(mi["_local"], dest)
            except Exception:
                pass

    slog({"ev": "gen-start", "sid": sid})
    try:
        result = generate(sid, llm_msgs, cmd.get("settings", {}),
                          bool(cmd.get("thinking", True)), cmd.get("search"))
    except Exception as e:
        err("generate", e)
        slog({"ev": "failed", "sid": sid, "d": str(e)[:300]})
        outbox_push({"ev": "failed", "sid": sid, "v": cmd.get("v", 0), "d": str(e)[:300]})
        return
    mem_results = None
    if bool(CFG.get("memoryTools", False)):
        ops, cleaned = extract_memory_ops(result["content"])
        if ops:
            result["content"] = cleaned
            mem_results, mem_changed = apply_memory_ops(ops)
            if mem_changed:
                save_store()
    hist.append({"role": "assistant", "content": result["content"]})
    STORE["sessions"][sid] = {"history": hist}
    slog({"ev": "done", "sid": sid, "msg_id": cmd.get("msg_id"), "gen_ms": result["gen_ms"],
          "out_tokens": result["out_tokens"], "chars": len(result["content"]),
          "think_chars": len(result["thinking"] or ""), "search_brief": result["search_brief"],
          "search_queries": result["search_queries"],
          "mem_results": mem_results})
    outbox_push({"ev": "done", "sid": sid, "v": cmd.get("v", 0), "gen_ms": result["gen_ms"],
                 "chars": len(result["content"]), "think_chars": len(result["thinking"] or ""),
                 "content": result["content"],
                 "thinking": result["thinking"],
                 "search_brief": result["search_brief"],
                 "search_queries": result["search_queries"],
                 "mem_results": mem_results})
    save_store()

def handle_edit_path(cmd):
    sid = cmd["sid"]
    hist = [{"role": m["role"], "content": m["content"], "mid": m.get("mid")} for m in cmd.get("history", [])]
    STORE["sessions"][sid] = {"history": hist}
    slog({"ev": "hash", "sid": sid, "hash": hsh(history_projection(hist))})
    save_store()

def handle_config(cmd):
    patch = cmd.get("patch", {})
    if "afkSeconds" in patch:
        CFG["afkSeconds"] = max(60, int(patch["afkSeconds"]))
    if "vision" in patch:
        v = patch["vision"] or {}
        CFG["visionEnabled"] = bool(v.get("enabled", False))
        CFG["visionMaxFrames"] = int(v.get("maxFrames", CFG.get("visionMaxFrames", 8)))
        CFG["visionFrameSeconds"] = int(v.get("frameSeconds", CFG.get("visionFrameSeconds", 2)))
        CFG["mediaBudget"] = int(v.get("mediaTokenBudget", CFG.get("mediaBudget", 8000)))
        if not CFG.get("visionEnabled", False):
            vision_unload()
        else:
            VISION["failed"] = None
    slog({"ev": "config", "patch": {k: CFG.get(k) for k in ("afkSeconds", "visionEnabled", "visionMaxFrames", "visionFrameSeconds", "mediaBudget")}})

def dispatch(cmd):
    global SEEN_V, LAST_CMD
    if cmd.get("profile") and cmd["profile"] != PROFILE:
        slog({"ev": "err", "where": "profile", "d": "command is for another profile"})
        return
    SEEN_V = cmd.get("v", SEEN_V + 1)
    LAST_CMD = time.time()
    t = cmd.get("type", "")
    slog({"ev": "cmd", "v": cmd.get("v"), "type": t})
    if t == "ping" or t == "stay":
        return
    if t == "sleep":
        save_store()
        slog({"ev": "sleeping", "reason": "request"})
        outbox_push({"ev": "sleeping", "v": cmd.get("v", 0)})
        time.sleep(1)
        sys.exit(0)
    if t == "config":
        handle_config(cmd)
    elif t == "chat":
        handle_chat(cmd)
    elif t == "edit_path":
        handle_edit_path(cmd)
    elif t == "mem_set" or t == "mem_get":
        handle_mem(cmd)
    elif t == "new_session":
        STORE["sessions"].setdefault(cmd["sid"], {"history": []})
        save_store()
    elif t == "del_session":
        STORE["sessions"].pop(cmd.get("sid"), None)
        save_store()
    else:
        err("dispatch", "unknown type " + t)

def main():
    global LAST_CMD
    os.makedirs("/kaggle/tmp", exist_ok=True)
    load_store()
    boot_model()
    if CFG.get("visionEnabled", False):
        vision_check_ready()
    slog({"ev": "meta", "phase": "ready"})
    LAST_CMD = time.time()
    last_hb = time.time()
    while True:
        cmd = read_cmd()
        if cmd:
            dispatch(cmd)
        if time.time() - last_hb > 45:
            slog({"ev": "hb"})
            last_hb = time.time()
        if time.time() - LAST_CMD > int(CFG.get("afkSeconds", 180)):
            save_store()
            slog({"ev": "sleeping", "reason": "afk"})
            outbox_push({"ev": "sleeping", "reason": "afk"})
            time.sleep(1)
            sys.exit(0)
        time.sleep(2)

try:
    main()
except SystemExit:
    raise
except Exception as e:
    err("fatal", e)
    raise
`;
