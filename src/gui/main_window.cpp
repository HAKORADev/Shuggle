// Shuggle — main_window.cpp
#include "main_window.h"

#include <QApplication>
#include <QCheckBox>
#include <QCloseEvent>
#include <QDesktopServices>
#include <QDockWidget>
#include <QFileDialog>
#include <QHBoxLayout>
#include <QInputDialog>
#include <QLabel>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QSplitter>
#include <QTimer>
#include <QUrl>
#include <QVBoxLayout>

#include "settings_dialog.h"
#include "terminal_panel.h"
#include "theme.h"
#include "token_dialog.h"
#include "web_runtime.h"
#include "../common/version.h"
#include "../core/util.h"

namespace shuggle {

MainWindow::MainWindow()
    : settings_(GlobalSettings::load(settings_file_path())),
      tokens_(tokens_file_path()),
      store_(sessions_dir()),
      memory_(memory_file_path()),
      engine_(settings_, tokens_) {
    tokens_.load();
    memory_.load();
    setWindowTitle(QStringLiteral("Shuggle v%1").arg(kAppVersion));
    resize(1280, 820);
    build_ui();
    first_run_wizard();
    refresh_sidebar();
    chat_->show_empty(QStringLiteral("New chat?"));
    set_busy(false);

    // token refresh loop (UI thread): one token per tick
    auto* timer = new QTimer(this);
    connect(timer, &QTimer::timeout, this, [this] {
        tokens_.introspect_one();
        tokens_.refresh_one();
        tokens_.recover_expired();
        auto meter = tokens_.pool_meter();
        sidebar_->set_pool_meter(meter);
        engine_.set_user_active(isActiveWindow());
    });
    timer->start(60000);
    auto* hb = new QTimer(this);
    connect(hb, &QTimer::timeout, this, &MainWindow::heartbeat_ui);
    hb->start(45000);
}

MainWindow::~MainWindow() {
    if (worker_.joinable()) worker_.join();
}

void MainWindow::closeEvent(QCloseEvent* e) {
    if (worker_.joinable()) worker_.join();
    e->accept();
}

void MainWindow::build_ui() {
    auto* central = new QWidget();
    auto* root = new QHBoxLayout(central);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);

    sidebar_ = new Sidebar();
    root->addWidget(sidebar_);

    // right side: chat (+ optional dual) + composer
    auto* right = new QWidget();
    auto* rlay = new QVBoxLayout(right);
    rlay->setContentsMargins(0, 0, 0, 0);
    rlay->setSpacing(0);

    // chat header
    auto* head = new QWidget();
    head->setStyleSheet(QStringLiteral("background: #121212; border-bottom: 1px solid #2a2a2a;"));
    auto* hl = new QHBoxLayout(head);
    hl->setContentsMargins(18, 10, 18, 10);
    title_ = new QLabel(QStringLiteral("Shuggle"));
    title_->setStyleSheet(QStringLiteral("font-weight: 600; background: transparent;"));
    hl->addWidget(title_);
    hl->addStretch();
    status_ = new QLabel(QString());
    status_->setObjectName("HintLabel");
    hl->addWidget(status_);
    think_btn_ = new QPushButton(QStringLiteral("Thinking: on"));
    think_btn_->setObjectName("GhostButton");
    think_btn_->setToolTip(QStringLiteral("Show/hide the model's internal thinking blocks"));
    connect(think_btn_, &QPushButton::clicked, this, [this] {
        static bool shown = true;
        shown = !shown;
        think_btn_->setText(shown ? QStringLiteral("Thinking: on")
                                  : QStringLiteral("Thinking: hidden"));
        // toggle visibility of all ThinkingBox widgets in the feed
        for (QWidget* w : findChildren<QWidget*>()) {
            if (w->objectName() == "ThinkingBox") w->setVisible(shown);
        }
    });
    hl->addWidget(think_btn_);
    per_session_btn_ = new QPushButton(QStringLiteral("Session settings"));
    per_session_btn_->setObjectName("GhostButton");
    connect(per_session_btn_, &QPushButton::clicked, this, &MainWindow::on_session_settings);
    hl->addWidget(per_session_btn_);
    rlay->addWidget(head);

