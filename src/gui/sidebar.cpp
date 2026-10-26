// Shuggle — sidebar.cpp
#include "sidebar.h"

#include <QContextMenuEvent>
#include <QDateTime>
#include <QHBoxLayout>
#include <QListWidget>
#include <QMenu>
#include <QProgressBar>
#include <QRegularExpression>

#include "theme.h"

namespace shuggle {

static constexpr int ROLE_ID = Qt::UserRole;
static constexpr int ROLE_MSG = Qt::UserRole + 1;

Sidebar::Sidebar(QWidget* parent) : QWidget(parent) {
    setObjectName("Sidebar");
    setFixedWidth(300);
    root_ = new QVBoxLayout(this);
    root_->setContentsMargins(12, 14, 12, 12);
    root_->setSpacing(8);

    // brand
    auto* brand = new QHBoxLayout();
    auto* logo = new QLabel();
    logo->setPixmap(QIcon(QStringLiteral(":/icons/shuggle_128.png"))
                        .pixmap(28, 28));
    auto* name = new QLabel(QStringLiteral("Shuggle"));
    name->setObjectName("Brand");
    brand->addWidget(logo);
    brand->addWidget(name);
    brand->addStretch();
    root_->addLayout(brand);

    // new chat
    auto* new_btn = new QPushButton(QStringLiteral("＋  New chat"));
    new_btn->setObjectName("NewChatButton");
    connect(new_btn, &QPushButton::clicked, this, &Sidebar::new_chat);
    root_->addWidget(new_btn);

    // search
    search_ = new QLineEdit();
    search_->setObjectName("SearchEdit");
    search_->setPlaceholderText(QStringLiteral("Search chats  (name · content · date)"));
    search_->setClearButtonEnabled(true);
    connect(search_, &QLineEdit::textChanged, this, &Sidebar::on_search_changed);
    root_->addWidget(search_);

    // date filter row (custom search: by date range, optional)
    auto* date_row = new QHBoxLayout();
    auto* hint = new QLabel(QStringLiteral("Search is instant — leave empty for all"));
    hint->setObjectName("HintLabel");
    date_row->addWidget(hint);
    date_row->addStretch();
    root_->addLayout(date_row);

    // lists container (hidden during search mode)
    lists_wrap_ = new QWidget();
    auto* lw = new QVBoxLayout(lists_wrap_);
    lw->setContentsMargins(0, 0, 0, 0);
    lw->setSpacing(0);

    // pinned section
    pinned_head_ = new QWidget();
    auto* ph = new QHBoxLayout(pinned_head_);
    ph->setContentsMargins(4, 4, 0, 0);
    auto* pl = new QLabel(QStringLiteral("PINNED"));
    pl->setObjectName("SectionHeader");
    auto* pt = new QPushButton(pinned_open_ ? QStringLiteral("▾") : QStringLiteral("▸"));
    pt->setObjectName("GhostButton");
    pt->setFixedWidth(24);
    connect(pt, &QPushButton::clicked, this, [this, pt] {
        pinned_open_ = !pinned_open_;
        pt->setText(pinned_open_ ? QStringLiteral("▾") : QStringLiteral("▸"));
        pinned_list_->setVisible(pinned_open_);
    });
    ph->addWidget(pl);
    ph->addStretch();
    ph->addWidget(pt);
    lw->addWidget(pinned_head_);
    pinned_list_ = new QListWidget();
    pinned_list_->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(pinned_list_, &QWidget::customContextMenuRequested, this,
            &Sidebar::on_context_menu);
    connect(pinned_list_, &QListWidget::itemClicked, this, [this](QListWidgetItem* it) {
        emit session_selected(it->data(ROLE_ID).toString());
    });
    lw->addWidget(pinned_list_, 0);

    // history section
    history_head_ = new QWidget();
    auto* hh = new QHBoxLayout(history_head_);
    hh->setContentsMargins(4, 4, 0, 0);
    auto* hl = new QLabel(QStringLiteral("HISTORY"));
    hl->setObjectName("SectionHeader");
    auto* ht = new QPushButton(history_open_ ? QStringLiteral("▾") : QStringLiteral("▸"));
    ht->setObjectName("GhostButton");
    ht->setFixedWidth(24);
    connect(ht, &QPushButton::clicked, this, [this, ht] {
        history_open_ = !history_open_;
        ht->setText(history_open_ ? QStringLiteral("▾") : QStringLiteral("▸"));
        history_list_->setVisible(history_open_);
    });
    hh->addWidget(hl);
    hh->addStretch();
    hh->addWidget(ht);
    lw->addWidget(history_head_);
    history_list_ = new QListWidget();
    history_list_->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(history_list_, &QWidget::customContextMenuRequested, this,
            &Sidebar::on_context_menu);
    connect(history_list_, &QListWidget::itemClicked, this, [this](QListWidgetItem* it) {
        emit session_selected(it->data(ROLE_ID).toString());
    });
    lw->addWidget(history_list_, 1);
    root_->addWidget(lists_wrap_, 1);

    // search results (replaces lists when searching)
    results_wrap_ = new QWidget();
    auto* rw = new QVBoxLayout(results_wrap_);
    rw->setContentsMargins(0, 0, 0, 0);
    results_list_ = new QListWidget();
    connect(results_list_, &QListWidget::itemClicked, this, [this](QListWidgetItem* it) {
        emit search_hit_selected(it->data(ROLE_ID).toString(),
                                 it->data(ROLE_MSG).toString());
    });
    rw->addWidget(results_list_);
    results_wrap_->hide();
    root_->addWidget(results_wrap_, 1);

    // footer: pool meter + buttons
    pool_label_ = new QLabel(QStringLiteral("no tokens yet"));
    pool_label_->setObjectName("HintLabel");
    pool_label_->setWordWrap(true);
    root_->addWidget(pool_label_);
    auto* foot = new QHBoxLayout();
    auto* tokens_btn = new QPushButton(QStringLiteral("🔑 Tokens"));
    auto* settings_btn = new QPushButton(QStringLiteral("⚙ Settings"));
    connect(tokens_btn, &QPushButton::clicked, this, &Sidebar::tokens_clicked);
    connect(settings_btn, &QPushButton::clicked, this, &Sidebar::settings_clicked);
    foot->addWidget(tokens_btn);
    foot->addWidget(settings_btn);
    root_->addLayout(foot);
}

void Sidebar::refresh_sessions(const std::vector<Session>& sessions,
                               const QString& current_id) {
    sessions_ = sessions;
    rebuild_lists(sessions, current_id);
}

void Sidebar::rebuild_lists(const std::vector<Session>& sessions, const QString& current_id) {
    pinned_list_->clear();
    history_list_->clear();
    for (const auto& s : sessions) {
        QString title = QString::fromStdString(s.title);
        QString id = QString::fromStdString(s.id);
        // activity/notebook marks: ● generating handled by main window later;
        // here we show pin state and bound notebook
        QString mark = s.pinned ? QStringLiteral("★ ") : QStringLiteral("");
        QListWidgetItem* it = new QListWidgetItem(mark + title, nullptr);
        it->setData(ROLE_ID, id);
        it->setToolTip(
            QStringLiteral("%1\nupdated %2%3")
                .arg(id)
                .arg(QDateTime::fromSecsSinceEpoch((qint64)s.updated)
                         .toString(QStringLiteral("yyyy-MM-dd HH:mm")))
                .arg(s.bound_username.empty()
                         ? QStringLiteral("")
                         : QStringLiteral("\nnotebook: @%1")
                               .arg(QString::fromStdString(s.bound_username))));
        if (id == current_id) {
            QFont f = it->font();
            f.setBold(true);
            it->setFont(f);
        }
        if (s.pinned) pinned_list_->addItem(it);
        else history_list_->addItem(it);
    }
}

void Sidebar::set_pool_meter(const TokenManager::PoolMeter& m) {
    if (m.total_hours <= 0) {
        pool_label_->setText(QStringLiteral("no tokens yet — click 🔑 Tokens"));
        return;
    }
    double remaining = m.total_hours - m.used_hours;
    if (remaining < 0) remaining = 0;
    QString txt = QStringLiteral("⚡ pool: %1h left of %2h · ready %3 · exhausted %4")
                      .arg(remaining, 0, 'f', 1)
                      .arg(m.total_hours, 0, 'f', 0)
                      .arg(m.ready)
                      .arg(m.exhausted);
    if (!m.next_reset_utc.empty())
        txt += QStringLiteral("\nreset: %1").arg(QString::fromStdString(m.next_reset_utc));
    pool_label_->setText(txt);
}

void Sidebar::set_search_mode(bool on) {
    search_mode_ = on;
    lists_wrap_->setVisible(!on);
    results_wrap_->setVisible(on);
    if (!on) emit search_cleared();
}

void Sidebar::on_search_changed() {
    QString q = search_->text();
    if (q.isEmpty() && search_mode_) {
        set_search_mode(false);
        return;
    }
    if (!q.isEmpty() && !search_mode_) set_search_mode(true);
    if (search_mode_) {
        // date filtering: support "2026-10-27" prefix in query
        qint64 from = 0, to = 0;
        QString text = q;
        static QRegularExpression dateRe(
            R"(^(\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}))?\s*(.*))");
        auto m = dateRe.match(text);
        if (m.hasMatch()) {
            QDate d1 = QDate::fromString(m.captured(1), QStringLiteral("yyyy-MM-dd"));
            if (d1.isValid()) {
                from = QDateTime(d1, QTime(0, 0)).toSecsSinceEpoch();
                QDate d2 = QDate::fromString(m.captured(2), QStringLiteral("yyyy-MM-dd"));
                to = d2.isValid() ? QDateTime(d2, QTime(23, 59)).toSecsSinceEpoch()
                                  : QDateTime(d1, QTime(23, 59)).toSecsSinceEpoch();
                text = m.captured(3);
            }
        }
        emit search_query(text, from, to);
    }
}

void Sidebar::on_context_menu(const QPoint& pos) {
    auto* list = qobject_cast<QListWidget*>(sender());
    QListWidgetItem* item = list ? list->itemAt(pos) : nullptr;
    if (!item) return;
    QString id = item->data(ROLE_ID).toString();
    QMenu menu;
    QAction* pin = menu.addAction(QStringLiteral("Pin / Unpin"));
    QAction* dual = menu.addAction(QStringLiteral("Run both (dual chat)…"));
    QAction* del = menu.addAction(QStringLiteral("Delete"));
    connect(pin, &QAction::triggered, this, [this, id] { emit session_pin_toggled(id); });
    connect(dual, &QAction::triggered, this, [this, id] { emit session_dual_requested(id); });
    connect(del, &QAction::triggered, this, [this, id] { emit session_delete_requested(id); });
    menu.exec(list->mapToGlobal(pos));
}

} // namespace shuggle
