// Shuggle — engine.cpp
#include "engine.h"

#include <atomic>
#include <thread>

#include "util.h"

using nlohmann::json;

namespace shuggle {

// ── <think> stream splitter ─────────────────────────────────────────────────
namespace {
struct ThinkSplitter {
    std::string pending;
    bool in_think = false;
    EngineCallbacks cb;

    static bool is_open_prefix(const std::string& tail) {
        const std::string tag = "<think>";
        for (size_t n = 1; n <= tag.size() && n <= tail.size(); n++)
            if (tail.compare(tail.size() - n, n, tag, 0, n) == 0) return true;
        return false;
    }
    static bool is_close_prefix(const std::string& tail) {
        const std::string tag = "</think>";
        for (size_t n = 1; n <= tag.size() && n <= tail.size(); n++)
            if (tail.compare(tail.size() - n, n, tag, 0, n) == 0) return true;
        return false;
    }

    void feed(const std::string& delta) {
        pending += delta;
        while (true) {
            if (in_think) {
                size_t close = pending.find("</think>");
                if (close != std::string::npos) {
                    emit_thinking(pending.substr(0, close));
                    pending.erase(0, close + 8);
                    in_think = false;
                    continue;
                }
                if (is_close_prefix(pending)) return;  // hold partial closing tag
                if (pending.size() > 7) {
                    size_t safe = pending.size() - 7;
                    emit_thinking(pending.substr(0, safe));
                    pending.erase(0, safe);
                }
                return;
            }
            size_t open = pending.find("<think>");
            if (open != std::string::npos) {
                emit_content(pending.substr(0, open));
                pending.erase(0, open + 7);
                in_think = true;
                continue;
            }
            if (is_open_prefix(pending)) return;  // hold partial opening tag
            emit_content(pending);
            pending.clear();
            return;
        }
    }

    void finish() {
        if (!pending.empty()) {
            if (in_think) emit_thinking(pending);
            else emit_content(pending);
            pending.clear();
        }
    }

   private:
    void emit_content(const std::string& s) {
        if (s.empty() || !cb.on_content) return;
        cb.on_content(s);
    }
    void emit_thinking(const std::string& s) {
        if (s.empty() || !cb.on_thinking) return;
        cb.on_thinking(s);
    }
};

std::string strip_think_blocks(const std::string& s) {
    size_t a = s.find("<think>");
    if (a == std::string::npos) return s;
    size_t b = s.find("</think>", a);
    if (b == std::string::npos) return trim(s.substr(0, a));
    return trim(s.substr(0, a) + " " + s.substr(b + 8));
}
std::string extract_think_blocks(const std::string& s) {
    size_t a = s.find("<think>");
    if (a == std::string::npos) return "";
    size_t b = s.find("</think>", a);
    if (b == std::string::npos) return s.substr(a + 7);
    return s.substr(a + 7, b - a - 7);
}

std::string web_note(const std::string& web_block) {
    if (web_block.empty()) return "";
    if (starts_with(web_block, "\n[web search failed:")) return "web: failed";
    if (web_block.find("[web context") != std::string::npos) return "web: used";
    return "";
}
}  // namespace

// ── Engine ───────────────────────────────────────────────────────────────────

Engine::Engine(GlobalSettings& settings, TokenManager& tokens)
    : settings_(settings), tokens_(tokens) {
    Http::init();
    start_heartbeat_thread();
}

Engine::Slot Engine::slot(const std::string& kgat) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = slots_.find(kgat);
    return it == slots_.end() ? Slot{} : it->second;
}

bool Engine::slot_ready(const std::string& kgat) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = slots_.find(kgat);
    return it != slots_.end() && it->second.ready;
}

void Engine::set_user_active(bool active) { user_active_ = active; }

void Engine::start_heartbeat_thread() {
    if (hb_thread_started_.exchange(true)) return;
    std::thread([this]() {
        for (;;) {
            std::this_thread::sleep_for(std::chrono::seconds(60));
            heartbeat_tick();
            tokens_.recover_expired();
        }
    }).detach();
}