    // chat pane(s)
    auto* split = new QSplitter(Qt::Horizontal);
    chat_ = new ChatView();
    chat_->set_link_opener([this](const QUrl& u) { on_link(u); });
    split->addWidget(chat_);
    chat2_wrap_ = new QWidget();
    auto* c2l = new QVBoxLayout(chat2_wrap_);
    c2l->setContentsMargins(0, 0, 0, 0);
    auto* c2head = new QLabel(QStringLiteral("dual pane — second session"));
    c2head->setStyleSheet(QStringLiteral("color:#8a8a8a; padding:6px 12px; background:#121212;"));
    c2l->addWidget(c2head);
    chat2_ = new ChatView();
    chat2_->set_link_opener([this](const QUrl& u) { on_link(u); });
    c2l->addWidget(chat2_, 1);
    split->addWidget(chat2_wrap_);
    chat2_wrap_->hide();
    split->setSizes({1, 1});
    rlay->addWidget(split, 1);
    connect(chat_, &ChatView::regenerate_requested, this, &MainWindow::on_regenerate);
    connect(chat_, &ChatView::branch_out_requested, this, &MainWindow::on_branch_out);
    connect(chat_, &ChatView::switch_branch, this, &MainWindow::on_switch_branch);
    connect(chat_, &ChatView::run_code, this, &MainWindow::on_run_code);
    connect(chat2_, &ChatView::regenerate_requested, this, &MainWindow::on_regenerate);
    connect(chat2_, &ChatView::run_code, this, &MainWindow::on_run_code);

    // composer
    auto* composer_frame = new QFrame();
    composer_frame->setObjectName("ComposerFrame");
    auto* cl = new QVBoxLayout(composer_frame);
    cl->setContentsMargins(12, 10, 12, 10);
    cl->setSpacing(6);
    auto* attach_row = new QHBoxLayout();
    attach_row->setSpacing(6);
    attach_row->setObjectName("AttachRow");
    cl->addLayout(attach_row);
    auto* crow = new QHBoxLayout();
    composer_ = new QPlainTextEdit();
    composer_->setObjectName("ComposerEdit");
    composer_->setFixedHeight(56);
    composer_->setPlaceholderText(
        QStringLiteral("Message Shuggle…  (Ctrl+Enter to send)"));
    crow->addWidget(composer_, 1);
    auto* col = new QVBoxLayout();
    auto* send = new QPushButton(QStringLiteral("Send ↑"));
    send->setObjectName("SendButton");
    connect(send, &QPushButton::clicked, this, &MainWindow::on_send);
    search_toggle_ = new QCheckBox(QStringLiteral("search"));
    search_toggle_->setToolTip(QStringLiteral("Toggle web search for this chat"));
    col->addWidget(search_toggle_);
    col->addWidget(send);
    crow->addLayout(col);
    cl->addLayout(crow);
    rlay->addWidget(composer_frame);

    root->addWidget(right, 1);
    setCentralWidget(central);

    // terminal dock
    terminal_ = new TerminalPanel(this);
    addDockWidget(Qt::BottomDockWidgetArea, terminal_);
    terminal_->hide();

    // sidebar wiring
    connect(sidebar_, &Sidebar::new_chat, this, &MainWindow::on_new_chat);
    connect(sidebar_, &Sidebar::session_selected, this, &MainWindow::on_select_session);
    connect(sidebar_, &Sidebar::session_delete_requested, this, &MainWindow::on_delete_session);
    connect(sidebar_, &Sidebar::session_pin_toggled, this, &MainWindow::on_pin_session);
    connect(sidebar_, &Sidebar::session_dual_requested, this, &MainWindow::on_dual_session);
    connect(sidebar_, &Sidebar::search_query, this, &MainWindow::on_search);
    connect(sidebar_, &Sidebar::search_hit_selected, this, &MainWindow::on_search_hit);
    connect(sidebar_, &Sidebar::tokens_clicked, this, &MainWindow::on_tokens);
    connect(sidebar_, &Sidebar::settings_clicked, this, &MainWindow::on_settings);

    // Ctrl+Enter send
    connect(composer_, &QPlainTextEdit::textChanged, this, []() {});
    composer_->installEventFilter(this);
}

