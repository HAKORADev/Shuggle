// Shuggle — memory_handler.cpp
#include "memory_handler.h"

#include <nlohmann/json.hpp>

#include "util.h"

using nlohmann::json;

namespace shuggle {

MemoryHandler::MemoryHandler(const std::string& file_path) : file_(file_path) {}

bool MemoryHandler::load() {
    entries_.clear();
    stash_.clear();
    std::string data;
    if (!read_file(file_, data) || data.empty()) return true;
    try {
        json j = json::parse(data);
        for (const auto& e : j.value("entries", json::array())) {
            MemoryEntry m;
            m.id = e.value("id", "");
            m.text = e.value("text", "");
            m.created = e.value("created", (int64_t)0);
            m.updated = e.value("updated", (int64_t)0);
            m.deleted = e.value("deleted", false);
            if (!m.id.empty()) entries_.push_back(std::move(m));
        }
        stash_ = j.value("stash", "");
        file_hash_ = j.value("file_hash", "");
        return true;
    } catch (...) {
        return false;
    }
}

bool MemoryHandler::save() const {
    json j;
    j["entries"] = json::array();
    for (const auto& e : entries_) {
        j["entries"].push_back({{"id", e.id},
                                {"text", e.text},
                                {"created", e.created},
                                {"updated", e.updated},
                                {"deleted", e.deleted}});
    }
    j["stash"] = stash_;
    j["file_hash"] = file_hash_;
    return write_file(file_, j.dump(2));
}

std::vector<MemoryEntry> MemoryHandler::all() const {
    std::vector<MemoryEntry> out;
    for (const auto& e : entries_)
        if (!e.deleted) out.push_back(e);
    return out;
}

std::vector<MemoryEntry> MemoryHandler::deleted() const {
    std::vector<MemoryEntry> out;
    for (const auto& e : entries_)
        if (e.deleted) out.push_back(e);
    return out;
}

std::string MemoryHandler::render_markdown(bool include_deleted) const {
    std::string out;
    for (const auto& e : entries_) {
        if (e.deleted && !include_deleted) continue;
        out += "- [" + e.id + "] " + e.text + "\n";
    }
    return out;
}

size_t MemoryHandler::char_count() const {
    size_t n = 0;
    for (const auto& e : entries_)
        if (!e.deleted) n += e.text.size() + e.id.size() + 5;
    return n;
}

bool MemoryHandler::set_entries(std::vector<MemoryEntry> entries) {
    stash_ = json(entries_).dump();
    entries_ = std::move(entries);
    return save();
}

bool MemoryHandler::set_raw_text(const std::string& markdown_text) {
    // parse "- [m-xxxx] text" lines; plain "- text" lines get fresh ids
    std::vector<MemoryEntry> parsed;
    for (const auto& raw_line : split(markdown_text, '\n')) {
        std::string line = trim(raw_line);
        if (line.empty()) continue;
        if (!starts_with(line, "-")) continue; // ignore headings/blank
        line = line.substr(1);
        line = trim(line);
        std::string id;
        if (starts_with(line, "[")) {
            size_t close = line.find(']');
            if (close != std::string::npos) {
                id = trim(line.substr(1, close - 1));
                line = trim(line.substr(close + 1));
            }
        }
        MemoryEntry m;
        m.id = id.empty() ? "m-" + random_hex(4) : id;
        m.text = line;
        m.created = now_epoch_seconds();
        m.updated = m.created;
        if (!m.text.empty()) parsed.push_back(std::move(m));
    }
    return set_entries(std::move(parsed));
}

MemoryOpResult MemoryHandler::op_create(const std::string& text) {
    MemoryOpResult r;
    r.op = "create";
    std::string t = trim(text);
    if (t.empty()) {
        r.detail = "create failed: empty text";
        return r;
    }
    if (char_count() + t.size() + 12 > kMemoryMaxChars) {
        r.detail = "create failed: memory budget exceeded (" +
                   std::to_string(kMemoryMaxChars) + " chars)";
        return r;
    }
    stash_ = json(entries_).dump();
    MemoryEntry m;
    m.id = "m-" + random_hex(4);
    m.text = t;
    m.created = now_epoch_seconds();
    m.updated = m.created;
    std::string id = m.id;
    entries_.push_back(std::move(m));
    r.ok = save();
    r.detail = "created memory " + id;
    return r;
}

MemoryOpResult MemoryHandler::op_edit(const std::string& id, const std::string& text) {
    MemoryOpResult r;
    r.op = "edit";
    for (auto& e : entries_) {
        if (e.id != id || e.deleted) continue;
        stash_ = json(entries_).dump();
        e.text = trim(text);
        e.updated = now_epoch_seconds();
        r.ok = save();
        r.detail = "edited memory " + id;
        return r;
    }
    r.detail = "edit failed: no live memory with id " + id;
    return r;
}

MemoryOpResult MemoryHandler::op_delete(const std::string& id) {
    MemoryOpResult r;
    r.op = "delete";
    for (auto& e : entries_) {
        if (e.id != id || e.deleted) continue;
        stash_ = json(entries_).dump();
        e.deleted = true;
        e.updated = now_epoch_seconds();
        r.ok = save();
        r.detail = "deleted memory " + id + " (undo available)";
        return r;
    }
    r.detail = "delete failed: no live memory with id " + id;
    return r;
}

MemoryOpResult MemoryHandler::op_list() const {
    MemoryOpResult r;
    r.op = "list";
    r.ok = true;
    r.listed = all();
    r.detail = r.listed.empty() ? "memory is empty"
                                : "listed " + std::to_string(r.listed.size()) + " memories";
    return r;
}

MemoryOpResult MemoryHandler::op_list_deleted() const {
    MemoryOpResult r;
    r.op = "list_deleted";
    r.ok = true;
    r.listed = deleted();
    r.detail = r.listed.empty() ? "no deleted memories"
                                : "listed " + std::to_string(r.listed.size()) + " deleted memories";
    return r;
}

MemoryOpResult MemoryHandler::op_undo() {
    MemoryOpResult r;
    r.op = "undo";
    if (stash_.empty()) {
        r.detail = "undo failed: nothing to undo";
        return r;
    }
    try {
        std::vector<MemoryEntry> restored = json::parse(stash_).get<std::vector<MemoryEntry>>();
        stash_.clear();
        entries_ = std::move(restored);
        r.ok = save();
        r.detail = "undo applied";
        return r;
    } catch (const std::exception& e) {
        r.detail = std::string("undo failed: ") + e.what();
        return r;
    }
}

static bool parse_memory_json(const std::string& body, MemoryOpResult& op_out,
                              std::string& raw_json) {
    // strip possible trailing commas / whitespace; parse the op
    try {
        json j = json::parse(body);
        op_out.op = j.value("op", "");
        raw_json = body;
        return !op_out.op.empty();
    } catch (...) {
        return false;
    }
}

bool MemoryHandler::apply_tool_blocks(const std::string& reply_in, std::string& visible_out,
                                      std::string& note_out,
                                      std::vector<MemoryOpResult>& results) {
    visible_out = reply_in;
    note_out.clear();
    results.clear();
    if (reply_in.find("```memory") == std::string::npos &&
        reply_in.find("``` memory") == std::string::npos)
        return false;

    int created = 0, edited = 0, deleted = 0, other = 0, failed = 0;
    std::string out;
    size_t pos = 0;
    int blocks = 0;
    while (true) {
        size_t start = visible_out.find("```memory", pos);
        if (start == std::string::npos) start = visible_out.find("``` memory", pos);
        if (start == std::string::npos) {
            out += visible_out.substr(pos);
            break;
        }
        if (++blocks > 2) { // abuse cap: keep later blocks visible & unprocessed
            out += visible_out.substr(pos);
            break;
        }
        out += visible_out.substr(pos, start - pos);
        size_t line_end = visible_out.find('\n', start);
        size_t end = visible_out.find("```", line_end == std::string::npos ? start : line_end);
        if (line_end == std::string::npos || end == std::string::npos) {
            out += visible_out.substr(start); // unterminated — keep as-is
            pos = visible_out.size();
            break;
        }
        std::string body = trim(visible_out.substr(line_end + 1, end - (line_end + 1)));
        pos = end + 3;

        MemoryOpResult probe;
        std::string raw;
        if (parse_memory_json(body, probe, raw)) {
            try {
                json j = json::parse(body);
                std::string op = j.value("op", "");
                MemoryOpResult r;
                if (op == "create") r = op_create(j.value("text", ""));
                else if (op == "edit") r = op_edit(j.value("id", ""), j.value("text", ""));
                else if (op == "delete") r = op_delete(j.value("id", ""));
                else if (op == "list") r = op_list();
                else if (op == "list_deleted") r = op_list_deleted();
                else if (op == "undo") r = op_undo();
                else r.detail = "unknown op: " + op;
                if (r.ok) {
                    results.push_back(r);
                    if (op == "create") created++;
                    else if (op == "edit") edited++;
                    else if (op == "delete") deleted++;
                    else other++;
                } else {
                    failed++;
                    results.push_back(r);
                }
            } catch (...) {
                failed++;
            }
        } else {
            failed++;
        }
    }
    visible_out = trim(out);
    if (created || edited || deleted || other || failed) {
        std::vector<std::string> parts;
        if (created) parts.push_back("+" + std::to_string(created));
        if (edited) parts.push_back("~" + std::to_string(edited));
        if (deleted) parts.push_back("-" + std::to_string(deleted));
        if (other) parts.push_back(std::to_string(other) + " ops");
        if (failed) parts.push_back(std::to_string(failed) + " failed");
        note_out = "memory: " + join(parts, ", ");
    }
    return !results.empty();
}

} // namespace shuggle
