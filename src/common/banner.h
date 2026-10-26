// Shuggle — banner.h
// The cool banner, HAKORA-style. Colors when the terminal supports them.
#pragma once
#include <string>

namespace shuggle {

// banner in plain or colored form
std::string banner(bool color = true);
std::string tagline_line();

} // namespace shuggle
