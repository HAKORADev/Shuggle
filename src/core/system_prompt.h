// Shuggle — system_prompt.h
// Dynamic system prompt builder: fancy (structured identity) or raw.
// Time is injected per-request at minute granularity from the USER's machine.
#pragma once
#include <string>

#include "settings.h"

namespace shuggle {

struct PromptIdentityInputs {
    std::string name;
    std::string gender;
    std::string sex;
    int age = 0;
    std::string birthday;
    std::string country;         // resolved (device or manual)
    int tz_offset_minutes = 0;   // resolved (device or manual)
    std::string social_status;
};

// Build the final system prompt for a request.
//   global: settings (fancy or raw + role/style/about)
//   ident: resolved identity fields
//   memory_text: memory block content ("" if disabled/empty)
//   now_epoch: current time on the user's machine (per minute)
//   override_text: per-session full override (used when session has override)
std::string build_system_prompt(const GlobalSettings& global, const PromptIdentityInputs& ident,
                                const std::string& memory_text, int64_t now_epoch,
                                const std::string& override_text);

// the memory tool prompt (NEVER mixed into the system prompt) — used only when
// memory tools are enabled for the session
std::string memory_tool_prompt(int64_t now_epoch);

// the search tool prompts (planner + digest) — separate from system prompt
std::string search_planner_prompt(int max_queries);
std::string search_digest_prompt();

// fill identity from device defaults (country/tz detection is platform-side;
// on Linux read /etc/timezone + TZ offset; on Windows GetTimeZoneInformation)
PromptIdentityInputs identity_from_device(const GlobalSettings& g);

} // namespace shuggle