// eventFilter for Ctrl+Enter
bool MainWindow::eventFilter(QObject* obj, QEvent* ev) {
    if (obj == composer_ && ev->type() == QEvent::KeyPress) {
        auto* ke = static_cast<QKeyEvent*>(ev);
        if ((ke->key() == Qt::Key_Return || ke->key() == Qt::Key_Enter) &&
            (ke->modifiers() & Qt::ControlModifier)) {
            on_send();
            return true;
        }
    }
    return QMainWindow::eventFilter(obj, ev);
}

void MainWindow::first_run_wizard() {
    if (tokens_.size() == 0) {
        QMessageBox welcome(
            QMessageBox::Information, QStringLiteral("Welcome to Shuggle"),
            QStringLiteral(
                "Shuggle runs an uncensored 27B model on Kaggle's free GPU hours.\n\n"
                "First step: add a Kaggle API token (the ? button in the Tokens window "
                "walks you through it step by step).\n\nEverything stays on your disk "
                "except the messages you send."),
            QMessageBox::Ok, this);
        welcome.exec();
        on_tokens();
    }
}

void MainWindow::refresh_sidebar() {
    auto sessions = store_.list_sessions(false);
    QString cur = current_ ? QString::fromStdString(current_->id) : QString();
    sidebar_->refresh_sessions(sessions, cur);
    sidebar_->set_pool_meter(tokens_.pool_meter());
}

// ── session ops ──────────────────────────────────────────────────────────────

void MainWindow::on_new_chat() {
    Session s;
    s.id = random_hex(12);
    s.title = "New chat";
    s.created = now_epoch_seconds();
    s.updated = s.created;
    s.ever_named = false;
    store_.save_session(s);
    open_session(QString::fromStdString(s.id));
}

void MainWindow::on_select_session(const QString& id) { open_session(id); }

void MainWindow::open_session(const QString& id) {
    auto s = store_.load_session(id.toStdString());
    if (!s) return;
    current_ = *s;
    title_->setText(QString::fromStdString(s->title));
    chat_->show_session(*s);
    search_toggle_->setChecked(s->settings.effective_search(settings_.search_enabled_default));
    refresh_sidebar();
}

void MainWindow::on_delete_session(const QString& id) {
    auto s = store_.load_session(id.toStdString());
    if (!s) return;
    auto r = QMessageBox::question(this, QStringLiteral("Delete chat"),
                                   QStringLiteral("Delete '%1'?\nThis cannot be undone.")
                                       .arg(QString::fromStdString(s->title)));
    if (r != QMessageBox::Yes) return;
    if (settings_.kaggle_sync_enabled) {
        std::string err;
        engine_.archive_deleted_session(*s, err);  // best-effort archive first
    }
    store_.delete_session(id.toStdString());
    if (current_ && current_->id == s->id) {
        current_.reset();
        chat_->show_empty(QStringLiteral("Deleted. Start something new?"));
        title_->setText(QStringLiteral("Shuggle"));
    }
    refresh_sidebar();
}

void MainWindow::on_pin_session(const QString& id) {
    auto s = store_.load_session(id.toStdString());
    if (!s) return;
    s->pinned = !s->pinned;
    store_.save_session(*s);
    refresh_sidebar();
}

void MainWindow::on_dual_session(const QString& id) {
    auto s = store_.load_session(id.toStdString());
    if (!s) return;
    if (dual_session_ && dual_session_->id == s->id) {
        dual_session_.reset();
        chat2_wrap_->hide();
        return;
    }
    dual_session_ = *s;
    chat2_->show_session(*s);
    chat2_wrap_->show();
}

// ── search ───────────────────────────────────────────────────────────────────

void MainWindow::on_search(const QString& q, qint64 from, qint64 to) {
    auto hits = store_.search(q.toStdString(), from, to);
    sidebar_->set_search_mode(true);
    (void)hits;  // rendering handled through signal below (simple flow):
}

void MainWindow::on_search_hit(const QString& session_id, const QString& message_id) {
    open_session(session_id);
    Q_UNUSED(message_id);  // v0.5: open the session; highlight lands next iteration
}

// ── generation ───────────────────────────────────────────────────────────────