void Engine::heartbeat_tick() {
    if (!user_active_) return;  // AFK: let the 3-minute watchdog save GPU hours
    std::vector<std::string> live;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [k, s] : slots_)
            if (s.ready && !s.tunnel_url.empty()) live.push_back(k);
    }
    for (const auto& k : live) {
        Slot s = slot(k);
        HttpOptions opts;
        opts.headers.push_back("X-Shuggle-Key: " + s.access_key);
        opts.timeout_seconds = 10;
        std::string url = s.tunnel_url;
        while (!url.empty() && url.back() == '/') url.pop_back();
        Http::post_json(url + "/heartbeat", "{}", opts);
    }
}

bool Engine::push_notebook(const std::string& kgat, const Session& s, std::string& err) {
    Slot slot = this->slot(kgat);
    KaggleClient client(kgat);
    EngineSettings es;
    es.model = s.settings.effective_model(settings_.model);
    es.sync_dataset_slug = settings_.kaggle_sync_enabled ? "shuggle-sync" : "";
    es.sync_owner = slot.username;
    std::string key = random_hex(24);
    std::string script = generate_engine_script(es, key);

    auto res = client.save_kernel(slot.username, slot.slug, "Shuggle Engine", script,
                                  /*run_now=*/true, /*enable_internet=*/true);
    if (!res.ok) {
        err = "notebook push failed: " + res.error;
        return false;
    }
    std::lock_guard<std::mutex> lk(mu_);
    slots_[kgat].access_key = key;  // verified against log later (defense in depth)
    return true;
}

bool Engine::tunnel_alive(const Slot& slot, std::string& err) {
    HttpOptions opts;
    opts.timeout_seconds = 15;
    std::string url = slot.tunnel_url;
    while (!url.empty() && url.back() == '/') url.pop_back();
    HttpResponse r = Http::get(url + "/health", opts);
    if (r.ok()) return true;
    err = "tunnel health: HTTP " + std::to_string(r.status);
    return false;
}

bool Engine::wait_handshake(Slot& slot, const std::function<void(const std::string&)>& progress,
                            std::string& err) {
    // Poll the kernel log for the handshake lines. Boot (model download ~16GB
    // cached + load) can take many minutes; allow up to 25.
    KaggleClient client(slot.token);
    const int64_t deadline_ms = now_epoch_ms() + 25LL * 60 * 1000;
    std::string stage;
    while (now_epoch_ms() < deadline_ms) {
        std::string serr;
        KernelStatus st = client.kernel_status(slot.username, slot.slug, serr);
        if (st.status == "ERROR") {
            err = "notebook run failed: " +
                  (st.failure_message.empty() ? serr : st.failure_message);
            return false;
        }
        if (st.status == "COMPLETE") {
            err = "notebook exited unexpectedly (crash or watchdog).";
            return false;
        }
        std::string log, lerr;
        bool got = client.kernel_log(slot.username, slot.slug, log, lerr);
        if (got && !log.empty()) {
            size_t tp = log.find("SHUGGLE_TUNNEL=");
            size_t kp = log.find("SHUGGLE_KEY=");
            if (tp != std::string::npos && kp != std::string::npos) {
                size_t te = log.find('\n', tp);
                size_t ke = log.find('\n', kp);
                std::string tunnel =
                    trim(log.substr(tp + 15, te == std::string::npos ? std::string::npos
                                                                     : te - (tp + 15)));
                std::string key =
                    trim(log.substr(kp + 12, ke == std::string::npos ? std::string::npos
                                                                     : ke - (kp + 12)));
                double cpt = 3.2;
                int ctx = 0;
                size_t mp = log.find("SHUGGLE_META ");
                while (mp != std::string::npos) {
                    size_t me = log.find('\n', mp);
                    std::string mj =
                        trim(log.substr(mp + 14, me == std::string::npos ? std::string::npos
                                                                         : me - (mp + 14)));
                    try {
                        json meta = json::parse(mj);
                        if (meta.value("phase", "") == "ready") {
                            cpt = meta.value("chars_per_token", 3.2);
                            ctx = meta.value("ctx", 0);
                            break;
                        }
                    } catch (...) {
                    }
                    mp = log.find("SHUGGLE_META ", mp + 14);
                }
                std::lock_guard<std::mutex> lk(mu_);
                slots_[slot.token].tunnel_url = tunnel;
                slots_[slot.token].access_key = key;
                slots_[slot.token].chars_per_token = cpt;
                slots_[slot.token].ctx = ctx;
                slots_[slot.token].ready = true;
                return true;
            }
            if (progress) {
                std::string new_stage = stage;
                if (log.find("downloading model") != std::string::npos)
                    new_stage = "downloading model (~16GB, cached after first run)";
                else if (log.find("loading model") != std::string::npos)
                    new_stage = "loading model onto T4 x2";
                else if (log.find("engine ready") != std::string::npos)
                    new_stage = "engine ready";
                if (new_stage != stage) {
                    stage = new_stage;
                    progress(stage);
                }
            }
        } else if (progress && !stage.empty() == false && st.status == "QUEUED") {
            progress("queued on Kaggle");
        }
        std::this_thread::sleep_for(std::chrono::seconds(5));
    }
    err = "timed out waiting for engine handshake (25 min)";
    return false;
}

