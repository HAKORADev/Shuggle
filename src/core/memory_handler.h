// Shuggle — memory_handler.h
// One shared memory.md (user-editable), with revisions for undo, and an optional
// single-shot "memory tools" mode: the model emits ```memory {...}``` blocks,
// the app applies them. No agent loops, no tool-call API.
#pragma once
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "settings.h"

namespace shuggle {

struct MemoryEntry {
    std::string id;         // m-xxxxxxxx
    std::string text;
    int64_t created = 0;
    int64_t updated = 0;
    bool deleted = false;   // soft delete (list_deleted / undo support)
};

NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(MemoryEntry, id, text, created, updated, deleted)

struct MemoryOpResult {
    bool ok = false;
    std::string op;             // create/edit/delete/list/list_deleted/undo
    std::string detail;         // human-readable result for the model's next context
    std::vector<MemoryEntry> listed;
};

class MemoryHandler {
public:
    explicit MemoryHandler(const std::string& file_path);

    bool load();
    bool save() const;

    // raw access
    std::vector<MemoryEntry> all() const;            // non-deleted
    std::vector<MemoryEntry> deleted() const;
    // plain markdown rendering (what gets injected into the system prompt)
    std::string render_markdown(bool include_deleted = false) const;
    size_t char_count() const;
    bool set_entries(std::vector<MemoryEntry> entries);  // raw editor writes back
    bool set_raw_text(const std::string& markdown_text); // parse markdown back into entries

    // ops (used by raw editor AND tool mode)
    MemoryOpResult op_create(const std::string& text);
    MemoryOpResult op_edit(const std::string& id, const std::string& text);
    MemoryOpResult op_delete(const std::string& id);
    MemoryOpResult op_list() const;
    MemoryOpResult op_list_deleted() const;
    MemoryOpResult op_undo();

    // tool-mode: extract ```memory {...}``` blocks from a model reply,
    // apply ops, strip blocks from the visible text, build the note chip.
    //   reply_in: raw model output
    //   visible_out: reply with memory blocks removed (trimmed)
    //   note_out: e.g. "memory: +1 created" for the UI chip
    //   results: one per applied op (for the [memory system] context line)
    bool apply_tool_blocks(const std::string& reply_in, std::string& visible_out,
                           std::string& note_out, std::vector<MemoryOpResult>& results);

private:
    std::string file_;
    std::vector<MemoryEntry> entries_;
    std::string stash_;        // last revision for undo
    std::string file_hash_;    // detect external edits
};

} // namespace shuggle
