// Shuggle — search_pipeline.cpp
#include "search_pipeline.h"

#include <algorithm>
#include <nlohmann/json.hpp>

#include "http.h"
#include "system_prompt.h"
#include "util.h"

using nlohmann::json;

namespace shuggle {

bool SearchBackend::fetch(const std::vector<std::string>& queries, std::string& raw_json,
                          std::string& err) const {
    json req = {{"queries", queries}, {"max_results", max_results}};
    HttpOptions opts;
    opts.headers.push_back("X-Shuggle-Key: " + access_key);
    opts.timeout_seconds = timeout_seconds;
    std::string url = tunnel_url;
    while (!url.empty() && url.back() == '/') url.pop_back();
    HttpResponse r = Http::post_json(url + "/search", req.dump(), opts);
    if (!r.ok()) {
        err = "search HTTP " + std::to_string(r.status) + (r.error.empty() ? "" : " " + r.error);
        return false;
    }
    raw_json = std::move(r.body);
    return true;
}

std::vector<SearchResult> extract_results(const std::string& raw_json, std::string& err) {
    std::vector<SearchResult> out;
    std::vector<std::string> seen_urls;
    try {
        json j = json::parse(raw_json);
        const json& byq = j.contains("results") ? j["results"] : j;
        for (auto it = byq.begin(); it != byq.end(); ++it) {
            if (!it.value().is_object()) continue;
            const json& block = it.value();
            if (block.contains("error")) continue;
            for (const auto& rj : block.value("results", json::array())) {
                SearchResult r;
                r.title = rj.value("title", "");
                r.url = rj.value("url", "");
                r.snippet = rj.value("snippet", "");
                if (r.url.empty()) continue;
                // dedupe by URL (strip trailing slash + fragment)
                std::string key = r.url;
                key = replace_all(key, "#", "?");
                if (key.size() > 1 && key.back() == '/') key.pop_back();
                if (std::find(seen_urls.begin(), seen_urls.end(), key) != seen_urls.end())
                    continue;
                seen_urls.push_back(key);
                // drop obvious junk
                std::string u = to_lower(r.url);
                if (contains_ci(u, "cookie-policy") || contains_ci(u, "privacy-policy") ||
                    contains_ci(u, "/signup") || contains_ci(u, "/login"))
                    continue;
                out.push_back(std::move(r));
            }
        }
        return out;
    } catch (const std::exception& e) {
        err = e.what();
        return out;
    }
}

std::string render_web_context_block(const SearchOutcome& oc) {
    std::string block;
    block += "\n[web context — already retrieved for you via unfiltered search; may be incomplete]\n";
    if (!oc.digest.empty()) {
        block += oc.digest + "\n";
    } else if (!oc.results.empty()) {
        int used = 0;
        for (const auto& r : oc.results) {
            if (used > 12) break;
            block += "- " + r.title + " (" + r.url + "): " + r.snippet + "\n";
            used++;
        }
    } else {
        block += "(no usable results)\n";
    }
    block += "Search has already been performed. Use the facts above; never emit "
             "tool/function-call syntax in your reply.\n[/web context]\n";
    return block;
}

SearchOutcome run_search_pipeline(const LlmCall& llm, const SearchBackend& backend,
                                  const std::string& user_message, int max_queries,
                                  bool use_digest) {
    SearchOutcome oc;
    if (max_queries < 1) max_queries = 1;
    if (max_queries > 5) max_queries = 5;

    // strip thinking blocks from planner/digest outputs (Qwen3 style)
    auto strip_think = [](std::string s) {
        size_t a;
        while ((a = s.find("<think>")) != std::string::npos) {
            size_t b = s.find("</think>", a);
            if (b == std::string::npos) { s.erase(0, a); break; }
            s.erase(a, b + 8 - a);
        }
        return trim(s);
    };

    // [1] planner
    json msgs = json::array();
    msgs.push_back({{"role", "system"}, {"content", search_planner_prompt(max_queries)}});
    msgs.push_back({{"role", "user"}, {"content", user_message}});
    std::string err;
    std::string plan = strip_think(llm(msgs.dump(), 200, err));
    if (!err.empty()) {
        oc.error = "planner: " + err;
        return oc;
    }
    // parse queries JSON array
    try {
        size_t a = plan.find('[');
        size_t b = plan.rfind(']');
        if (a == std::string::npos || b == std::string::npos || b <= a)
            throw std::runtime_error("no array");
        json arr = json::parse(plan.substr(a, b - a + 1));
        for (const auto& q : arr)
            if (q.is_string() && !q.get<std::string>().empty())
                oc.queries.push_back(q.get<std::string>());
        if (oc.queries.size() > (size_t)max_queries) oc.queries.resize(max_queries);
    } catch (const std::exception&) {
        // fallback: search the user's message directly (still better than failing)
        oc.queries.push_back(user_message.substr(0, 120));
    }
    if (oc.queries.empty()) {
        oc.ok = true;  // planner says no search needed
        return oc;
    }

    // [2] notebook /search
    std::string raw;
    if (!backend.fetch(oc.queries, raw, err)) {
        oc.error = "search: " + err;
        return oc;
    }

    // [3] extraction
    oc.results = extract_results(raw, err);
    oc.total_sources = (int)oc.results.size();
    if (oc.results.empty()) {
        oc.ok = true;  // searched, nothing usable — final call proceeds without context
        oc.error = "no usable results";
        return oc;
    }

    // [4] digest (summarization layer)
    if (use_digest) {
        json dmsgs = json::array();
        dmsgs.push_back({{"role", "system"}, {"content", search_digest_prompt()}});
        std::string raw_text;
        int count = 0;
        for (const auto& r : oc.results) {
            if (count++ >= 10) break;
            raw_text += "## " + r.title + "\n" + r.url + "\n" + r.snippet + "\n\n";
        }
        dmsgs.push_back({{"role", "user"}, {"content", raw_text}});
        std::string digest = strip_think(llm(dmsgs.dump(), 700, err));
        if (err.empty() && !digest.empty()) {
            if (digest.find("NOTHING_USEFUL") == std::string::npos)
                oc.digest = trim(digest);
        }
        // digest failure is non-fatal: raw results still available
    }
    oc.ok = true;
    return oc;
}

} // namespace shuggle