void MainWindow::on_send() {
    if (busy_) return;
    if (!current_) on_new_chat();
    if (!current_) return;
    QString text = composer_->toPlainText();
    if (text.trimmed().isEmpty()) {
        QMessageBox::information(this, QStringLiteral("Empty message"),
                                 QStringLiteral("Write something first — the T4s are eager."));
        return;
    }
    if (tokens_.size() == 0) {
        QMessageBox::warning(this, QStringLiteral("No token"),
                             QStringLiteral("Add a Kaggle token first (🔑 Tokens)."));
        return;
    }
    // sync search toggle into the session
    current_->settings.search_enabled_v = search_toggle_->isChecked();

    // auto-naming (local heuristic; "shines" until named)
    if (!current_->ever_named) {
        current_->title = ChatStore::auto_title(text.toStdString());
        current_->ever_named = true;
        title_->setText(QString::fromStdString(current_->title));
        refresh_sidebar();
    }

    composer_->clear();
    start_generation(*current_, text.toStdString(), std::move(pending_attachments_), false);
    pending_attachments_.clear();
    // dual broadcast
    if (dual_session_) {
        Session d = *dual_session_;
        d.settings.search_enabled_v = search_toggle_->isChecked();
        start_generation(d, text.toStdString(), {}, true);
    }
}

void MainWindow::start_generation(Session s, const std::string& text,
                                  std::vector<Attachment> attachments, bool to_dual) {
    set_busy(true);
    ChatView* view = to_dual ? chat2_ : chat_;
    std::string sid = s.id;
    QString sid_q = QString::fromStdString(sid);
    // persist the session copy we are generating against
    store_.save_session(s);

    // optimistic UI: user message + transient streaming widget
    ChatStore tmp(sessions_dir());
    Message fake_user;
    fake_user.role = "user";
    fake_user.content = text;
    fake_user.created = now_epoch_seconds();
    fake_user.id = "pending";
    auto fresh = store_.load_session(sid_q.toStdString());
    if (fresh) {
        view->show_session(*fresh);
        if (to_dual) chat2_->show_session(*fresh);
    }
    view->begin_transient();

    if (worker_.joinable()) worker_.join();
    worker_ = std::thread([this, s, text, attachments, to_dual, sid_q]() {
        ChatView* v = to_dual ? chat2_ : chat_;
        QPointer<ChatView> view_guard(v);
        EngineCallbacks cb;
        cb.on_stage = [this, to_dual](const std::string& stage) {
            QString q = QString::fromStdString(stage);
            QMetaObject::invokeMethod(
                this, [this, q, to_dual] {
                    status_->setText(to_dual ? QStringLiteral("dual: %1").arg(q) : q);
                },
                Qt::QueuedConnection);
        };
        cb.on_thinking = [this, view_guard, to_dual](const std::string& piece) {
            QString q = QString::fromStdString(piece);
            QMetaObject::invokeMethod(
                this, [this, view_guard, q, to_dual] {
                    if (!view_guard) return;
                    auto* tw = qobject_cast<MessageWidget*>(view_guard->transient_widget());
                    if (tw) tw->stream_append_thinking(q);
                    view_guard->scroll_to_bottom();
                },
                Qt::QueuedConnection);
        };
        cb.on_content = [this, view_guard, to_dual](const std::string& piece) {
            QString q = QString::fromStdString(piece);
            QMetaObject::invokeMethod(
                this, [this, view_guard, q, to_dual] {
                    if (!view_guard) return;
                    auto* tw = qobject_cast<MessageWidget*>(view_guard->transient_widget());
                    if (tw) tw->stream_append_content(q);
                    view_guard->scroll_to_bottom();
                },
                Qt::QueuedConnection);
        };
        cb.keep_going = [] { return true; };

        // engine->chat needs a mutable session ref; use a local copy then persist
        Session local = s;
        ChatReply reply = engine_.chat(local, text, attachments, cb);
        store_.save_session(local);
        // if dual pane session, also update dual_session_
        QMetaObject::invokeMethod(
            this,
            [this, reply, to_dual, sid_q, local]() {
                if (!to_dual && current_ && current_->id == local.id) current_ = local;
                if (to_dual && dual_session_ && dual_session_->id == local.id)
                    dual_session_ = local;
                finish_generation(reply.error.empty(), QString::fromStdString(reply.error),
                                  to_dual);
            },
            Qt::BlockingQueuedConnection);
    });
}

