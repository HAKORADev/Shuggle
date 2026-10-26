// Shuggle — search_pipeline.h
// Fixed search pipeline (NOT an agent): planner call -> notebook /search ->
// app-side extraction -> digest call -> context injection. Separate tool prompts.
#pragma once
#include <functional>
#include <string>
#include <vector>

namespace shuggle {

struct SearchResult {
    std::string title, url, snippet;
};

struct SearchOutcome {
    bool ok = false;
    std::string error;
    std::vector<std::string> queries;
    std::vector<SearchResult> results;   // flattened, deduped
    std::string digest;                  // "" when digest disabled/failed
    int total_sources = 0;
};

// The notebook-side /search HTTP client (called through the engine's tunnel).
struct SearchBackend {
    std::string tunnel_url;   // e.g. https://xxx.trycloudflare.com
    std::string access_key;
    int max_results = 6;
    long timeout_seconds = 60;

    // POST {tunnel}/search {"queries":[...], "max_results":n}
    bool fetch(const std::vector<std::string>& queries, std::string& raw_json, std::string& err) const;
};

// Execute one full pipeline pass.
//   llm_call: generic single-shot model call fn(prompt_messages_json_array, max_tokens) -> text
//   (engine provides it so pipeline stays transport-agnostic)
using LlmCall =
    std::function<std::string(const std::string& /*messages_json*/, int /*max_tokens*/, std::string& /*err*/)>;

SearchOutcome run_search_pipeline(const LlmCall& llm, const SearchBackend& backend,
                                  const std::string& user_message, int max_queries,
                                  bool use_digest);

// Parse the /search response JSON into results (dedupe by URL, drop junk).
std::vector<SearchResult> extract_results(const std::string& raw_json, std::string& err);

// Render results/digest as a context block for the final chat call.
std::string render_web_context_block(const SearchOutcome& oc);

} // namespace shuggle
