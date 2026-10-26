// Shuggle — terminal_panel.h
// Bottom dock: run model code blocks in Terminal/cmd/PowerShell/bash/python.
// Live output, Clear, Ctrl+C, Close. Python button grays out when missing.
#pragma once
#include <QDockWidget>
#include <QProcess>
#include <QString>

class QLabel;
class QPlainTextEdit;
class QPushButton;

namespace shuggle {

class TerminalPanel : public QDockWidget {
    Q_OBJECT
public:
    explicit TerminalPanel(QWidget* parent = nullptr);

    void run(const QString& code, const QString& language);
    static bool python_available();

private slots:
    void on_output();
    void on_finished(int code, QProcess::ExitStatus st);
    void on_error(QProcess::ProcessError e);

private:
    QProcess* proc_ = nullptr;
    QPlainTextEdit* out_;
    QLabel* title_;
    QPushButton* stop_btn_;
    QString current_lang_;

    void setup_process(const QString& program, const QStringList& args);
};

} // namespace shuggle
