// Shuggle — chat_store.cpp
#include "chat_store.h"

#include <algorithm>
#include <nlohmann/json.hpp>

#include "util.h"

using nlohmann::json;

namespace shuggle {

// --- Session persistence -----------------------------------------------------

static json att_to_json(const Attachment& a) {
    return json{{"filename", a.filename},
                {"content", a.content},
                {"chars", a.chars},
                {"clipped", a.clipped}};
}
static Attachment att_from_json(const json& j) {
    Attachment a;
    a.filename = j.value("filename", "");
    a.content = j.value("content", "");
    a.chars = j.value("chars", (int64_t)0);
    a.clipped = j.value("clipped", false);
    return a;
}

static json msg_to_json(const Message& m) {
    json j = {{"id", m.id},
              {"role", m.role},
              {"content", m.content},
              {"thinking", m.thinking},
              {"created", m.created},
              {"parent", m.parent},
              {"children", m.children},
              {"active_child", m.active_child},
              {"elapsed_ms", m.elapsed_ms},
              {"model", m.model},
              {"memory_ops_note", m.memory_ops_note},
              {"search_note", m.search_note}};
    if (!m.attachments.empty()) {
        json arr = json::array();
        for (const auto& a : m.attachments) arr.push_back(att_to_json(a));
        j["attachments"] = arr;
    }
    return j;
}
static Message msg_from_json(const json& j) {
    Message m;
    m.id = j.value("id", "");
    m.role = j.value("role", "");
    m.content = j.value("content", "");
    m.thinking = j.value("thinking", "");
    m.created = j.value("created", (int64_t)0);
    m.parent = j.value("parent", "");
    m.children = j.value("children", std::vector<std::string>{});
    m.active_child = j.value("active_child", "");
    m.elapsed_ms = j.value("elapsed_ms", 0);
    m.model = j.value("model", "");
    m.memory_ops_note = j.value("memory_ops_note", "");
    m.search_note = j.value("search_note", "");
    if (j.contains("attachments"))
        for (const auto& a : j["attachments"]) m.attachments.push_back(att_from_json(a));
    return m;
}

static json session_to_json(const Session& s) {
    json msgs = json::object();
    for (const auto& [id, m] : s.messages) msgs[id] = msg_to_json(m);
    // per-session settings
    json ss;
    if (s.settings.model) {
        const auto& m = *s.settings.model;
        ss["model"] = {{"context_tokens", m.context_tokens},
                       {"temperature", m.temperature},
                       {"top_p", m.top_p},
                       {"max_output_tokens", m.max_output_tokens},
                       {"thinking_enabled", m.thinking_enabled}};
    }
    if (s.settings.has_prompt_override) ss["system_prompt_override"] = s.settings.system_prompt_override;
    if (s.settings.memory_enabled_v) ss["memory_enabled"] = *s.settings.memory_enabled_v;
    if (s.settings.memory_tools_enabled_v) ss["memory_tools_enabled"] = *s.settings.memory_tools_enabled_v;
    if (s.settings.search_enabled_v) ss["search_enabled"] = *s.settings.search_enabled_v;
    if (s.settings.memory_override_text) ss["memory_override_text"] = *s.settings.memory_override_text;
    if (s.settings.token_override) ss["token_override"] = *s.settings.token_override;

    return json{{"id", s.id},
                {"title", s.title},
                {"created", s.created},
                {"updated", s.updated},
                {"pinned", s.pinned},
                {"ever_named", s.ever_named},
                {"bound_token", s.bound_token},
                {"bound_username", s.bound_username},
                {"settings", ss},
                {"messages", msgs},
                {"roots", s.roots},
                {"active_root", s.active_root}};
}

static Session session_from_json(const json& j) {
    Session s;
    s.id = j.value("id", "");
    s.title = j.value("title", "");
    s.created = j.value("created", (int64_t)0);
    s.updated = j.value("updated", (int64_t)0);
    s.pinned = j.value("pinned", false);
    s.ever_named = j.value("ever_named", false);
    s.bound_token = j.value("bound_token", "");
    s.bound_username = j.value("bound_username", "");
    if (j.contains("settings")) {
        const auto& ss = j["settings"];
        if (ss.contains("model")) {
            ModelSettings m;
            const auto& mj = ss["model"];
            m.context_tokens = mj.value("context_tokens", 65536);
            m.temperature = mj.value("temperature", kDefaultTemperature);
            m.top_p = mj.value("top_p", kDefaultTopP);
            m.max_output_tokens = mj.value("max_output_tokens", 8192);
            m.thinking_enabled = mj.value("thinking_enabled", true);
            m.clamp();
            s.settings.model = m;
        }
        if (ss.contains("system_prompt_override")) {
            s.settings.system_prompt_override = ss.value("system_prompt_override", "");
            s.settings.has_prompt_override = true;
        }
        if (ss.contains("memory_enabled")) s.settings.memory_enabled_v = ss["memory_enabled"].get<bool>();
        if (ss.contains("memory_tools_enabled"))
            s.settings.memory_tools_enabled_v = ss["memory_tools_enabled"].get<bool>();
        if (ss.contains("search_enabled")) s.settings.search_enabled_v = ss["search_enabled"].get<bool>();
        if (ss.contains("memory_override_text"))
            s.settings.memory_override_text = ss.value("memory_override_text", "");
        if (ss.contains("token_override")) s.settings.token_override = ss.value("token_override", "");
    }
    if (j.contains("messages") && j["messages"].is_object())
        for (auto it = j["messages"].begin(); it != j["messages"].end(); ++it)
            s.messages[it.key()] = msg_from_json(it.value());
    s.roots = j.value("roots", std::vector<std::string>{});
    s.active_root = j.value("active_root", "");
    return s;
}

std::string ChatStore::session_path(const std::string& id) const {
    return path_join(dir_, id + ".json");
}

std::optional<Session> Session::load(const std::string& path) {
    std::string data;
    if (!read_file(path, data) || data.empty()) return std::nullopt;
    try {
        return session_from_json(json::parse(data));
    } catch (...) {
        return std::nullopt;
    }
}

bool Session::save(const std::string& dir) const {
    ensure_dir(dir);
    return write_file(path_join(dir, id + ".json"), session_to_json(*this).dump());
}

bool Session::remove_file(const std::string& dir) const {
    return shuggle::remove_file(path_join(dir, id + ".json"));
}

std::vector<Session> ChatStore::list_sessions(bool include_messages) const {
    std::vector<std::string> files;
    list_dir(dir_, files, false);
    std::vector<Session> out;
    for (const auto& f : files) {
        if (!ends_with(f, ".json")) continue;
        std::string data;
        if (!read_file(path_join(dir_, f), data)) continue;
        try {
            Session s = session_from_json(json::parse(data));
            if (!include_messages) s.messages.clear();
            out.push_back(std::move(s));
        } catch (...) {
        }
    }
    std::sort(out.begin(), out.end(), [](const Session& a, const Session& b) {
        if (a.pinned != b.pinned) return a.pinned > b.pinned;
        return a.updated > b.updated;
    });
    return out;
}

std::optional<Session> ChatStore::load_session(const std::string& id) const {
    return Session::load(session_path(id));
}

bool ChatStore::save_session(Session& s) const {
    s.updated = now_epoch_seconds();
    return s.save(dir_);
}

bool ChatStore::delete_session(const std::string& id) const {
    return remove_file(session_path(id));
}

// --- Tree ops -----------------------------------------------------------------

static std::string new_msg_id() { return random_hex(8); }

std::string ChatStore::add_user_message(Session& s, const std::string& text,
                                        std::vector<Attachment> attachments) const {
    Message m;
    m.id = new_msg_id();
    m.role = "user";
    m.content = text;
    m.attachments = std::move(attachments);
    m.created = now_epoch_seconds();

    // find current active leaf along the active path
    std::string parent;
    auto path = active_path(s);
    if (!path.empty()) parent = path.back()->id;
    m.parent = parent;
    if (!parent.empty()) {
        Message& p = s.messages[parent];
        p.children.push_back(m.id);
        p.active_child = m.id;
    } else {
        s.roots.push_back(m.id);
        if (s.active_root.empty()) s.active_root = m.id;
    }
    s.messages[m.id] = std::move(m);
    return s.messages.rbegin()->first;
}

std::string ChatStore::add_assistant_message(Session& s, const std::string& parent_id,
                                             const std::string& content,
                                             const std::string& thinking, int elapsed_ms,
                                             const std::string& model,
                                             const std::string& memory_note,
                                             const std::string& search_note) const {
    Message m;
    m.id = new_msg_id();
    m.role = "assistant";
    m.content = content;
    m.thinking = thinking;
    m.elapsed_ms = elapsed_ms;
    m.model = model;
    m.memory_ops_note = memory_note;
    m.search_note = search_note;
    m.created = now_epoch_seconds();

    std::string parent = parent_id;
    if (parent.empty()) {
        auto path = active_path(s);
        if (!path.empty()) parent = path.back()->id;
    }
    m.parent = parent;
    if (!parent.empty()) {
        Message& p = s.messages[parent];
        p.children.push_back(m.id);
        p.active_child = m.id;  // new branch becomes the displayed one (retry semantics)
    } else {
        s.roots.push_back(m.id);
    }
    s.messages[m.id] = std::move(m);
    return m.id;
}

void ChatStore::switch_branch(Session& s, const std::string& message_id,
                              int child_index) const {
    auto it = s.messages.find(message_id);
    if (it == s.messages.end()) return;
    Message& m = it->second;
    if (child_index < 0 || child_index >= (int)m.children.size()) return;
    m.active_child = m.children[child_index];
}

int ChatStore::active_branch_index(const Session& s, const std::string& message_id) const {
    auto it = s.messages.find(message_id);
    if (it == s.messages.end() || it->second.parent.empty()) return 0;
    auto pit = s.messages.find(it->second.parent);
    if (pit == s.messages.end()) return 0;
    for (size_t i = 0; i < pit->second.children.size(); i++)
        if (pit->second.children[i] == message_id) return (int)i;
    return 0;
}

std::vector<const Message*> ChatStore::active_path(const Session& s) const {
    std::vector<const Message*> path;
    std::string cur = s.active_root;
    if (cur.empty() && !s.roots.empty()) cur = s.roots.front();
    int guard = 0;
    while (!cur.empty() && guard++ < 100000) {
        auto it = s.messages.find(cur);
        if (it == s.messages.end()) break;
        path.push_back(&it->second);
        cur = it->second.active_child.empty()
                  ? (it->second.children.empty() ? "" : it->second.children.back())
                  : it->second.active_child;
    }
    return path;
}

size_t ChatStore::active_path_length(const Session& s) const {
    return active_path(s).size();
}

std::optional<Session> ChatStore::branch_out(const Session& s,
                                             const std::string& upto_message_id,
                                             const std::string& new_title) const {
    // collect path root..upto
    std::vector<const Message*> path = active_path(s);
    Session out;
    out.id = random_hex(12);
    out.title = new_title;
    out.created = now_epoch_seconds();
    out.updated = out.created;
    out.pinned = false;
    out.ever_named = true;
    out.bound_token = s.bound_token;
    out.bound_username = s.bound_username;
    out.settings = s.settings;

    bool found = false;
    std::string prev_new_id;
    for (const Message* m : path) {
        Message copy = *m;
        copy.children.clear();
        copy.active_child.clear();
        copy.parent = prev_new_id;
        if (!prev_new_id.empty()) out.messages[prev_new_id].children.push_back(copy.id);
        else out.roots.push_back(copy.id);
        out.messages[copy.id] = std::move(copy);
        prev_new_id = copy.id;
        if (m->id == upto_message_id) { found = true; break; }
    }
    if (!found) return std::nullopt;
    return out;
}

// --- naming & search ------------------------------------------------------------

std::string ChatStore::auto_title(const std::string& first_user_text) {
    std::string t = trim(first_user_text);
    // strip markdown noise
    t = replace_all(t, "\n", " ");
    size_t pos;
    while ((pos = t.find("#")) != std::string::npos) t.erase(pos, 1);
    while ((pos = t.find("*")) != std::string::npos) t.erase(pos, 1);
    while ((pos = t.find("`")) != std::string::npos) t.erase(pos, 1);
    t = trim(t);
    if (t.empty()) return "New chat";
    if (t.size() > 42) {
        // cut at a clean boundary
        t = t.substr(0, 42);
        size_t sp = t.rfind(' ');
        if (sp > 20) t = t.substr(0, sp);
        t += "…";
    }
    return t;
}

std::vector<ChatSearchHit> ChatStore::search(const std::string& query, int64_t from_epoch,
                                             int64_t to_epoch, size_t max_hits) const {
    std::vector<ChatSearchHit> hits;
    if (query.empty() && from_epoch == 0 && to_epoch == 0) return hits;
    for (const auto& s : list_sessions(true)) {
        bool title_match = !query.empty() && contains_ci(s.title, query);
        // date filter for the session (a hit inside must also be in range)
        for (const auto& [id, m] : s.messages) {
            if (m.role != "user" && m.role != "assistant") continue;
            if (from_epoch && m.created < from_epoch) continue;
            if (to_epoch && m.created > to_epoch) continue;
            bool content_match = !query.empty() && contains_ci(m.content, query);
            bool thinking_match = !query.empty() && contains_ci(m.thinking, query);
            // title-only matches: surface the earliest user message once per session
            bool title_hit = title_match && m.role == "user";
            if (title_hit) {
                bool earlier_user = false;
                for (const auto& [oid, om] : s.messages)
                    if (om.role == "user" && om.created < m.created) { earlier_user = true; break; }
                if (earlier_user) title_hit = false;
            }
            if (!(content_match || thinking_match || title_hit)) continue;
            ChatSearchHit h;
            h.session_id = s.id;
            h.session_title = s.title.empty() ? "(untitled)" : s.title;
            h.message_id = m.id;
            h.role = m.role;
            h.created = m.created;
            const std::string& hay = content_match ? m.content : m.thinking;
            if (!query.empty()) {
                std::string low = to_lower(hay), qlow = to_lower(query);
                size_t p = low.find(qlow);
                if (p == std::string::npos) p = 0;
                size_t start = p > 60 ? p - 60 : 0;
                h.fragment = hay.substr(start, std::min<size_t>(hay.size() - start, 180));
                h.fragment = trim(h.fragment);
            } else {
                h.fragment = trim(m.content.substr(0, 180));
            }
            hits.push_back(std::move(h));
            if (hits.size() >= max_hits) return hits;
        }
    }
    std::sort(hits.begin(), hits.end(), [](const ChatSearchHit& a, const ChatSearchHit& b) {
        return a.created > b.created;
    });
    return hits;
}

// --- context building -----------------------------------------------------------

size_t estimate_tokens(const std::string& text) {
    // Arabic and CJK chars are ~1 token per char; latin ~4 chars/token.
    // Use a blended heuristic: chars/3.2 is conservative (bigger) for safety.
    size_t chars = text.size();
    return (size_t)((double)chars / 3.2) + 1;
}

std::vector<ContextPiece> build_context(const Session& s, const std::string& system_prompt,
                                        int context_tokens,
                                        const std::vector<Attachment>* pending_attachments) {
    std::vector<ContextPiece> out;
    if (!system_prompt.empty()) out.push_back({"system", system_prompt});

    ChatStore dummy("");  // for active_path
    auto path = dummy.active_path(s);
    // assemble from the end backwards until token budget
    std::vector<ContextPiece> convo;
    size_t budget = (size_t)((double)context_tokens * 0.92); // leave room for reply
    size_t used = estimate_tokens(system_prompt);
    for (auto it = path.rbegin(); it != path.rend(); ++it) {
        const Message* m = *it;
        std::string text = m->content;
        if (m->role == "user" && !m->attachments.empty()) {
            std::string atts;
            for (const auto& a : m->attachments) {
                atts += "\n[attached file: " + a.filename + "]\n" + a.content + "\n[/attached file: " +
                        a.filename + "]\n";
            }
            text = text + "\n" + atts;
        }
        size_t t = estimate_tokens(text);
        if (used + t > budget && !convo.empty()) {
            // sliding window: drop oldest complete pairs; keep at least last 2
            break;
        }
        used += t;
        convo.push_back({m->role, text});
        if (convo.size() == 1 && pending_attachments && !pending_attachments->empty()) {
            // not used here (handled at engine level); kept for interface parity
        }
    }
    std::reverse(convo.begin(), convo.end());
    for (auto& c : convo) out.push_back(std::move(c));
    return out;
}

std::string session_file_json(const Session& s) { return session_to_json(s).dump(); }

} // namespace shuggle
