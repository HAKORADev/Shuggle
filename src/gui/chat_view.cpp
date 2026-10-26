// Shuggle — chat_view.cpp
#include "chat_view.h"

#include <QApplication>
#include <QClipboard>
#include <QDateTime>
#include <QDesktopServices>
#include <QFontMetrics>
#include <QHBoxLayout>
#include <QLabel>
#include <QMenu>
#include <QRegularExpression>
#include <QPushButton>
#include <QScrollBar>
#include <QScroller>
#include <QTextBlock>
#include <QTextCursor>
#include <QToolButton>
#include <QVBoxLayout>

#include "theme.h"
#include "../core/util.h"

namespace shuggle {

// ── helpers ──────────────────────────────────────────────────────────────────

static QString md_to_html(const QString& md, bool rtl) {
    // Qt6: QTextDocument::setMarkdown is the cleanest path; we convert via a
    // throwaway document and return html so we can control direction + styling.
    QTextDocument doc;
    doc.setDefaultFont(QFont(QStringLiteral("Segoe UI"), 10));
    doc.setMarkdown(md, QTextDocument::MarkdownDialectGitHub);
    QString html = doc.toHtml();
    // inject base styling + direction
    QString dir = rtl ? QStringLiteral("rtl") : QStringLiteral("ltr");
    html.replace(QStringLiteral("<p style="),
                 QStringLiteral("<p dir=\"%1\" style=\"line-height:150%;\" ").arg(dir));
    return html;
}

static bool looks_rtl(const QString& s) {
    int arabic = 0, letters = 0;
    for (const QChar& c : s) {
        if (c.isLetter()) {
            letters++;
            ushort u = c.unicode();
            if ((u >= 0x0600 && u <= 0x06FF) || (u >= 0xFB50 && u <= 0xFEFF)) arabic++;
        }
    }
    return letters > 0 && arabic * 100 / letters > 40;
}

QString MessageWidget::escape_html(const QString& s) {
    QString r = s;
    r.replace(QLatin1Char('&'), QStringLiteral("&amp;"));
    r.replace(QLatin1Char('<'), QStringLiteral("&lt;"));
    r.replace(QLatin1Char('>'), QStringLiteral("&gt;"));
    return r;
}

// ── MessageWidget ─────────────────────────────────────────────────────────────

MessageWidget::MessageWidget(const Message& msg, bool is_last_assistant, QWidget* parent)
    : QFrame(parent) {
    message_id_ = QString::fromStdString(msg.id);
    content_ = QString::fromStdString(msg.content);
    thinking_ = QString::fromStdString(msg.thinking);
    build_ui(msg, is_last_assistant);
}

void MessageWidget::build_ui(const Message& msg, bool is_last_assistant) {
    bool is_user = msg.role == "user";
    setObjectName(is_user ? "MessageFrameUser" : "MessageFrameAssistant");
    setFrameShape(QFrame::NoFrame);
    lay_ = new QVBoxLayout(this);
    lay_->setContentsMargins(14, 10, 14, 10);
    lay_->setSpacing(6);

    // header: role + time
    auto* head = new QHBoxLayout();
    auto* role = new QLabel(is_user ? QStringLiteral("YOU") : QStringLiteral("SHUGGLE"));
    role->setObjectName("RoleLabel");
    head->addWidget(role);
    head->addStretch();
    QDateTime t = QDateTime::fromSecsSinceEpoch((qint64)msg.created);
    auto* time_lbl = new QLabel(t.toString(QStringLiteral("HH:mm")));
    time_lbl->setObjectName("ChipLabel");
    head->addWidget(time_lbl);
    lay_->addLayout(head);

    // thinking block (assistant only)
    if (!is_user && !thinking_.isEmpty()) {
        thinking_btn_ = new QPushButton(QStringLiteral("▶ thinking"));
        thinking_btn_->setObjectName("ThinkingToggle");
        thinking_btn_->setCursor(Qt::PointingHandCursor);
        connect(thinking_btn_, &QPushButton::clicked, this, &MessageWidget::toggle_thinking);
        lay_->addWidget(thinking_btn_);

        thinking_wrap_ = new QWidget();
        thinking_wrap_->setVisible(false);
        auto* tw = new QVBoxLayout(thinking_wrap_);
        tw->setContentsMargins(0, 0, 0, 0);
        thinking_view_ = new QTextBrowser();
        thinking_view_->setObjectName("ThinkingBox");
        thinking_view_->setMaximumHeight(220);
        thinking_view_->setPlainText(thinking_);
        tw->addWidget(thinking_view_);
        lay_->addWidget(thinking_wrap_);
    }

    // content
    if (is_user && !msg.attachments.empty()) {
        auto* att_row = new QHBoxLayout();
        for (const auto& a : msg.attachments) {
            auto* chip = new QLabel(QStringLiteral("📄 ") + QString::fromStdString(a.filename));
            chip->setObjectName("AttachmentChip");
            att_row->addWidget(chip);
        }
        att_row->addStretch();
        lay_->addLayout(att_row);
    }
    content_view_ = new QTextBrowser();
    content_view_->setOpenExternalLinks(false);
    content_view_->setOpenLinks(false);
    bool rtl = looks_rtl(content_);
    content_view_->setHtml(md_to_html(content_, rtl));
    connect(content_view_, &QTextBrowser::anchorClicked, this, [this](const QUrl& u) {
        emit link_activated(u);
    });
    // custom context menu: copy / download / run code blocks
    content_view_->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(content_view_, &QWidget::customContextMenuRequested, this,
            [this, is_user](const QPoint& p) {
                QMenu menu;
                QAction* copy = menu.addAction(QStringLiteral("Copy message"));
                QAction* copy_sel = content_view_->textCursor().hasSelection()
                                        ? menu.addAction(QStringLiteral("Copy selection"))
                                        : nullptr;
                QAction* run = nullptr;
                QString lang, code;
                if (!is_user) {
                    // offer "run" for fenced code blocks (first block)
                    static QRegularExpression fence(
                        "```([a-zA-Z0-9_+-]*)\\s*\\n([\\s\\S]*?)```");
                    auto it = fence.globalMatch(content_);
                    if (it.hasNext()) {
                        auto m = it.next();
                        lang = m.captured(1).toLower();
                        code = m.captured(2);
                        run = menu.addAction(QStringLiteral("▶ Run code block") +
                                             (lang.isEmpty() ? QStringLiteral("")
                                                             : QStringLiteral(" (%1)").arg(lang)));
                    }
                    QAction* dl = menu.addAction(QStringLiteral("Download code block…"));
                    // placeholder handled below
                    run = run;  // keep order
                    Q_UNUSED(dl);
                }
                QAction* chosen = menu.exec(content_view_->mapToGlobal(p));
                if (chosen == copy) {
                    QApplication::clipboard()->setText(content_);
                } else if (copy_sel && chosen == copy_sel) {
                    QApplication::clipboard()->setText(content_view_->textCursor().selectedText());
                } else if (run && chosen == run) {
                    emit run_code(code, lang);
                }
            });
    lay_->addWidget(content_view_);

    // footer: chips + actions
    auto* foot = new QHBoxLayout();
    foot->setSpacing(6);
    if (msg.elapsed_ms > 0) {
        auto* chip = new QLabel(QStringLiteral("⏱ %1s").arg(msg.elapsed_ms / 1000.0, 0, 'f', 1));
        chip->setObjectName("ChipLabel");
        foot->addWidget(chip);
    }
    if (!msg.memory_ops_note.empty()) {
        auto* chip = new QLabel(QStringLiteral("🧠 ") + QString::fromStdString(msg.memory_ops_note));
        chip->setObjectName("StatusChip");
        foot->addWidget(chip);
    }
    if (!msg.search_note.empty()) {
        auto* chip = new QLabel(QStringLiteral("🔍 ") + QString::fromStdString(msg.search_note));
        chip->setObjectName("StatusChip");
        foot->addWidget(chip);
    }
    foot->addStretch();

    // branch switcher (siblings)
    if (!msg.parent.empty()) {
        // filled by ChatView which knows the tree — signal via property
    }

    auto* copy_btn = new QPushButton(QStringLiteral("Copy"));
    copy_btn->setObjectName("GhostButton");
    connect(copy_btn, &QPushButton::clicked, this,
            [this] { QApplication::clipboard()->setText(content_); });
    foot->addWidget(copy_btn);

    if (!is_user && is_last_assistant) {
        auto* regen = new QPushButton(QStringLiteral("Regenerate"));
        regen->setObjectName("GhostButton");
        connect(regen, &QPushButton::clicked, this, &MessageWidget::regenerate_requested);
        foot->addWidget(regen);
    }
    if (!is_user && !msg.id.empty()) {
        auto* branch_btn = new QPushButton(QStringLiteral("Branch out"));
        branch_btn->setObjectName("GhostButton");
        branch_btn->setToolTip(QStringLiteral("Start a new chat with the context up to here"));
        connect(branch_btn, &QPushButton::clicked,
                [this] { emit branch_out_requested(message_id_); });
        foot->addWidget(branch_btn);
    }
    lay_->addLayout(foot);
}

void MessageWidget::toggle_thinking() {
    thinking_visible_ = !thinking_visible_;
    thinking_wrap_->setVisible(thinking_visible_);
    thinking_btn_->setText(thinking_visible_ ? QStringLiteral("▼ thinking")
                                             : QStringLiteral("▶ thinking"));
}

void MessageWidget::stream_append_content(const QString& piece) {
    content_ += piece;
    bool rtl = looks_rtl(content_);
    content_view_->setHtml(md_to_html(content_, rtl));
}
void MessageWidget::stream_append_thinking(const QString& piece) {
    thinking_ += piece;
    if (thinking_view_) thinking_view_->setPlainText(thinking_);
    if (thinking_btn_ && thinking_wrap_ && !thinking_wrap_->isVisible())
        toggle_thinking();  // auto-open when thinking starts
}
void MessageWidget::stream_finish(int elapsed_ms) {
    if (elapsed_ms > 0) {
        auto* chip = new QLabel(QStringLiteral("⏱ %1s").arg(elapsed_ms / 1000.0, 0, 'f', 1));
        chip->setObjectName("ChipLabel");
        lay_->insertWidget(lay_->count() - 1, chip);
    }
}

// ── ChatView ─────────────────────────────────────────────────────────────────

ChatView::ChatView(QWidget* parent) : QWidget(parent) {
    auto* root = new QVBoxLayout(this);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);
    scroll_ = new QScrollArea();
    scroll_->setWidgetResizable(true);
    scroll_->setFrameShape(QFrame::NoFrame);
    feed_ = new QWidget();
    feed_->setStyleSheet(QStringLiteral("background: #0d0d0d;"));
    feed_lay_ = new QVBoxLayout(feed_);
    feed_lay_->setAlignment(Qt::AlignTop);
    feed_lay_->setContentsMargins(48, 24, 48, 24);
    feed_lay_->setSpacing(14);
    scroll_->setWidget(feed_);
    root->addWidget(scroll_);
    QScroller::grabGesture(scroll_->viewport(), QScroller::TouchGesture);
}

