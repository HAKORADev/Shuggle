// Shuggle — settings.cpp
#include "settings.h"

#include <algorithm>
#include <nlohmann/json.hpp>

#include "util.h"

using nlohmann::json;

namespace shuggle {

void ModelSettings::clamp() {
    context_tokens = std::clamp(context_tokens, kContextMin, kContextMax);
    temperature = std::clamp(temperature, 0.0, 2.0);
    top_p = std::clamp(top_p, 0.05, 1.0);
    max_output_tokens = std::clamp(max_output_tokens, 256, 32768);
    n_batch = std::clamp(n_batch, 128, 4096);
}

void GlobalSettings::clamp() { model.clamp(); }

GlobalSettings GlobalSettings::load(const std::string& path) {
    GlobalSettings s;
    std::string data;
    if (!read_file(path, data) || data.empty()) return s;
    try {
        json j = json::parse(data);
        const auto& m = j.value("model", json::object());
        s.model.context_tokens = m.value("context_tokens", s.model.context_tokens);
        s.model.temperature = m.value("temperature", s.model.temperature);
        s.model.top_p = m.value("top_p", s.model.top_p);
        s.model.max_output_tokens = m.value("max_output_tokens", s.model.max_output_tokens);
        s.model.thinking_enabled = m.value("thinking_enabled", s.model.thinking_enabled);
        s.model.model_repo = m.value("model_repo", s.model.model_repo);
        s.model.model_file = m.value("model_file", s.model.model_file);
        s.model.n_gpu_layers = m.value("n_gpu_layers", s.model.n_gpu_layers);
        s.model.n_batch = m.value("n_batch", s.model.n_batch);

        s.user_name = j.value("user_name", "");
        s.user_gender = j.value("user_gender", "");
        s.user_sex = j.value("user_sex", "");
        s.user_age = j.value("user_age", 0);
        s.user_birthday = j.value("user_birthday", "");
        s.user_country = j.value("user_country", "");
        s.country_from_device = j.value("country_from_device", true);
        s.tz_offset_minutes = j.value("tz_offset_minutes", 0);
        s.tz_from_device = j.value("tz_from_device", true);
        s.social_status = j.value("social_status", "");
        s.role_description = j.value("role_description", "");
        s.response_style = j.value("response_style", "");
        s.about_you_note = j.value("about_you_note", "");
        s.use_fancy_prompt = j.value("use_fancy_prompt", true);
        s.raw_system_prompt = j.value("raw_system_prompt", "");
        s.memory_enabled_default = j.value("memory_enabled_default", true);
        s.memory_tools_enabled = j.value("memory_tools_enabled", false);
        s.search_enabled_default = j.value("search_enabled_default", false);
        s.search_max_queries = j.value("search_max_queries", 2);
        s.search_results_per_query = j.value("search_results_per_query", 6);
        s.search_digest = j.value("search_digest", true);
        s.open_links_inside_app = j.value("open_links_inside_app", false);
        s.edge_reuse_browser_data = j.value("edge_reuse_browser_data", false);
        s.model_renames_chats = j.value("model_renames_chats", false);
        s.kaggle_sync_enabled = j.value("kaggle_sync_enabled", true);
        s.sync_dataset_title = j.value("sync_dataset_title", s.sync_dataset_title);
    } catch (...) {
        // corrupted settings -> defaults
    }
    s.clamp();
    return s;
}

bool GlobalSettings::save(const std::string& path) const {
    json j = {
        {"model",
         {{"context_tokens", model.context_tokens},
          {"temperature", model.temperature},
          {"top_p", model.top_p},
          {"max_output_tokens", model.max_output_tokens},
          {"thinking_enabled", model.thinking_enabled},
          {"model_repo", model.model_repo},
          {"model_file", model.model_file},
          {"n_gpu_layers", model.n_gpu_layers},
          {"n_batch", model.n_batch}}},
        {"user_name", user_name},
        {"user_gender", user_gender},
        {"user_sex", user_sex},
        {"user_age", user_age},
        {"user_birthday", user_birthday},
        {"user_country", user_country},
        {"country_from_device", country_from_device},
        {"tz_offset_minutes", tz_offset_minutes},
        {"tz_from_device", tz_from_device},
        {"social_status", social_status},
        {"role_description", role_description},
        {"response_style", response_style},
        {"about_you_note", about_you_note},
        {"use_fancy_prompt", use_fancy_prompt},
        {"raw_system_prompt", raw_system_prompt},
        {"memory_enabled_default", memory_enabled_default},
        {"memory_tools_enabled", memory_tools_enabled},
        {"search_enabled_default", search_enabled_default},
        {"search_max_queries", search_max_queries},
        {"search_results_per_query", search_results_per_query},
        {"search_digest", search_digest},
        {"open_links_inside_app", open_links_inside_app},
        {"edge_reuse_browser_data", edge_reuse_browser_data},
        {"model_renames_chats", model_renames_chats},
        {"kaggle_sync_enabled", kaggle_sync_enabled},
        {"sync_dataset_title", sync_dataset_title}};
    return write_file(path, j.dump(2));
}

ModelSettings SessionSettings::effective_model(const ModelSettings& global) const {
    ModelSettings m = model.value_or(global);
    m.clamp();
    return m;
}

bool SessionSettings::effective_memory(bool global_default) const {
    return memory_enabled_v.value_or(global_default);
}
bool SessionSettings::effective_memory_tools(bool global_default) const {
    return memory_tools_enabled_v.value_or(global_default);
}
bool SessionSettings::effective_search(bool global_default) const {
    return search_enabled_v.value_or(global_default);
}

} // namespace shuggle
