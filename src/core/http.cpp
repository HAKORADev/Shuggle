// Shuggle — http.cpp
#include "http.h"

#include <curl/curl.h>

#include <atomic>
#include <cstring>
#include <mutex>

#include "util.h"

namespace shuggle {

static std::once_flag g_curl_init;

bool Http::init() {
    std::call_once(g_curl_init, []() { curl_global_init(CURL_GLOBAL_DEFAULT); });
    return true;
}
void Http::shutdown_() { /* curl_global_cleanup left to process exit */ }

static size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* s = static_cast<std::string*>(userdata);
    s->append(ptr, size * nmemb);
    return size * nmemb;
}

static size_t header_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* m = static_cast<std::map<std::string, std::string>*>(userdata);
    std::string line(ptr, size * nmemb);
    auto pos = line.find(':');
    if (pos != std::string::npos) {
        std::string key = line.substr(0, pos);
        std::string val = line.substr(pos + 1);
        // trim
        while (!val.empty() && (val.front() == ' ' || val.front() == '\r' || val.front() == '\n'))
            val.erase(val.begin());
        while (!val.empty() && (val.back() == ' ' || val.back() == '\r' || val.back() == '\n'))
            val.pop_back();
        for (auto& c : key) if (c >= 'A' && c <= 'Z') c += 32;
        (*m)[key] = val;
    }
    return size * nmemb;
}

static size_t file_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* f = static_cast<FILE*>(userdata);
    return fwrite(ptr, size, nmemb, f) == 0 && size * nmemb > 0 ? 0 : size * nmemb;
}

static bool setup_common(CURL* curl, const std::string& url, const HttpOptions& opts) {
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, opts.connect_timeout_seconds);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, opts.timeout_seconds);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, opts.follow_redirects ? 1L : 0L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_ACCEPT_ENCODING, ""); // gzip/deflate/br auto
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "Shuggle/0.5.0");
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    struct curl_slist* hl = nullptr;
    for (const auto& h : opts.headers) hl = curl_slist_append(hl, h.c_str());
    if (hl) {
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hl);
        // store for cleanup via private pointer trick
        curl_easy_setopt(curl, CURLOPT_PRIVATE, hl);
    }
    return true;
}

static void cleanup_slist(CURL* curl) {
    struct curl_slist* hl = nullptr;
    curl_easy_getinfo(curl, CURLINFO_PRIVATE, &hl);
    if (hl) curl_slist_free_all(hl);
}

HttpResponse Http::get(const std::string& url, const HttpOptions& opts) {
    init();
    HttpResponse resp;
    CURL* curl = curl_easy_init();
    if (!curl) { resp.error = "curl init failed"; return resp; }
    setup_common(curl, url, opts);
    curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_cb);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp.headers);
    CURLcode rc = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);
    cleanup_slist(curl);
    if (rc != CURLE_OK) resp.error = curl_easy_strerror(rc);
    curl_easy_cleanup(curl);
    return resp;
}

HttpResponse Http::post_json(const std::string& url, const std::string& json_body,
                             const HttpOptions& opts) {
    init();
    HttpResponse resp;
    CURL* curl = curl_easy_init();
    if (!curl) { resp.error = "curl init failed"; return resp; }
    HttpOptions o = opts;
    bool has_ct = false;
    for (auto& h : o.headers)
        if (starts_with(to_lower(h), "content-type:")) has_ct = true;
    if (!has_ct) o.headers.push_back("Content-Type: application/json");
    setup_common(curl, url, o);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json_body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)json_body.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_cb);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &resp.headers);
    CURLcode rc = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);
    cleanup_slist(curl);
    if (rc != CURLE_OK) resp.error = curl_easy_strerror(rc);
    curl_easy_cleanup(curl);
    return resp;
}

HttpResponse Http::put(const std::string& url, const std::string& data,
                       const HttpOptions& opts) {
    init();
    HttpResponse resp;
    CURL* curl = curl_easy_init();
    if (!curl) { resp.error = "curl init failed"; return resp; }
    setup_common(curl, url, opts);
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, data.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)data.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    CURLcode rc = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);
    cleanup_slist(curl);
    if (rc != CURLE_OK) resp.error = curl_easy_strerror(rc);
    curl_easy_cleanup(curl);
    return resp;
}

HttpResponse Http::download(const std::string& url, const std::string& to_path,
                            const HttpOptions& opts) {
    init();
    HttpResponse resp;
    FILE* f = std::fopen(to_path.c_str(), "wb");
    if (!f) { resp.error = "cannot open file: " + to_path; return resp; }
    CURL* curl = curl_easy_init();
    if (!curl) { std::fclose(f); resp.error = "curl init failed"; return resp; }
    setup_common(curl, url, opts);
    curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, file_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, f);
    CURLcode rc = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);
    cleanup_slist(curl);
    if (rc != CURLE_OK) resp.error = curl_easy_strerror(rc);
    curl_easy_cleanup(curl);
    std::fclose(f);
    return resp;
}

long Http::stream_lines(const std::string& url, const std::string& body,
                        const HttpOptions& opts,
                        const std::function<void(const std::string& line)>& on_line,
                        const std::function<bool()>& keep_going) {
    init();
    struct Ctx {
        std::string buf;
        const std::function<void(const std::string&)>* on_line;
        const std::function<bool()>* keep_going;
        bool abort = false;
    } ctx{ "", &on_line, &keep_going, false };

    CURL* curl = curl_easy_init();
    if (!curl) return 0;
    HttpOptions o = opts;
    o.timeout_seconds = 0; // no total timeout for streams
    bool has_ct = false;
    for (auto& h : o.headers)
        if (starts_with(to_lower(h), "content-type:")) has_ct = true;
    if (!has_ct) o.headers.push_back("Content-Type: application/json");
    setup_common(curl, url, o);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION,
                     +[](char* ptr, size_t size, size_t nmemb, void* userdata) -> size_t {
                         auto* c = static_cast<Ctx*>(userdata);
                         c->buf.append(ptr, size * nmemb);
                         size_t pos;
                         while ((pos = c->buf.find('\n')) != std::string::npos) {
                             std::string line = c->buf.substr(0, pos);
                             c->buf.erase(0, pos + 1);
                             if (!line.empty() && line.back() == '\r') line.pop_back();
                             (*c->on_line)(line);
                         }
                         if (c->keep_going && !(*c->keep_going)()) return 0; // abort
                         return size * nmemb;
                     });
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &ctx);
    CURLcode rc = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    cleanup_slist(curl);
    curl_easy_cleanup(curl);
    if (rc != CURLE_OK && rc != CURLE_WRITE_ERROR) return 0; // WRITE_ERROR = clean abort
    return status;
}

} // namespace shuggle
