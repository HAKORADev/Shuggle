// Shuggle — chat_view.h
// Message widgets + the scrolling chat area. Markdown with RTL support,
// collapsible thinking, action buttons, branch switchers, live streaming.
#pragma once
#include <QFrame>
#include <QPointer>
#include <QPushButton>
#include <QScrollArea>
#include <QTextBrowser>
#include <QTimer>
#include <QVBoxLayout>
#include <QWidget>

#include "../core/chat_store.h"

namespace shuggle {

class MessageWidget : public QFrame {
    Q_OBJECT
public:
    MessageWidget(const Message& msg, bool is_last_assistant, QWidget* parent = nullptr);

    // streaming updates for the transient "generating" widget
    void stream_append_content(const QString& piece);
    void stream_append_thinking(const QString& piece);
    void stream_finish(int elapsed_ms);

signals:
    void copy_message(const QString& text);
    void regenerate_requested();
    void branch_out_requested(const QString& message_id);
    void switch_branch(const QString& message_id, int child_index);
    void link_activated(const QUrl& url);
    void run_code(const QString& code, const QString& language);

private slots:
    void toggle_thinking();

private:
    void build_ui(const Message& msg, bool is_last_assistant);
    QString render_markdown_html(const QString& md) const;
    static QString escape_html(const QString& s);

    QString message_id_;
    QString content_;
    QString thinking_;
    QVBoxLayout* lay_ = nullptr;
    QTextBrowser* content_view_ = nullptr;
    QWidget* thinking_wrap_ = nullptr;
    QTextBrowser* thinking_view_ = nullptr;
    QPushButton* thinking_btn_ = nullptr;
    bool thinking_visible_ = false;
};

class ChatView : public QWidget {
    Q_OBJECT
public:
    explicit ChatView(QWidget* parent = nullptr);

    void show_session(const Session& s);
    void show_empty(const QString& hint);
    void begin_transient();                       // "generating..." widget
    QWidget* transient_widget();
    void end_transient();
    void scroll_to_bottom();
    void set_link_opener(std::function<void(const QUrl&)> opener) { link_opener_ = opener; }

    // session context for actions
    QString session_id() const { return session_id_; }

signals:
    void regenerate_requested();
    void branch_out_requested(const QString& message_id);
    void switch_branch(const QString& message_id, int child_index);
    void run_code(const QString& code, const QString& language);

private slots:
    void on_link(const QUrl& url);

private:
    MessageWidget* make_message_widget(const Message& m, bool is_last_assistant);
    QScrollArea* scroll_ = nullptr;
    QWidget* feed_ = nullptr;
    QVBoxLayout* feed_lay_ = nullptr;
    QPointer<MessageWidget> transient_;
    QString session_id_;
    std::function<void(const QUrl&)> link_opener_;
};

} // namespace shuggle
