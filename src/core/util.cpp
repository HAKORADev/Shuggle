// Shuggle — util.cpp
#include "util.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <ctime>
#include <fstream>
#include <random>
#include <sstream>
#include <sys/stat.h>
#include <sys/types.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <dirent.h>
#include <unistd.h>
#include <limits.h>
#endif

namespace shuggle {

static std::mt19937_64& rng() {
    static thread_local std::mt19937_64 r{std::random_device{}()};
    return r;
}

int64_t now_epoch_seconds() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}
int64_t now_epoch_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string iso8601_utc(int64_t epoch_seconds) {
    std::time_t t = (std::time_t)epoch_seconds;
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

std::string iso8601_local(int64_t epoch_seconds, int tz_offset_minutes) {
    int64_t shifted = epoch_seconds + (int64_t)tz_offset_minutes * 60;
    std::time_t t = (std::time_t)shifted;
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[40];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M", &tm);
    int sign = tz_offset_minutes >= 0 ? '+' : '-';
    int absmin = std::abs(tz_offset_minutes);
    char out[64];
    std::snprintf(out, sizeof(out), "%s:00%c%02d:%02d", buf, sign, absmin / 60, absmin % 60);
    return out;
}

double parse_timedelta(const std::string& s) {
    // formats: "108000s", "14918.621704s", "5.5s"
    if (s.empty() || s.back() != 's') return 0.0;
    try { return std::stod(s.substr(0, s.size() - 1)); } catch (...) { return 0.0; }
}

std::optional<int64_t> parse_iso8601(const std::string& s) {
    std::tm tm{};
    int y = 0, mo = 0, d = 0, h = 0, mi = 0;
    double sec = 0;
    char tzbuf[8] = {0};
    if (std::sscanf(s.c_str(), "%d-%d-%dT%d:%d:%lf%7s", &y, &mo, &d, &h, &mi, &sec, tzbuf) < 5)
        return std::nullopt;
    std::tm base{};
    base.tm_year = y - 1900; base.tm_mon = mo - 1; base.tm_mday = d;
    base.tm_hour = h; base.tm_min = mi; base.tm_sec = (int)sec;
#ifdef _WIN32
    std::time_t t = _mkgmtime(&base);
#else
    std::time_t t = timegm(&base);
#endif
    if (t < 0) return std::nullopt;
    return (int64_t)t;
}

std::string human_duration(double seconds) {
    if (seconds < 0) seconds = 0;
    int total = (int)(seconds + 0.5);
    char buf[64];
    if (total >= 3600)
        std::snprintf(buf, sizeof(buf), "%dh %02dm", total / 3600, (total % 3600) / 60);
    else if (total >= 60)
        std::snprintf(buf, sizeof(buf), "%dm %02ds", total / 60, total % 60);
    else
        std::snprintf(buf, sizeof(buf), "%ds", total);
    return buf;
}

std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace((unsigned char)s[a])) a++;
    while (b > a && std::isspace((unsigned char)s[b - 1])) b--;
    return s.substr(a, b - a);
}

std::string to_lower(const std::string& s) {
    std::string r = s;
    std::transform(r.begin(), r.end(), r.begin(),
                   [](unsigned char c) { return (char)std::tolower(c); });
    return r;
}

bool starts_with(const std::string& s, const std::string& p) {
    return s.size() >= p.size() && s.compare(0, p.size(), p) == 0;
}
bool ends_with(const std::string& s, const std::string& p) {
    return s.size() >= p.size() && s.compare(s.size() - p.size(), p.size(), p) == 0;
}

std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, sep)) out.push_back(item);
    return out;
}

std::string join(const std::vector<std::string>& v, const std::string& sep) {
    std::string r;
    for (size_t i = 0; i < v.size(); i++) {
        if (i) r += sep;
        r += v[i];
    }
    return r;
}

std::string slugify(const std::string& s, size_t max_len) {
    std::string r;
    bool last_dash = true; // avoid leading dashes
    for (char c : s) {
        if (std::isalnum((unsigned char)c)) { r += (char)std::tolower(c); last_dash = false; }
        else if (!last_dash) { r += '-'; last_dash = true; }
        if (r.size() >= max_len) break;
    }
    while (!r.empty() && r.back() == '-') r.pop_back();
    if (r.empty()) r = "shuggle";
    return r;
}

std::string random_hex(size_t nbytes) {
    static const char* hex = "0123456789abcdef";
    std::string out;
    out.reserve(nbytes * 2);
    for (size_t i = 0; i < nbytes; i++) {
        unsigned char b = (unsigned char)(rng()() & 0xFF);
        out += hex[b >> 4];
        out += hex[b & 0xF];
    }
    return out;
}

std::string replace_all(std::string s, const std::string& from, const std::string& to) {
    if (from.empty()) return s;
    size_t pos = 0;
    while ((pos = s.find(from, pos)) != std::string::npos) {
        s.replace(pos, from.size(), to);
        pos += to.size();
    }
    return s;
}

bool contains_ci(const std::string& haystack, const std::string& needle) {
    if (needle.empty()) return true;
    return to_lower(haystack).find(to_lower(needle)) != std::string::npos;
}

size_t arabic_char_count(const std::string& utf8) {
    // Arabic block U+0600-U+06FF, Presentation A/B — count code points in range
    size_t count = 0;
    for (size_t i = 0; i < utf8.size();) {
        unsigned char c = (unsigned char)utf8[i];
        if (c < 0x80) { i++; continue; }
        uint32_t cp = 0; int len = 0;
        if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
        else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
        else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; len = 4; }
        else { i++; continue; }
        if (i + len > utf8.size()) break;
        bool ok = true;
        for (int k = 1; k < len; k++) {
            unsigned char cc = (unsigned char)utf8[i + k];
            if ((cc & 0xC0) != 0x80) { ok = false; break; }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (ok && ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) ||
                   (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)))
            count++;
        i += len;
    }
    return count;
}

