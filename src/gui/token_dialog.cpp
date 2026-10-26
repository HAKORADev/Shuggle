// Shuggle — token_dialog.cpp
#include "token_dialog.h"

#include <QFileDialog>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QScrollArea>
#include <QTableWidget>
#include <QVBoxLayout>

#include "theme.h"
#include "../core/util.h"
#include "../common/version.h"

namespace shuggle {

TokenDialog::TokenDialog(TokenManager& tokens, QWidget* parent)
    : QDialog(parent), tokens_(tokens) {
    setWindowTitle(QStringLiteral("Tokens — Kaggle GPU pool"));
    resize(640, 520);

    auto* root = new QVBoxLayout(this);
    root->setSpacing(10);

    summary_ = new QLabel();
    root->addWidget(summary_);

    list_ = new QListWidget();
    root->addWidget(list_, 1);

    auto* add_row = new QHBoxLayout();
    input_ = new QLineEdit();
    input_->setPlaceholderText(QStringLiteral("paste KGAT_... token (one per account)"));
    auto* add_btn = new QPushButton(QStringLiteral("Add"));
    add_btn->setObjectName("AccentButton");
    connect(add_btn, &QPushButton::clicked, this, &TokenDialog::add_token);
    connect(input_, &QLineEdit::returnPressed, this, &TokenDialog::add_token);
    add_row->addWidget(input_, 1);
    add_row->addWidget(add_btn);
    root->addLayout(add_row);

    auto* btn_row = new QHBoxLayout();
    auto* help_btn = new QPushButton(QStringLiteral("?  How do I create a token?"));
    connect(help_btn, &QPushButton::clicked, this, &TokenDialog::show_help);
    auto* rm_btn = new QPushButton(QStringLiteral("Remove selected"));
    rm_btn->setObjectName("DangerButton");
    connect(rm_btn, &QPushButton::clicked, this, &TokenDialog::remove_selected);
    auto* close_btn = new QPushButton(QStringLiteral("Close"));
    connect(close_btn, &QPushButton::clicked, this, &QDialog::accept);
    btn_row->addWidget(help_btn);
    btn_row->addStretch();
    btn_row->addWidget(rm_btn);
    btn_row->addWidget(close_btn);
    root->addLayout(btn_row);

    refresh_list();
}

void TokenDialog::refresh_list() {
    list_->clear();
    const auto m = tokens_.pool_meter();
    if (m.total_hours > 0) {
        summary_->setText(
            QStringLiteral("⚡ pooled: %1h used of %2h · ready %3 · in-use %4 · exhausted %5 "
                           "· invalid %6 · next reset %7")
                .arg(m.used_hours, 0, 'f', 1)
                .arg(m.total_hours, 0, 'f', 0)
                .arg(m.ready)
                .arg(m.in_use)
                .arg(m.exhausted)
                .arg(m.invalid)
                .arg(m.next_reset_utc.empty() ? QStringLiteral("—") : QString::fromStdString(m.next_reset_utc)));
    } else {
        summary_->setText(QStringLiteral("no tokens yet — add one below"));
    }
    for (const auto& t : tokens_.all()) {
        QString state = QString::fromStdString(token_state_name(t.state));
        QString line =
            QStringLiteral("@%1  ·  %2…%3  ·  %4  ·  %5h / %6h used")
                .arg(t.username.empty() ? QStringLiteral("(introspecting…)")
                                        : QString::fromStdString(t.username),
                    QString::fromStdString(t.token.substr(0, 8)),
                    QString::fromStdString(t.token.substr(t.token.size() - 4)))
                .arg(state)
                .arg(t.quota.used_hours(), 0, 'f', 1)
                .arg(t.quota.total_hours() > 0 ? t.quota.total_hours() : 30.0, 0, 'f', 0);
        if (t.state == TokenState::EXHAUSTED)
            line += QStringLiteral("  · recovers %1")
                        .arg(QString::fromStdString(t.quota.refresh_time_utc));
        auto* it = new QListWidgetItem(line, nullptr);
        QColor c(Qt::white);
        if (t.state == TokenState::EXHAUSTED) c = QColor(COL_DANGER);
        else if (t.state == TokenState::READY) c = QColor("#7ee787");
        else if (t.state == TokenState::INVALID) c = QColor("#ff6b6b");
        it->setForeground(c);
        it->setData(Qt::UserRole, QString::fromStdString(t.token));
        list_->addItem(it);
    }
}

void TokenDialog::add_token() {
    QString tok = input_->text().trimmed();
    if (tok.isEmpty()) return;
    std::string err;
    if (tokens_.add_token(tok.toStdString(), "", err)) {
        tokens_.save();
        input_->clear();
        refresh_list();
        emit pool_changed();
    } else {
        QMessageBox::warning(this, QStringLiteral("Token rejected"),
                             QString::fromStdString(err));
    }
}

void TokenDialog::remove_selected() {
    auto* it = list_->currentItem();
    if (!it) return;
    tokens_.remove_token(it->data(Qt::UserRole).toString().toStdString());
    tokens_.save();
    refresh_list();
    emit pool_changed();
}

void TokenDialog::show_help() {
    static QDialog* help = nullptr;
    if (help) {
        help->show();
        help->raise();
        return;
    }
    help = new QDialog(this);
    help->setAttribute(Qt::WA_DeleteOnClose, false);
    help->setWindowTitle(QStringLiteral("How to create a Kaggle API token"));
    help->resize(560, 600);
    auto* lay = new QVBoxLayout(help);
    auto* area = new QScrollArea();
    area->setWidgetResizable(true);
    auto* body = new QLabel(QStringLiteral(R"html(
<h2>Creating a Kaggle API token — step by step</h2>
<p><b>1.</b> Go to <a href="https://www.kaggle.com/settings">kaggle.com/settings</a> (you must be signed in).</p>
<p><b>2.</b> Scroll to the <b>API</b> section.</p>
<p><b>3.</b> Click <b>Create New Token</b> (or "Token Expiration → Create New Token" if offered).</p>
<p><b>4.</b> Kaggle downloads a <code>kaggle.json</code> file — open it with any text editor,
   or simply copy the token value that starts with <code>KGAT_</code>.</p>
<p><b>5.</b> Paste the whole token (it starts with <code>KGAT_</code>) into Shuggle's token field and click <b>Add</b>.</p>
<p><b>6.</b> That's it. Shuggle checks the token with Kaggle immediately and shows its live GPU quota.</p>
<h3>Good to know</h3>
<ul>
<li><b>One token per account.</b> A second token from the same account is refused — that's by design.</li>
<li>Each account gets <b>30 free GPU hours every week</b>. The week resets <b>Saturday 00:00 UTC</b>.</li>
<li>When an account hits the 30h wall, Shuggle flags it <span style="color:#e23b3b;">exhausted</span>
    and stops using it until the reset — automatically.</li>
<li>More accounts = more hours. Shuggle always picks the healthiest token.</li>
<li>Your token stays in a plain file (<code>tokens.json</code>) inside the app folder, on your disk.
    It is only ever sent to Kaggle itself.</li>
</ul>
<p>Questions about the API? This is the official token format from Kaggle's settings page.</p>
)html"));
    body->setWordWrap(true);
    body->setTextFormat(Qt::RichText);
    body->setOpenExternalLinks(true);
    body->setAlignment(Qt::AlignTop | Qt::AlignLeft);
    area->setWidget(body);
    lay->addWidget(area);
    auto* close = new QPushButton(QStringLiteral("Got it"));
    connect(close, &QPushButton::clicked, help, &QDialog::close);
    lay->addWidget(close);
    help->resize(560, 620);
    help->show();
    help->raise();
}

} // namespace shuggle
