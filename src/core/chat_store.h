// Shuggle — chat_store.h
// Sessions as message trees: in-session branches (retry older), branch switching,
// branch-out to a new session, pins, local search. Files: sessions/<id>.json
#pragma once
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "settings.h"

namespace shuggle {

struct Attachment {
    std::string filename;
    std::string content;      // full UTF-8 text
    int64_t chars = 0;
    bool clipped = false;     // refused attachments never enter history, but keep flag
};

struct Message {
    std::string id;
    std::string role;         // "user" | "assistant" | "system"
    std::string content;      // visible content
    std::string thinking;     // <think> content (assistant)
    std::vector<Attachment> attachments;
    int64_t created = 0;
    std::string parent;       // "" = root
    std::vector<std::string> children;
    std::string active_child; // which branch is displayed ("" = none/leaf)
    int elapsed_ms = 0;       // generation wall time
    std::string model;
    std::string memory_ops_note;   // e.g. "memory: +2, ~1" (chip under reply)
    std::string search_note;       // e.g. "web: 2 queries, 8 sources" (chip)
    bool operator==(const Message& o) const { return id == o.id; }
};

struct ChatSearchHit {
    std::string session_id;
    std::string session_title;
    std::string message_id;
    std::string role;
    std::string fragment;     // context around the match
    int64_t created = 0;
};

struct Session {
    std::string id;
    std::string title;
    int64_t created = 0;
    int64_t updated = 0;
    bool pinned = false;
    bool ever_named = false;  // auto-naming feedback ("shines" until named)
    std::string bound_token;  // KGAT token this session prefers ("" = auto)
    std::string bound_username;
    SessionSettings settings;

    std::map<std::string, Message> messages;
    std::vector<std::string> roots;
    std::string active_root;  // which root chain is displayed (usually roots[0])

    // persistence
    static std::optional<Session> load(const std::string& path);
    bool save(const std::string& dir) const;
    bool remove_file(const std::string& dir) const;
};

class ChatStore {
public:
    explicit ChatStore(const std::string& sessions_dir) : dir_(sessions_dir) {}

    // list all session files, newest-updated first
    std::vector<Session> list_sessions(bool include_messages = false) const;

    std::optional<Session> load_session(const std::string& id) const;
    bool save_session(Session& s) const;            // stamps updated, writes file
    bool delete_session(const std::string& id) const;

    // -- tree ops -------------------------------------------------------------
    // append a user message (leaf = current active leaf); returns new message id
    std::string add_user_message(Session& s, const std::string& text,
                                 std::vector<Attachment> attachments = {}) const;
    // append assistant reply under `parent` ("" = after current path).
    // If the parent already has children, this creates a SIBLING BRANCH and makes
    // it active (retry semantics). Returns message id.
    std::string add_assistant_message(Session& s, const std::string& parent_id,
                                      const std::string& content,
                                      const std::string& thinking, int elapsed_ms,
                                      const std::string& model,
                                      const std::string& memory_note,
                                      const std::string& search_note) const;
    // switch which child branch is displayed at a node; updates active path
    void switch_branch(Session& s, const std::string& message_id, int child_index) const;
    // branch index of the active path (for "‹ 2/3 ›" UI)
    int active_branch_index(const Session& s, const std::string& message_id) const;
    // the active path root->leaf
    std::vector<const Message*> active_path(const Session& s) const;
    // deep-copy path up to (and including) message_id into a NEW session
    std::optional<Session> branch_out(const Session& s, const std::string& upto_message_id,
                                      const std::string& new_title) const;
    // count messages in the active path (context size estimate)
    size_t active_path_length(const Session& s) const;

    // -- naming & search --------------------------------------------------------
    static std::string auto_title(const std::string& first_user_text);
    // search: by text (title or message content), optional date range (epoch, 0 = open)
    std::vector<ChatSearchHit> search(const std::string& query, int64_t from_epoch = 0,
                                      int64_t to_epoch = 0,
                                      size_t max_hits = 200) const;

private:
    std::string session_path(const std::string& id) const;
    std::string dir_;
};

// context window builder helpers (shared by CLI/GUI/engine)
struct ContextPiece {
    std::string role;
    std::string content;
};
// Build the chat-completions payload messages from a session path.
// system_prompt is injected first; sliding window trims oldest pairs when over budget.
std::vector<ContextPiece> build_context(const Session& s, const std::string& system_prompt,
                                        int context_tokens,
                                        const std::vector<Attachment>* pending_attachments);
// rough token estimate (chars/3.5 — conservative for mixed scripts)
size_t estimate_tokens(const std::string& text);

// serialize a session exactly as stored on disk (used by the sync engine)
std::string session_file_json(const Session& s);

} // namespace shuggle