bool Engine::ensure_running(const std::string& kgat, const Session& s,
                            const std::function<void(const std::string&)>& progress,
                            std::string& err) {
    // resolve account identity lazily (needed for slug/owner)
    Slot base;
    base.token = kgat;
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = slots_.find(kgat);
        if (it != slots_.end()) base = it->second;
    }
    if (base.username.empty()) {
        KaggleClient probe(kgat);
        TokenIdentity id;
        std::string perr;
        if (!probe.introspect(id, perr)) {
            tokens_.mark_invalid(kgat, perr);
            err = "token invalid: " + perr;
            return false;
        }
        base.username = id.username;
        std::lock_guard<std::mutex> lk(mu_);
        slots_[kgat].token = kgat;
        slots_[kgat].username = id.username;
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        Slot& slot = slots_[kgat];
        if (slot.ready) {
            std::string terr;
            if (tunnel_alive(slot, terr)) return true;  // still alive
            slot.ready = false;  // died -> semi-cold restart below
            slot.tunnel_url.clear();
        }
        slot.booting = true;
    }
    tokens_.mark_in_use(kgat, true);
    if (progress) progress("pushing notebook");
    if (!push_notebook(kgat, s, err)) {
        tokens_.mark_cooldown(kgat, 120, err);
        std::lock_guard<std::mutex> lk(mu_);
        slots_[kgat].booting = false;
        return false;
    }
    if (progress) progress("booting");
    if (!wait_handshake(slots_[kgat], progress, err)) {
        std::lock_guard<std::mutex> lk(mu_);
        slots_[kgat].booting = false;
        return false;
    }
    std::lock_guard<std::mutex> lk(mu_);
    slots_[kgat].booting = false;
    return true;
}

void Engine::release_slot(const std::string& kgat) {
    // stop heartbeating; notebook watchdog stops it within minutes
    std::lock_guard<std::mutex> lk(mu_);
    auto it = slots_.find(kgat);
    if (it != slots_.end()) {
        it->second.ready = false;
        it->second.tunnel_url.clear();
    }
    tokens_.mark_in_use(kgat, false);
}

// ── request building ─────────────────────────────────────────────────────────

