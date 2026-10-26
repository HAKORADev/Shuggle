// Shuggle — engine.h
// Orchestrates everything remote: engine slots (one per bound token/account),
// notebook lifecycle (push/boot/handshake/heartbeat), streaming chat with
// <think> parsing, memory tool application, search backend, and Kaggle sync.
#pragma once
#include <atomic>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "chat_store.h"
#include "kaggle_client.h"
#include "memory_handler.h"
#include "notebook_template.h"
#include "search_pipeline.h"
#include "settings.h"
#include "system_prompt.h"
#include "token_manager.h"

namespace shuggle {

struct EngineCallbacks {
    std::function<void(const std::string&)> on_content;    // content delta
    std::function<void(const std::string&)> on_thinking;   // thinking delta
    std::function<bool()> keep_going;                      // false = abort generation
    std::function<void(const std::string&)> on_stage;      // lifecycle progress text
};

struct ChatReply {
    std::string content;      // visible content (memory blocks stripped)
    std::string thinking;     // <think> content
    int elapsed_ms = 0;
    std::string memory_note;  // "memory: +1" chip ("" if none)
    std::string error;
    bool aborted = false;
};

class Engine {
public:
    Engine(GlobalSettings& settings, TokenManager& tokens);

    // -- lifecycle ------------------------------------------------------------
    // Make sure the engine notebook for this token is booted and handshaked.
    // progress: "queued", "booting", "loading model", "tunnel", "ready"...
    bool ensure_running(const std::string& kgat, const Session& s,
                        const std::function<void(const std::string&)>& progress,
                        std::string& err);

    // Is this token's slot live (booted + handshaked + tunnel responsive)?
    bool slot_ready(const std::string& kgat);

    // Ask the notebook to stop ASAP (used when user closes a session deliberately);
    // the watchdog does the real work — we simply stop heartbeating.
    void release_slot(const std::string& kgat);

    // -- chat -------------------------------------------------------------------
    // Sends a user message, streams the reply. Appends both messages to the
    // session tree (branch semantics handled by ChatStore). Thread-safe.
    ChatReply chat(Session& s, const std::string& user_text,
                   std::vector<Attachment> attachments, const EngineCallbacks& cb);

    // regenerate: retry the reply of the parent of the current active leaf
    ChatReply regenerate(Session& s, const EngineCallbacks& cb);

    // -- search -----------------------------------------------------------------
    SearchBackend search_backend(const std::string& kgat);

    // -- heartbeat / activity -----------------------------------------------------
    // GUI/CLI sets this when the user is active (window focus, typing).
    void set_user_active(bool active);
    void heartbeat_tick();   // call ~every 30-60s from UI timer or thread

    // -- meta ------------------------------------------------------------------
    struct Slot {
        std::string token;
        std::string username;
        std::string slug = "shuggle-engine";
        std::string tunnel_url;
        std::string access_key;
        double chars_per_token = 3.2;
        int ctx = 0;
        bool booting = false;
        bool ready = false;
    };
    Slot slot(const std::string& kgat);

    // -- sync (best effort, never blocks chat) -----------------------------------
    bool sync_session(const Session& s, std::string& err);
    bool sync_memory(std::string& err);
    bool archive_deleted_session(const Session& s, std::string& err);

private:
    bool push_notebook(const std::string& kgat, const Session& s, std::string& err);
    ChatReply stream_reply(Session& s, const Session& context_source,
                           const std::string& reply_parent_id,
                           const std::vector<ContextPiece>& extra_system,
                           const std::string& appended_to_user, const EngineCallbacks& cb);
    bool wait_handshake(Slot& slot, const std::function<void(const std::string&)>& progress,
                        std::string& err, int max_minutes = 25);
    bool tunnel_alive(const Slot& slot, std::string& err);
    void start_heartbeat_thread();
    std::string build_request_body(const Session& s, const Slot& slot,
                                   const std::vector<ContextPiece>& extra_system,
                                   const std::string& appended_to_user, bool stream);

    GlobalSettings& settings_;
    TokenManager& tokens_;
    std::mutex mu_;
    std::map<std::string, Slot> slots_;   // key: kgat token
    std::atomic<bool> user_active_{false};
    std::atomic<bool> hb_thread_started_{false};
    // streaming parse state
    friend struct ThinkSplitter;
};

} // namespace shuggle
