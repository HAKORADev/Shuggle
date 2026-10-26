// Shuggle — web_runtime_linux.cpp
// Linux backend: launch the WebKitGTK helper (shuggle-web) if present;
// otherwise fall back to the system browser. Per HAKORA: "pick all possible
// ones and link them in the linux source" — the helper is built when
// libwebkit2gtk is available at build time.
#include <QDesktopServices>
#include <QDir>
#include <QUrl>

#include <QCoreApplication>
#include <QProcess>

#include "web_runtime.h"
#include "../core/util.h"

#ifdef SHUGGLE_WEB_HELPER
#define STR2(x) #x
#define STR(x) STR2(x)
#endif

namespace shuggle {

bool open_internal_browser(const std::string& url, bool edge_data, QWidget* parent) {
    (void)edge_data;  // Edge-specific option does not apply on Linux
    (void)parent;
#ifdef SHUGGLE_WEB_HELPER
    QString helper =
        QDir(QCoreApplication::applicationDirPath()).filePath(QStringLiteral(STR(SHUGGLE_WEB_HELPER)));
    if (QFile::exists(helper)) {
        return QProcess::startDetached(helper, {QString::fromStdString(url)});
    }
#endif
    // fallback: system browser (x-www-browser / xdg-open honored by Qt)
    return QDesktopServices::openUrl(QUrl(QString::fromStdString(url)));
}

}  // namespace shuggle
