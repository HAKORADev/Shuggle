// Shuggle — sidebar.h
// Left panel: brand, new chat, search, pinned/history (collapsible), search
// results view, tokens + settings buttons, pool usage meter.
#pragma once
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QVBoxLayout>
#include <QWidget>

#include "../core/chat_store.h"
#include "../core/token_manager.h"

class QListWidget;

namespace shuggle {

class Sidebar : public QWidget {
    Q_OBJECT
public:
    explicit Sidebar(QWidget* parent = nullptr);

    void refresh_sessions(const std::vector<Session>& sessions, const QString& current_id);
    void set_pool_meter(const TokenManager::PoolMeter& meter);
    void set_search_mode(bool on);

signals:
    void new_chat();
    void session_selected(const QString& session_id);
    void session_delete_requested(const QString& session_id);
    void session_pin_toggled(const QString& session_id);
    void session_dual_requested(const QString& session_id);
    void search_query(const QString& query, qint64 from_epoch, qint64 to_epoch);
    void search_hit_selected(const QString& session_id, const QString& message_id);
    void search_cleared();
    void tokens_clicked();
    void settings_clicked();

private slots:
    void on_search_changed();
    void on_context_menu(const QPoint& pos);

private:
    void rebuild_lists(const std::vector<Session>& sessions, const QString& current_id);

    QVBoxLayout* root_;
    QLineEdit* search_;
    QListWidget* pinned_list_;
    QListWidget* history_list_;
    QListWidget* results_list_;
    QWidget* pinned_head_;
    QWidget* history_head_;
    QWidget* lists_wrap_;
    QWidget* results_wrap_;
    QLabel* pool_label_;
    std::vector<Session> sessions_;
    bool pinned_open_ = true;
    bool history_open_ = true;
    bool search_mode_ = false;
};

} // namespace shuggle
