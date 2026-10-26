// Shuggle — terminal_panel.cpp
#include "terminal_panel.h"

#include <QFile>
#include <QFileInfo>
#include <QHBoxLayout>
#include <QLabel>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QScrollBar>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QVBoxLayout>

#include "theme.h"

namespace shuggle {

TerminalPanel::TerminalPanel(QWidget* parent) : QDockWidget(QStringLiteral("Runtime"), parent) {
    setAllowedAreas(Qt::BottomDockWidgetArea | Qt::TopDockWidgetArea);
    auto* wrap = new QWidget();
    auto* lay = new QVBoxLayout(wrap);
    lay->setContentsMargins(8, 6, 8, 8);
    lay->setSpacing(6);

    auto* bar = new QHBoxLayout();
    title_ = new QLabel(QStringLiteral("idle"));
    title_->setObjectName("ChipLabel");
    bar->addWidget(title_);
    bar->addStretch();
    stop_btn_ = new QPushButton(QStringLiteral("Ctrl+C"));
    stop_btn_->setEnabled(false);
    auto* clear_btn = new QPushButton(QStringLiteral("Clear"));
    auto* close_btn = new QPushButton(QStringLiteral("Close"));
    close_btn->setObjectName("GhostButton");
    connect(stop_btn_, &QPushButton::clicked, this, [this] {
        if (proc_) {
#ifdef _WIN32
            proc_->kill();
#else
            proc_->terminate();  // SIGTERM; interactive children get cleaned by kernel
            if (!proc_->waitForFinished(800)) proc_->kill();
#endif
        }
    });
    connect(clear_btn, &QPushButton::clicked, this, [this] { out_->clear(); });
    connect(close_btn, &QPushButton::clicked, this, [this] { hide(); });
    bar->addWidget(stop_btn_);
    bar->addWidget(clear_btn);
    bar->addWidget(close_btn);
    lay->addLayout(bar);

    out_ = new QPlainTextEdit();
    out_->setObjectName("TerminalOutput");
    out_->setReadOnly(true);
    out_->setMaximumBlockCount(4000);
    lay->addWidget(out_);
    setWidget(wrap);
    hide();
}

bool TerminalPanel::python_available() {
#ifdef _WIN32
    return QStandardPaths::findExecutable(QStringLiteral("python")) != QString() ||
           QStandardPaths::findExecutable(QStringLiteral("py")) != QString();
#else
    return QStandardPaths::findExecutable(QStringLiteral("python3")) != QString() ||
           QStandardPaths::findExecutable(QStringLiteral("python")) != QString();
#endif
}

void TerminalPanel::setup_process(const QString& program, const QStringList& args) {
    proc_ = new QProcess(this);
    proc_->setProcessChannelMode(QProcess::MergedChannels);
    connect(proc_, &QProcess::readyReadStandardOutput, this, &TerminalPanel::on_output);
    connect(proc_, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), this,
            &TerminalPanel::on_finished);
    connect(proc_, &QProcess::errorOccurred, this, &TerminalPanel::on_error);
    title_->setText(QStringLiteral("running: %1").arg(program));
    stop_btn_->setEnabled(true);
    proc_->start(program, args);
}

void TerminalPanel::run(const QString& code, const QString& language) {
    if (proc_ && proc_->state() != QProcess::NotRunning) {
        out_->appendPlainText(QStringLiteral("[shuggle] another process is running — Ctrl+C first"));
        show();
        raise();
        return;
    }
    QString lang = language.toLower().trimmed();
    if (lang == QStringLiteral("python") || lang == QStringLiteral("py")) {
#ifdef _WIN32
        QString py = QStandardPaths::findExecutable(QStringLiteral("py"));
        if (py.isEmpty()) py = QStandardPaths::findExecutable(QStringLiteral("python"));
        setup_process(py, {QStringLiteral("-u"), QStringLiteral("-c"), code});
#else
        QString py = QStandardPaths::findExecutable(QStringLiteral("python3"));
        if (py.isEmpty()) py = QStandardPaths::findExecutable(QStringLiteral("python"));
        if (py.isEmpty()) {
            out_->appendPlainText(QStringLiteral("[shuggle] python not found on this machine"));
            return;
        }
        setup_process(py, {QStringLiteral("-u"), QStringLiteral("-c"), code});
#endif
    } else if (lang == QStringLiteral("powershell") || lang == QStringLiteral("pwsh")) {
#ifdef _WIN32
        setup_process(QStringLiteral("powershell"), {QStringLiteral("-NoProfile"),
                                                     QStringLiteral("-Command"), code});
#else
        QString pw = QStandardPaths::findExecutable(QStringLiteral("pwsh"));
        if (pw.isEmpty()) pw = QStandardPaths::findExecutable(QStringLiteral("powershell"));
        if (pw.isEmpty()) {
            out_->appendPlainText(QStringLiteral("[shuggle] powershell not found on this machine"));
            return;
        }
        setup_process(pw, {QStringLiteral("-NoProfile"), QStringLiteral("-Command"), code});
#endif
    } else if (lang == QStringLiteral("cmd") || lang == QStringLiteral("batch") ||
               lang == QStringLiteral("bat")) {
#ifdef _WIN32
        setup_process(QStringLiteral("cmd"), {QStringLiteral("/Q"), QStringLiteral("/K"), code});
#else
        out_->appendPlainText(QStringLiteral("[shuggle] cmd is Windows-only — try bash"));
        show();
        raise();
        return;
#endif
    } else {
        // default: bash/sh on Linux & macOS, PowerShell-ish fallback on Windows
#ifdef _WIN32
        setup_process(QStringLiteral("cmd"), {QStringLiteral("/Q"), QStringLiteral("/K"), code});
#else
        QString sh = QStandardPaths::findExecutable(QStringLiteral("bash"));
        if (sh.isEmpty()) sh = QStandardPaths::findExecutable(QStringLiteral("sh"));
        setup_process(sh, {QStringLiteral("-c"), code});
#endif
    }
    show();
    raise();
}

void TerminalPanel::on_output() {
    if (!proc_) return;
    out_->insertPlainText(QString::fromUtf8(proc_->readAllStandardOutput()));
    auto* bar = out_->verticalScrollBar();
    bar->setValue(bar->maximum());
}

void TerminalPanel::on_finished(int code, QProcess::ExitStatus st) {
    stop_btn_->setEnabled(false);
    title_->setText(st == QProcess::CrashExit
                        ? QStringLiteral("stopped (exit %1)").arg(code)
                        : QStringLiteral("finished (exit %1)").arg(code));
    proc_->deleteLater();
    proc_ = nullptr;
}

void TerminalPanel::on_error(QProcess::ProcessError e) {
    out_->appendPlainText(QStringLiteral("[shuggle] process error: %1").arg((int)e));
}

} // namespace shuggle
