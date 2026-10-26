// Shuggle — notebook_template.h
// Generates the "Shuggle Engine" Kaggle kernel script from settings.
// The notebook: installs llama-cpp-python (prebuilt cu121 wheel, proven by HAKORA's
// draft), loads the model onto T4 x2, serves an OpenAI-compatible API with an
// access-key middleware, adds /search (unfiltered DDG) + /health + /heartbeat,
// opens a cloudflared quick tunnel, prints machine-parsable handshake lines, and
// self-stops on inactivity (3 min AFK / 6 min active) to save GPU hours.
#pragma once
#include <string>

#include "settings.h"

namespace shuggle {

struct EngineSettings {
    ModelSettings model;
    int idle_afk_seconds = 180;      // no heartbeats at all -> stop
    int idle_active_seconds = 360;   // heartbeats seen in window -> stop later
    std::string sync_dataset_slug;   // "" = no notebook-side sync
    std::string sync_owner;          // dataset owner (token account)
};

// Returns the full python script source for the kernel.
std::string generate_engine_script(const EngineSettings& es, const std::string& access_key);

} // namespace shuggle
