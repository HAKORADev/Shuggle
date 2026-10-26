// Shuggle — web_runtime.h
// Internal browser: WebView2 on Windows, WebKitGTK helper on Linux.
// One neutral entry point, platform backends behind it.
#pragma once
#include <string>

class QWidget;

namespace shuggle {

// Open url in the in-app browser. edge_data: Windows-only opt-in to reuse
// Edge's browser data folder. Falls back to the system browser if the
// platform runtime is unavailable.
bool open_internal_browser(const std::string& url, bool edge_data, QWidget* parent);

} // namespace shuggle
