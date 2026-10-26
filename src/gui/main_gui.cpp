// Shuggle — main_gui.cpp
// GUI entry: dark B&W app, logo icon, main window.
#include <QApplication>
#include <QIcon>
#include <QStyleFactory>

#include "main_window.h"
#include "theme.h"
#include "../common/version.h"

int main(int argc, char* argv[]) {
    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("Shuggle"));
    QApplication::setApplicationVersion(QString::fromLatin1(shuggle::kAppVersion));
    QApplication::setOrganizationName(QStringLiteral("HAKORA"));
    QApplication::setWindowIcon(QIcon(QStringLiteral(":/icons/shuggle_256.png")));
    QApplication::setStyle(QStyleFactory::create(QStringLiteral("Fusion")));
    app.setStyleSheet(shuggle::app_stylesheet());
    shuggle::MainWindow w;
    w.show();
    return app.exec();
}
