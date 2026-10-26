// Shuggle — util.h
// Small shared helpers: time, strings, files, paths. No Qt, no deps beyond std.
#pragma once
#include <string>
#include <vector>
#include <optional>
#include <cstdint>

namespace shuggle {

// --- time ---
int64_t now_epoch_seconds();
int64_t now_epoch_ms();
std::string iso8601_utc(int64_t epoch_seconds);          // 2026-10-27T14:03:00Z
std::string iso8601_local(int64_t epoch_seconds, int tz_offset_minutes);
// parse "14918.621704s" (Kaggle timedelta) -> seconds
double parse_timedelta(const std::string& s);
// parse "2026-10-31T00:00:00Z" -> epoch seconds
std::optional<int64_t> parse_iso8601(const std::string& s);
std::string human_duration(double seconds);              // "4h 08m"

// --- strings ---
std::string trim(const std::string& s);
std::string to_lower(const std::string& s);
bool starts_with(const std::string& s, const std::string& p);
bool ends_with(const std::string& s, const std::string& p);
std::vector<std::string> split(const std::string& s, char sep);
std::string join(const std::vector<std::string>& v, const std::string& sep);
std::string slugify(const std::string& s, size_t max_len = 40);
std::string random_hex(size_t nbytes);                   // crypto-ish random (std::random_device)
std::string replace_all(std::string s, const std::string& from, const std::string& to);
bool contains_ci(const std::string& haystack, const std::string& needle);
// rough count of Arabic-script characters (for bidi handling)
size_t arabic_char_count(const std::string& utf8);

// --- files/paths (portable, no std::filesystem dependency on path quoting quirks) ---
bool read_file(const std::string& path, std::string& out);
bool write_file(const std::string& path, const std::string& data);
bool file_exists(const std::string& path);
bool ensure_dir(const std::string& path);                // recursive
std::string path_join(const std::string& a, const std::string& b);
std::string path_join3(const std::string& a, const std::string& b, const std::string& c);
bool list_dir(const std::string& path, std::vector<std::string>& out_names, bool dirs_only = false);
bool remove_tree(const std::string& path);
bool remove_file(const std::string& path);
// sanitize a session name into a filesystem-safe folder name
std::string fs_sanitize(const std::string& s, size_t max_len = 48);

// app folder layout (single-folder app, IMDER/Neonify style)
//   <base>/sessions/<id>.json, <base>/memory.md, <base>/tokens.json,
//   <base>/settings.json, <base>/downloads/<session>/
std::string app_base_dir();        // exe dir if writable, else cwd/shuggle
std::string sessions_dir();
std::string downloads_dir();
std::string memory_file_path();
std::string tokens_file_path();
std::string settings_file_path();

} // namespace shuggle