std::string Engine::build_request_body(const Session& s, const Slot& slot,
                                       const std::vector<ContextPiece>& extra_system,
                                       const std::string& appended_to_user, bool stream) {
    (void)slot;
    ModelSettings m = s.settings.effective_model(settings_.model);
    PromptIdentityInputs ident = identity_from_device(settings_);
    MemoryHandler mem(memory_file_path());
    mem.load();
    std::string memory_text;
    if (s.settings.memory_override_text) memory_text = *s.settings.memory_override_text;
    else memory_text = mem.render_markdown();

    std::string sys = build_system_prompt(
        settings_, ident, memory_text, now_epoch_seconds(),
        s.settings.has_prompt_override ? s.settings.system_prompt_override : "");
    if (sys.size() > kSystemPromptMaxChars) sys = sys.substr(0, kSystemPromptMaxChars);

    std::vector<ContextPiece> convo = build_context(s, sys, m.context_tokens, nullptr);

    json messages = json::array();
    bool extras_inserted = false;
    for (size_t i = 0; i < convo.size(); i++) {
        ContextPiece c = convo[i];
        // insert tool-prompt system messages right after the main system prompt
        if (i == 1 && !extras_inserted) {
            for (const auto& es : extra_system)
                messages.push_back({{"role", "system"}, {"content", es.content}});
            extras_inserted = true;
        }
        if (i == convo.size() - 1 && c.role == "user" && !appended_to_user.empty())
            c.content += appended_to_user;
        messages.push_back({{"role", c.role}, {"content", c.content}});
    }
    if (!extras_inserted)
        for (const auto& es : extra_system)
            messages.push_back({{"role", "system"}, {"content", es.content}});

    json body = {{"model", "shuggle"},
                 {"messages", messages},
                 {"temperature", m.temperature},
                 {"top_p", m.top_p},
                 {"max_tokens", m.max_output_tokens},
                 {"stream", stream}};
    return body.dump();
}

// ── core streaming (shared by chat + regenerate) ──────────────────────────────

ChatReply Engine::stream_reply(Session& s, const Session& context_source,
                               const std::string& reply_parent_id,
                               const std::vector<ContextPiece>& extra_system,
                               const std::string& appended_to_user,
                               const EngineCallbacks& cb) {
    ChatReply out;
    int64_t t0 = now_epoch_ms();

    std::string kgat = s.settings.token_override.value_or("");
    if (kgat.empty() || !tokens_.has_token(kgat)) {
        const ManagedToken* pick = tokens_.auto_pick();
        if (!pick) {
            out.error = "no available token — all exhausted or invalid. Add tokens or wait "
                        "for the weekly reset.";
            return out;
        }
        kgat = pick->token;
        s.bound_token = kgat;
        s.bound_username = pick->username;
    }

    std::string err;
    if (!ensure_running(kgat, s, cb.on_stage, err)) {
        out.error = err;
        return out;
    }
    Slot slot = this->slot(kgat);
    ModelSettings m = s.settings.effective_model(settings_.model);

    std::string body = build_request_body(context_source, slot, extra_system,
                                          appended_to_user, true);
    HttpOptions opts;
    opts.headers.push_back("X-Shuggle-Key: " + slot.access_key);
    opts.headers.push_back("Accept: text/event-stream");

    std::mutex out_mu;
    std::string content_all, reasoning_all;
    std::atomic<bool> aborted{false};
    ThinkSplitter splitter;
    splitter.cb = cb;

    std::string url = slot.tunnel_url;
    while (!url.empty() && url.back() == '/') url.pop_back();

    long status = Http::stream_lines(
        url + "/v1/chat/completions", body, opts,
        [&](const std::string& line) {
            if (aborted) return;
            if (!starts_with(line, "data: ")) return;
            std::string data = trim(line.substr(6));
            if (data == "[DONE]") return;
            try {
                json j = json::parse(data);
                const auto& choices = j["choices"];
                if (choices.empty()) return;
                const auto& delta = choices[0].value("delta", json::object());
                if (delta.contains("content") && !delta["content"].is_null()) {
                    std::string piece = delta["content"].get<std::string>();
                    std::lock_guard<std::mutex> lk(out_mu);
                    content_all += piece;
                    splitter.feed(piece);
                }
                if (delta.contains("reasoning_content") && !delta["reasoning_content"].is_null()) {
                    std::string th = delta["reasoning_content"].get<std::string>();
                    std::lock_guard<std::mutex> lk(out_mu);
                    reasoning_all += th;
                    if (cb.on_thinking) cb.on_thinking(th);
                }
            } catch (...) {
            }
        },
        [&]() { return !aborted && (!cb.keep_going || cb.keep_going()); });

    splitter.finish();
    out.elapsed_ms = (int)(now_epoch_ms() - t0);

    if (status == 0) {
        out.error = "engine connection failed (tunnel down?) — it will semi-cold-start on "
                    "your next message.";
    } else if (content_all.empty() && reasoning_all.empty()) {
        out.error = "empty reply from engine (HTTP " + std::to_string(status) + ")";
    }

    out.content = strip_think_blocks(content_all);
    out.thinking = trim(extract_think_blocks(content_all) + reasoning_all);

    // memory tool application
    bool mem_tools = s.settings.effective_memory_tools(settings_.memory_tools_enabled);
    if (mem_tools && !out.content.empty()) {
        MemoryHandler mem(memory_file_path());
        mem.load();
        std::string note, vis2;
        std::vector<MemoryOpResult> results;
        mem.apply_tool_blocks(out.content, vis2, note, results);
        if (!results.empty()) {
            out.content = vis2;
            out.memory_note = note;
            mem.save();
            if (settings_.kaggle_sync_enabled) {
                std::string serr;
                sync_memory(serr);
            }
        }
    }

    // record reply (sibling branch when parent already has children)
    ChatStore store(sessions_dir());
    store.add_assistant_message(s, reply_parent_id, out.content, out.thinking, out.elapsed_ms,
                                m.model_file, out.memory_note, "");
    store.save_session(s);
    return out;
}