MessageWidget* ChatView::make_message_widget(const Message& m, bool is_last_assistant) {
    auto* w = new MessageWidget(m, is_last_assistant, feed_);
    connect(w, &MessageWidget::regenerate_requested, this, &ChatView::regenerate_requested);
    connect(w, &MessageWidget::branch_out_requested, this, &ChatView::branch_out_requested);
    connect(w, &MessageWidget::link_activated, this, &ChatView::on_link);
    connect(w, &MessageWidget::run_code, this, &ChatView::run_code);
    return w;
}

void ChatView::show_session(const Session& s) {
    session_id_ = QString::fromStdString(s.id);
    // clear feed
    while (feed_lay_->count() > 0) {
        QLayoutItem* it = feed_lay_->takeAt(0);
        if (it->widget()) it->widget()->deleteLater();
        delete it;
    }
    // walk the active path and render; add branch switchers where siblings exist
    ChatStore store(sessions_dir());
    auto path = store.active_path(s);
    for (size_t i = 0; i < path.size(); i++) {
        const Message* m = path[i];
        MessageWidget* w = make_message_widget(*m, i == path.size() - 1 && m->role == "assistant");

        // branch switcher row above the widget when this message has siblings
        if (!m->parent.empty()) {
            auto pit = s.messages.find(m->parent);
            if (pit != s.messages.end() && pit->second.children.size() > 1) {
                int idx = store.active_branch_index(s, m->id);
                int n = (int)pit->second.children.size();
                auto* row = new QHBoxLayout();
                auto* prev = new QPushButton(QStringLiteral("‹"));
                auto* next = new QPushButton(QStringLiteral("›"));
                prev->setObjectName("BranchButton");
                next->setObjectName("BranchButton");
                auto* lbl = new QLabel(QStringLiteral("%1/%2").arg(idx + 1).arg(n));
                lbl->setObjectName("BranchLabel");
                QString mid = QString::fromStdString(m->id);
                connect(prev, &QPushButton::clicked, this, [this, mid, idx, n] {
                    if (idx > 0) emit switch_branch(mid, idx - 1);
                });
                connect(next, &QPushButton::clicked, this, [this, mid, idx, n] {
                    if (idx < n - 1) emit switch_branch(mid, idx + 1);
                });
                row->addWidget(prev);
                row->addWidget(lbl);
                row->addWidget(next);
                row->addStretch();
                QWidget* roww = new QWidget();
                roww->setLayout(row);
                feed_lay_->addWidget(roww);
            }
        }
        feed_lay_->addWidget(w);
    }
    feed_lay_->addStretch();
    QTimer::singleShot(30, this, &ChatView::scroll_to_bottom);
}

