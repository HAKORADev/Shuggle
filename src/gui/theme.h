// Shuggle — theme.h
// One clean dark black&white mode. Single violet accent from the logo.
#pragma once
#include <QString>

namespace shuggle {

QString app_stylesheet();
// colors shared between stylesheet and custom widgets
inline const char* COL_BG = "#0d0d0d";
inline const char* COL_PANEL = "#171717";
inline const char* COL_PANEL2 = "#1f1f1f";
inline const char* COL_COMPOSER = "#212121";
inline const char* COL_BORDER = "#2a2a2a";
inline const char* COL_TEXT = "#ececec";
inline const char* COL_TEXT_DIM = "#8a8a8a";
inline const char* COL_ACCENT = "#8b5cf6";   // Shuggle violet
inline const char* COL_ACCENT_DIM = "#6d3fc4";
inline const char* COL_DANGER = "#e23b3b";   // red: destructive / exhausted

} // namespace shuggle