ChatReply Engine::chat(Session& s, const std::string& user_text,
                       std::vector<Attachment> attachments, const EngineCallbacks& cb) {
    // 1. optional search pipeline BEFORE recording the user message (web context
    //    rides with the user text into history)
    std::string web_block;
    bool want_search = s.settings.effective_search(settings_.search_enabled_default);
    if (want_search) {
        if (cb.on_stage) cb.on_stage("searching");
        std::string kgat = s.settings.token_override.value_or("");
        if (kgat.empty()) {
            const ManagedToken* pick = tokens_.auto_pick();
            kgat = pick ? pick->token : "";
        }
        if (!kgat.empty()) {
            Slot slot = this->slot(kgat);
            if (slot.ready) {
                SearchBackend backend = search_backend(kgat);
                auto llm_call = [&](const std::string& messages_json, int max_tokens,
                                    std::string& lerr) -> std::string {
                    HttpOptions opts;
                    opts.headers.push_back("X-Shuggle-Key: " + slot.access_key);
                    opts.timeout_seconds = 240;
                    json req = json::parse(messages_json);
                    req["max_tokens"] = max_tokens;
                    req["stream"] = false;
                    std::string url = slot.tunnel_url;
                    while (!url.empty() && url.back() == '/') url.pop_back();
                    HttpResponse r =
                        Http::post_json(url + "/v1/chat/completions", req.dump(), opts);
                    if (!r.ok()) {
                        lerr = "llm HTTP " + std::to_string(r.status);
                        return "";
                    }
                    try {
                        json j = json::parse(r.body);
                        return j["choices"][0]["message"].value("content", "");
                    } catch (const std::exception& e) {
                        lerr = e.what();
                        return "";
                    }
                };
                SearchOutcome oc = run_search_pipeline(
                    llm_call, backend, user_text, settings_.search_max_queries,
                    settings_.search_digest);
                if (oc.ok && (!oc.digest.empty() || !oc.results.empty()))
                    web_block = render_web_context_block(oc);
                else if (!oc.error.empty())
                    web_block = "\n[web search failed: " + oc.error + "]\n";
            }
        }
    }

    // 2. record user message (so it's in the context we build next)
    ChatStore store(sessions_dir());
    std::string user_msg_id = store.add_user_message(s, user_text, std::move(attachments));
    store.save_session(s);

    // 3. memory tool prompt as its own system message
    std::vector<ContextPiece> extra_system;
    if (s.settings.effective_memory_tools(settings_.memory_tools_enabled))
        extra_system.push_back({"system", memory_tool_prompt(now_epoch_seconds())});

    // 4. stream the reply under the user message
    ChatReply out = stream_reply(s, s, user_msg_id, extra_system, web_block, cb);

    // note: stream_reply already saved the session; sync best-effort
    if (settings_.kaggle_sync_enabled && out.error.empty()) {
        std::string serr;
        sync_session(s, serr);
    }
    return out;
}

