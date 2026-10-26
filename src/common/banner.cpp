// Shuggle — banner.cpp
#include "banner.h"

#include "version.h"

namespace shuggle {

std::string banner(bool color) {
    const std::string c_r = color ? "\033[31m" : "";    // red
    const std::string c_b = color ? "\033[38;5;94m" : "";  // glittery brown
    const std::string c_v = color ? "\033[38;5;99m" : "";  // violet
    const std::string c_0 = color ? "\033[0m" : "";
    const std::string c_dim = color ? "\033[2m" : "";

    // the nabla, rendered in the logo's three colors
    std::string out;
    out += c_r;
    out += "  ▲▲  \033[0m" ;
    out = std::string();  // rebuild cleanly below (portable spacing)

    out += "\n";
    out += c_r  + "   ██████████" + c_0 + c_b + "████████" + c_0 + c_v + "████████\n";
    out += c_r  + "  ████████████" + c_0 + c_b + "██████" + c_0 + c_v + "██████████\n";
    out += c_r  + " ██████████" + c_b + "██████" + c_0 + c_v + "  ████████████\n";
    out += c_r  + "██████████" + c_b + "████" + c_0 + c_v + "      ████████████\n";
    out += c_r  + "█████████" + c_b + "██" + c_0 + c_v + "          ███████████\n";
    out += c_v  + "████████              █████████\n";
    out += c_v  + " ██████              ████████\n";
    out += c_v  + "  ████              ██████\n";
    out += c_v  + "   ██              ████\n";
    out += c_0;
    out += c_dim + "   ∇ " + kAppName + " v" + kAppVersion + " — " + kAppTagline + "\n" + c_0;
    return out;
}

std::string tagline_line() {
    return std::string(kAppName) + " v" + kAppVersion + " — " + kAppTagline;
}

} // namespace shuggle
