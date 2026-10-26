// Shuggle — settings.h
// Global + per-session settings with ranges enforced (ctx 32768..75000 etc).
#pragma once
#include <map>
#include <optional>
#include <string>

namespace shuggle {

// Limits per HAKORA spec (do not loosen):
inline constexpr int kContextMin = 32768;
inline constexpr int kContextMax = 75000;   // hard ceiling; GPUs can't take more
inline constexpr int kSystemPromptMaxChars = 10000;
inline constexpr int kMemoryMaxChars = 10000;
inline constexpr int kMaxTokens100 = 100;
inline constexpr double kDefaultTemperature = 0.7;
inline constexpr double kDefaultTopP = 0.95;

struct ModelSettings {
    int context_tokens = 65536;       // clamped [kContextMin, kContextMax]
    double temperature = kDefaultTemperature;
    double top_p = kDefaultTopP;
    int max_output_tokens = 8192;     // bounded by remaining ctx at request time
    bool thinking_enabled = true;     // toggle thinking on/off if model supports it
    // engine knobs
    std::string model_repo = "JonathanColetti/Qwen3.8-27B-Uncensored-GGUF";
    std::string model_file = "Qwen3.8-27B-Uncensored-Q4_K_M.gguf";
    int n_gpu_layers = -1;
    int n_batch = 512;

    void clamp();
};

// Global (app-wide) settings.
struct GlobalSettings {
    ModelSettings model;
    // identity for the dynamic system prompt
    std::string user_name;
    std::string user_gender;         // top-10 list or custom
    std::string user_sex;
    int user_age = 0;                // 0 = unset
    std::string user_birthday;       // YYYY-MM-DD or empty
    std::string user_country;        // auto from device or manual
    bool country_from_device = true;
    int tz_offset_minutes = 0;       // from device unless manual
    bool tz_from_device = true;
    std::string social_status;       // single/married/... or custom
    // prompt composition
    std::string role_description;    // "model role" (fancy mode)
    std::string response_style;      // "how the model should respond" (fancy mode)
    std::string about_you_note;      // extra "about you" block (fancy mode)
    bool use_fancy_prompt = true;    // false = raw system prompt text only
    std::string raw_system_prompt;   // used when use_fancy_prompt == false
    // behavior
    bool memory_enabled_default = true;
    bool memory_tools_enabled = false;   // optional memory tool mode (OFF default)
    bool search_enabled_default = false;
    int search_max_queries = 2;          // 1..5
    int search_results_per_query = 6;    // 3..8
    bool search_digest = true;           // summarization layer on/off
    bool open_links_inside_app = false;  // internal browser vs system browser
    bool edge_reuse_browser_data = false;// windows: reuse Edge profile in WebView2
    bool model_renames_chats = false;    // future; v0.5 uses local heuristic naming
    // sync
    bool kaggle_sync_enabled = true;
    std::string sync_dataset_title = "Shuggle Sync Store";

    void clamp();

    // persistence
    static GlobalSettings load(const std::string& path);
    bool save(const std::string& path) const;
};

// Per-session overlay: empty value = inherit global.
struct SessionSettings {
    std::optional<ModelSettings> model;
    std::string system_prompt_override;   // full fancy/raw override text
    bool has_prompt_override = false;
    bool memory_enabled;                  // tri-state via optional
    std::optional<bool> memory_enabled_v;
    std::optional<bool> memory_tools_enabled_v;
    std::optional<bool> search_enabled_v;
    std::optional<std::string> memory_override_text;  // per-session memory edit
    std::optional<std::string> token_override;        // pin a specific KGAT token

    // resolve against global
    ModelSettings effective_model(const ModelSettings& global) const;
    bool effective_memory(bool global_default) const;
    bool effective_memory_tools(bool global_default) const;
    bool effective_search(bool global_default) const;
};

} // namespace shuggle
