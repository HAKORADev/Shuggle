// Shuggle — main_window.h
#pragma once
#include <QLabel>
#include <QLineEdit>
#include <QMainWindow>
#include <QPointer>
#include <QThread>
#include <atomic>
#include <memory>
#include <optional>
#include <thread>

#include "../core/chat_store.h"
#include "../core/engine.h"
#include "../core/memory_handler.h"
#include "../core/settings.h"
#include "../core/token_manager.h"
#include "chat_view.h"
#include "sidebar.h"

class QCheckBox;
class QPlainTextEdit;
class QPushButton;

namespace shuggle {

class TerminalPanel;

class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    MainWindow();
    ~MainWindow() override;

protected:
    void closeEvent(QCloseEvent* e) override;
    bool eventFilter(QObject* obj, QEvent* ev) override;

private slots:
    void on_new_chat();
    void on_select_session(const QString& id);
    void on_delete_session(const QString& id);
    void on_pin_session(const QString& id);
    void on_dual_session(const QString& id);
    void on_search(const QString& q, qint64 from, qint64 to);
    void on_search_hit(const QString& session_id, const QString& message_id);
    void on_send();
    void on_regenerate();
    void on_branch_out(const QString& message_id);
    void on_switch_branch(const QString& message_id, int child_index);
    void on_run_code(const QString& code, const QString& language);
    void on_link(const QUrl& url);
    void on_settings();
    void on_tokens();
    void on_session_settings();
    void refresh_sidebar();
    void heartbeat_ui();

private:
    void build_ui();
    void first_run_wizard();
    void open_session(const QString& id);
    void start_generation(Session s, const std::string& text,
                          std::vector<Attachment> attachments, bool to_dual);
    void finish_generation(bool ok, const QString& err, bool dual);
    void set_busy(bool busy);
    std::string resolve_open_link(const QUrl& url);

    GlobalSettings settings_;
    TokenManager tokens_;
    ChatStore store_;
    MemoryHandler memory_;
    Engine engine_;

    Sidebar* sidebar_ = nullptr;
    ChatView* chat_ = nullptr;
    ChatView* chat2_ = nullptr;
    QWidget* chat2_wrap_ = nullptr;
    QPlainTextEdit* composer_ = nullptr;
    QCheckBox* search_toggle_ = nullptr;
    QLabel* status_ = nullptr;
    QLabel* title_ = nullptr;
    QPushButton* per_session_btn_ = nullptr;
    QPushButton* think_btn_ = nullptr;
    TerminalPanel* terminal_ = nullptr;

    std::optional<Session> current_;
    std::optional<Session> dual_session_;
    std::atomic<bool> busy_{false};
    std::thread worker_;
    std::vector<Attachment> pending_attachments_;
};

} // namespace shuggle