void ChatView::show_empty(const QString& hint) {
    session_id_.clear();
    while (feed_lay_->count() > 0) {
        QLayoutItem* it = feed_lay_->takeAt(0);
        if (it->widget()) it->widget()->deleteLater();
        delete it;
    }
    auto* lbl = new QLabel(hint);
    lbl->setAlignment(Qt::AlignCenter);
    lbl->setStyleSheet(
        QStringLiteral("color: #5a5a5a; font-size: 22px; font-weight: 600; background: transparent;"));
    feed_lay_->addWidget(lbl, 0, Qt::AlignCenter);
    auto* sub = new QLabel(QStringLiteral("Pick a token, start typing, and the T4s do the rest."));
    sub->setAlignment(Qt::AlignCenter);
    sub->setStyleSheet(QStringLiteral("color: #3d3d3d; background: transparent;"));
    feed_lay_->addWidget(sub, 0, Qt::AlignCenter);
    feed_lay_->addStretch();
}

void ChatView::begin_transient() {
    Message m;
    m.role = "assistant";
    m.created = (int64_t)QDateTime::currentSecsSinceEpoch();
    transient_ = new MessageWidget(m, true, feed_);
    feed_lay_->addWidget(transient_);
    scroll_to_bottom();
}

QWidget* ChatView::transient_widget() { return transient_.data(); }

void ChatView::end_transient() {
    if (transient_) {
        transient_->deleteLater();
        transient_.clear();
    }
}

void ChatView::scroll_to_bottom() {
    auto* bar = scroll_->verticalScrollBar();
    bar->setValue(bar->maximum());
}

void ChatView::on_link(const QUrl& url) {
    if (link_opener_) link_opener_(url);
    else QDesktopServices::openUrl(url);
}

} // namespace shuggle