bool read_file(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

bool write_file(const std::string& path, const std::string& data) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f << data;
    return f.good();
}

bool file_exists(const std::string& path) {
    struct stat st{};
    return ::stat(path.c_str(), &st) == 0;
}

bool ensure_dir(const std::string& path) {
    if (path.empty()) return false;
    if (file_exists(path)) return true;
    std::string cur;
    for (const auto& part : split(path, '/')) {
        if (part.empty()) { cur += "/"; continue; }
        if (cur.empty()) cur = part;
        else if (cur.back() == '/') cur += part;
        else cur += "/" + part;
        if (cur == "/" || cur.size() <= 1) continue;
#ifdef _WIN32
        // skip drive letters like C:
        if (cur.size() == 2 && cur[1] == ':') continue;
#endif
        ::mkdir(cur.c_str(), 0755);
    }
    return file_exists(path);
}

std::string path_join(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    if (b.empty()) return a;
    if (a.back() == '/' || a.back() == '\\') return a + b;
    if (b.front() == '/' || b.front() == '\\') return a + b;
#ifdef _WIN32
    return a + "\\" + b;
#else
    return a + "/" + b;
#endif
}

std::string path_join3(const std::string& a, const std::string& b, const std::string& c) {
    return path_join(path_join(a, b), c);
}

bool list_dir(const std::string& path, std::vector<std::string>& out_names, bool dirs_only) {
    out_names.clear();
#ifdef _WIN32
    WIN32_FIND_DATAA fd;
    HANDLE h = FindFirstFileA((path + "\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return false;
    do {
        std::string name = fd.cFileName;
        if (name == "." || name == "..") continue;
        bool is_dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (dirs_only && !is_dir) continue;
        out_names.push_back(name);
    } while (FindNextFileA(h, &fd));
    FindClose(h);
    return true;
#else
    DIR* d = opendir(path.c_str());
    if (!d) return false;
    struct dirent* ent;
    while ((ent = readdir(d)) != nullptr) {
        std::string name = ent->d_name;
        if (name == "." || name == "..") continue;
        if (dirs_only) {
            struct stat st{};
            std::string full = path_join(path, name);
            if (::stat(full.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) continue;
        }
        out_names.push_back(name);
    }
    closedir(d);
    std::sort(out_names.begin(), out_names.end());
    return true;
#endif
}

bool remove_tree(const std::string& path) {
#ifdef _WIN32
    std::string cmd = "rmdir /S /Q \"" + path + "\"";
    return system(cmd.c_str()) == 0 || !file_exists(path);
#else
    std::string cmd = "rm -rf '" + replace_all(path, "'", "'\\''") + "'";
    return system(cmd.c_str()) == 0 || !file_exists(path);
#endif
}

bool remove_file(const std::string& path) {
#ifdef _WIN32
    return DeleteFileA(path.c_str()) != 0 || !file_exists(path);
#else
    return ::unlink(path.c_str()) == 0 || !file_exists(path);
#endif
}

std::string fs_sanitize(const std::string& s, size_t max_len) {
    std::string r;
    for (char c : s) {
        unsigned char u = (unsigned char)c;
        if (u < 32 || c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' ||
            c == '"' || c == '<' || c == '>' || c == '|')
            r += '_';
        else
            r += c;
        if (r.size() >= max_len) break;
    }
    r = trim(r);
    if (r.empty()) r = "session";
    return r;
}

static std::string exe_dir() {
#ifdef _WIN32
    char buf[MAX_PATH];
    GetModuleFileNameA(nullptr, buf, MAX_PATH);
    std::string p = buf;
    size_t pos = p.find_last_of("\\/");
    return pos == std::string::npos ? "." : p.substr(0, pos);
#else
    char buf[PATH_MAX];
    ssize_t n = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n <= 0) return ".";
    buf[n] = 0;
    std::string p = buf;
    size_t pos = p.find_last_of('/');
    return pos == std::string::npos ? "." : p.substr(0, pos);
#endif
}

std::string app_base_dir() {
    std::string base = exe_dir();
    // prefer a writable "shuggle-data" next to the binary; fall back to $HOME/.shuggle
    std::string candidate = path_join(base, "shuggle-data");
    if (ensure_dir(candidate)) {
        std::string probe = path_join(candidate, ".probe");
        if (write_file(probe, "x") && remove_file(probe)) return candidate;
    }
    const char* home =
#ifdef _WIN32
        std::getenv("USERPROFILE");
#else
        std::getenv("HOME");
#endif
    if (home) {
        candidate = path_join(home, ".shuggle");
        ensure_dir(candidate);
        return candidate;
    }
    ensure_dir("shuggle-data");
    return "shuggle-data";
}

std::string sessions_dir() {
    std::string d = path_join(app_base_dir(), "sessions");
    ensure_dir(d);
    return d;
}
std::string downloads_dir() {
    std::string d = path_join(app_base_dir(), "downloads");
    ensure_dir(d);
    return d;
}
std::string memory_file_path() { return path_join(app_base_dir(), "memory.md"); }
std::string tokens_file_path() { return path_join(app_base_dir(), "tokens.json"); }
std::string settings_file_path() { return path_join(app_base_dir(), "settings.json"); }

} // namespace shuggle
