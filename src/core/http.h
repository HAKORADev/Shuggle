// Shuggle — http.h
// libcurl-backed HTTP: JSON RPC helper + SSE streaming. Core dependency.
#pragma once
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace shuggle {

struct HttpResponse {
    long status = 0;
    std::string body;
    std::string error;             // transport error (empty = none)
    std::map<std::string, std::string> headers;
    bool ok() const { return status >= 200 && status < 300 && error.empty(); }
};

struct HttpOptions {
    std::vector<std::string> headers;          // raw header lines ("Key: value")
    long timeout_seconds = 60;                 // total for non-streaming
    long connect_timeout_seconds = 20;
    bool follow_redirects = true;
};

class Http {
public:
    static bool init();      // global curl init (idempotent)
    static void shutdown_();

    static HttpResponse get(const std::string& url, const HttpOptions& opts = {});
    static HttpResponse post_json(const std::string& url, const std::string& json_body,
                                  const HttpOptions& opts = {});
    static HttpResponse put(const std::string& url, const std::string& data,
                            const HttpOptions& opts = {});
    static HttpResponse download(const std::string& url, const std::string& to_path,
                                 const HttpOptions& opts = {});

    // Streaming SSE / chunked consumption (for OpenAI-compatible stream=true).
    // on_line is called for each line (without trailing newline) as it arrives.
    // Returns last response status; 0 on transport failure. stop flag can abort.
    static long stream_lines(const std::string& url, const std::string& body,
                             const HttpOptions& opts,
                             const std::function<void(const std::string& line)>& on_line,
                             const std::function<bool()>& keep_going);
};

} // namespace shuggle