void MainWindow::finish_generation(bool ok, const QString& err, bool dual) {
    ChatView* view = dual ? chat2_ : chat_;
    view->end_transient();
    if (current_) {
        auto s = store_.load_session(current_->id);
        if (s) {
            current_ = *s;
            view->show_session(*s);
        }
    }
    if (dual && dual_session_) {
        auto s = store_.load_session(dual_session_->id);
        if (s) {
            dual_session_ = *s;
            chat2_->show_session(*s);
        }
    }
    if (!ok && !err.isEmpty()) QMessageBox::warning(this, QStringLiteral("Engine"), err);
    status_->clear();
    set_busy(false);
    refresh_sidebar();
}

void MainWindow::set_busy(bool b) {
    busy_ = b;
    title_->setText(current_ ? QString::fromStdString(current_->title) : QStringLiteral("Shuggle"));
    if (b) status_->setText(QStringLiteral("working…"));
}

void MainWindow::on_regenerate() {
    if (busy_ || !current_) return;
    Session s = *current_;
    set_busy(true);
    auto view = chat_;
    view->begin_transient();
    if (worker_.joinable()) worker_.join();
    worker_ = std::thread([this, s]() {
        ChatStore tmp(sessions_dir());
        Session local = s;
        EngineCallbacks cb;
        cb.on_stage = [this](const std::string& st) {
            QString q = QString::fromStdString(st);
            QMetaObject::invokeMethod(this, [this, q] { status_->setText(q); },
                                      Qt::QueuedConnection);
        };
        cb.on_thinking = [this](const std::string& piece) {
            QString q = QString::fromStdString(piece);
            QMetaObject::invokeMethod(this, [this, q] { status_->setText(q); },
                                      Qt::QueuedConnection);
        };
        cb.on_content = [](const std::string&) {};
        cb.keep_going = [] { return true; };
        ChatReply reply = engine_.regenerate(local, cb);
        store_.save_session(local);
        QMetaObject::invokeMethod(
            this,
            [this, reply, local]() {
                if (current_ && current_->id == local.id) current_ = local;
                finish_generation(reply.error.empty(), QString::fromStdString(reply.error), false);
            },
            Qt::BlockingQueuedConnection);
    });
}

void MainWindow::on_branch_out(const QString& message_id) {
    if (!current_) return;
    auto ns = store_.branch_out(*current_, message_id.toStdString(),
                                current_->title + " ↗");
    if (!ns) return;
    Session created = *ns;
    store_.save_session(created);
    open_session(QString::fromStdString(created.id));
}

void MainWindow::on_switch_branch(const QString& message_id, int child_index) {
    if (!current_) return;
    store_.switch_branch(*current_, message_id.toStdString(), child_index);
    store_.save_session(*current_);
    chat_->show_session(*current_);
}

void MainWindow::on_run_code(const QString& code, const QString& language) {
    if (language.compare(QStringLiteral("python"), Qt::CaseInsensitive) == 0 &&
        !TerminalPanel::python_available()) {
        QMessageBox::information(
            this, QStringLiteral("Python not found"),
            QStringLiteral("No Python interpreter is installed or on PATH.\n"
                           "Install Python and it will light up — the app checks every time."));
        return;
    }
    terminal_->run(code, language);
}

void MainWindow::on_link(const QUrl& url) {
    if (settings_.open_links_inside_app) {
        open_internal_browser(resolve_open_link(url), settings_.edge_reuse_browser_data, this);
    } else {
        QDesktopServices::openUrl(url);
    }
}

std::string MainWindow::resolve_open_link(const QUrl& url) { return url.toString().toStdString(); }

void MainWindow::on_settings() {
    GlobalSettingsDialog dlg(settings_, this);
    connect(&dlg, &GlobalSettingsDialog::saved, this, [this] {
        QMessageBox::information(this, QStringLiteral("Saved"),
                                 QStringLiteral("Context changes apply on the next notebook "
                                                "boot (semi-cold start)."));
        refresh_sidebar();
    });
    dlg.exec();
}

void MainWindow::on_tokens() {
    TokenDialog dlg(tokens_, this);
    connect(&dlg, &TokenDialog::pool_changed, this, &MainWindow::refresh_sidebar);
    dlg.exec();
}

void MainWindow::on_session_settings() {
    if (!current_) return;
    SessionSettingsDialog dlg(settings_, current_->settings, current_->bound_token, this);
    if (dlg.exec()) {
        store_.save_session(*current_);
        title_->setText(QString::fromStdString(current_->title));
    }
}

void MainWindow::heartbeat_ui() { engine_.heartbeat_tick(); }

} // namespace shuggle