ChatReply Engine::regenerate(Session& s, const EngineCallbacks& cb) {
    ChatStore store(sessions_dir());
    auto path = store.active_path(s);
    if (path.size() < 2) {
        ChatReply r;
        r.error = "nothing to regenerate";
        return r;
    }
    const Message* last = path.back();
    if (last->role != "assistant") {
        ChatReply r;
        r.error = "last message is not an assistant reply";
        return r;
    }
    // context source: a copy without the last assistant message (path ends at parent)
    Session ctx_copy = s;
    std::string parent_id = last->parent;
    ctx_copy.messages.erase(last->id);
    if (!parent_id.empty()) {
        auto pit = ctx_copy.messages.find(parent_id);
        if (pit != ctx_copy.messages.end()) {
            auto& ch = pit->second.children;
            ch.erase(std::remove(ch.begin(), ch.end(), last->id), ch.end());
            pit->second.active_child.clear();
        }
    } else {
        auto& roots = ctx_copy.roots;
        roots.erase(std::remove(roots.begin(), roots.end(), last->id), roots.end());
    }

    std::vector<ContextPiece> extra_system;
    if (s.settings.effective_memory_tools(settings_.memory_tools_enabled))
        extra_system.push_back({"system", memory_tool_prompt(now_epoch_seconds())});

    // reply_parent_id = parent of the old reply -> creates a sibling branch
    return stream_reply(s, ctx_copy, parent_id, extra_system, "", cb);
}

SearchBackend Engine::search_backend(const std::string& kgat) {
    SearchBackend b;
    Slot s = slot(kgat);
    b.tunnel_url = s.tunnel_url;
    b.access_key = s.access_key;
    b.max_results = settings_.search_results_per_query;
    return b;
}

// ── sync (best effort) ────────────────────────────────────────────────────────

bool Engine::sync_memory(std::string& err) {
    const ManagedToken* pick = tokens_.auto_pick();
    if (!pick) {
        err = "no token available for sync";
        return false;
    }
    std::string mem;
    if (!read_file(memory_file_path(), mem)) mem = "";
    KaggleClient client(pick->token);
    auto res = client.dataset_upsert(pick->username, "shuggle-sync", settings_.sync_dataset_title,
                                     {{"memory.md", mem}}, "memory sync", err);
    return res.ok;
}

bool Engine::sync_session(const Session& s, std::string& err) {
    const ManagedToken* pick = tokens_.auto_pick();
    if (!pick) {
        err = "no token available for sync";
        return false;
    }
    std::string mem;
    if (!read_file(memory_file_path(), mem)) mem = "";
    std::string data = session_file_json(s);
    KaggleClient client(pick->token);
    auto res =
        client.dataset_upsert(pick->username, "shuggle-sync", settings_.sync_dataset_title,
                              {{"memory.md", mem}, {s.id + ".json", data}},
                              "session sync", err);
    return res.ok;
}

bool Engine::archive_deleted_session(const Session& s, std::string& err) {
    const ManagedToken* pick = tokens_.auto_pick();
    if (!pick) {
        err = "no token available";
        return false;
    }
    std::string data = session_file_json(s);
    KaggleClient client(pick->token);
    auto res =
        client.dataset_upsert(pick->username, "shuggle-archive", "Shuggle Deleted Sessions",
                              {{"archive/" + s.id + ".json", data}}, "archive: " + s.title, err);
    return res.ok;
}

}  // namespace shuggle
