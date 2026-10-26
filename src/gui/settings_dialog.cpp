// Shuggle — settings_dialog.cpp
#include "settings_dialog.h"

#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QDoubleSpinBox>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QSlider>
#include <QSpinBox>
#include <QTabWidget>
#include <QTime>
#include <QTimeZone>
#include <QVBoxLayout>

#include "../core/util.h"

namespace shuggle {

// ── Global ───────────────────────────────────────────────────────────────────

GlobalSettingsDialog::GlobalSettingsDialog(GlobalSettings& g, QWidget* parent)
    : QDialog(parent), g_(g) {
    setWindowTitle(QStringLiteral("Settings"));
    resize(640, 620);
    auto* root = new QVBoxLayout(this);
    auto* tabs = new QTabWidget();
    root->addWidget(tabs, 1);

    // -- identity tab ----------------------------------------------------------
    auto* idw = new QWidget();
    auto* idf = new QFormLayout(idw);
    idf->setSpacing(10);
    name_ = new QLineEdit(QString::fromStdString(g_.user_name));
    idf->addRow(QStringLiteral("Your name"), name_);
    gender_ = new QComboBox();
    gender_->addItems({QStringLiteral(""), QStringLiteral("female"), QStringLiteral("male"),
                       QStringLiteral("non-binary"), QStringLiteral("agender"),
                       QStringLiteral("genderfluid"), QStringLiteral("bigender"),
                       QStringLiteral("transgender"), QStringLiteral("androgynous"),
                       QStringLiteral("prefer not to say"), QStringLiteral("custom…")});
    gender_custom_ = new QLineEdit();
    gender_custom_->setPlaceholderText(QStringLiteral("write your own"));
    auto current_g = QString::fromStdString(g_.user_gender);
    int gi = gender_->findText(current_g);
    if (gi >= 0) gender_->setCurrentIndex(gi);
    else if (!current_g.isEmpty()) {
        gender_->setCurrentIndex(gender_->count() - 1);
        gender_custom_->setText(current_g);
    }
    auto* grow = new QHBoxLayout();
    grow->addWidget(gender_, 1);
    grow->addWidget(gender_custom_, 1);
    idf->addRow(QStringLiteral("Gender"), grow);
    sex_ = new QComboBox();
    sex_->addItems({QStringLiteral(""), QStringLiteral("female"), QStringLiteral("male"),
                    QStringLiteral("intersex"), QStringLiteral("prefer not to say")});
    sex_->setCurrentText(QString::fromStdString(g_.user_sex));
    idf->addRow(QStringLiteral("Sex"), sex_);
    age_ = new QSpinBox();
    age_->setRange(0, 120);
    age_->setValue(g_.user_age);
    age_->setSpecialValueText(QStringLiteral("—"));
    idf->addRow(QStringLiteral("Age"), age_);
    birthday_ = new QLineEdit(QString::fromStdString(g_.user_birthday));
    birthday_->setPlaceholderText(QStringLiteral("YYYY-MM-DD"));
    idf->addRow(QStringLiteral("Birthday"), birthday_);

    country_ = new QComboBox();
    country_->setEditable(true);
    country_->addItems({QStringLiteral("Egypt"), QStringLiteral("United States"),
                        QStringLiteral("United Kingdom"), QStringLiteral("Germany"),
                        QStringLiteral("Saudi Arabia"), QStringLiteral("UAE"),
                        QStringLiteral("Jordan"), QStringLiteral("Morocco"),
                        QStringLiteral("Turkey"), QStringLiteral("India"),
                        QStringLiteral("Japan"), QStringLiteral("Brazil"),
                        QStringLiteral("Canada"), QStringLiteral("France"),
                        QStringLiteral("Spain"), QStringLiteral("Italy"),
                        QStringLiteral("Netherlands"), QStringLiteral("Russia"),
                        QStringLiteral("China"), QStringLiteral("Korea, South"),
                        QStringLiteral("Australia"), QStringLiteral("Other / write your own…")});
    country_auto_ = new QCheckBox(QStringLiteral("use device country"));
    country_auto_->setChecked(g_.country_from_device);
    country_->setCurrentText(QString::fromStdString(g_.user_country));
    auto* crow = new QHBoxLayout();
    crow->addWidget(country_, 1);
    crow->addWidget(country_auto_);
    idf->addRow(QStringLiteral("Country"), crow);

    tz_ = new QComboBox();
    tz_->setEditable(true);
    QList<QByteArray> zids = QTimeZone::availableTimeZoneIds();
    QStringList zstrs;
    for (const auto& z : zids) zstrs << QString::fromLatin1(z);
    tz_->addItems(zstrs);
    tz_auto_ = new QCheckBox(QStringLiteral("use device time"));
    tz_auto_->setChecked(g_.tz_from_device);
    if (!g_.tz_from_device)
        tz_->setCurrentText(QTimeZone((int)g_.tz_offset_minutes * 60).id());
    auto* trow = new QHBoxLayout();
    trow->addWidget(tz_, 1);
    trow->addWidget(tz_auto_);
    idf->addRow(QStringLiteral("Time & timezone"), trow);

    social_ = new QComboBox();
    social_->setEditable(true);
    social_->addItems({QStringLiteral(""), QStringLiteral("single"), QStringLiteral("married"),
                       QStringLiteral("engaged"), QStringLiteral("in a relationship"),
                       QStringLiteral("divorced"), QStringLiteral("complicated"),
                       QStringLiteral("prefer not to say")});
    social_->setCurrentText(QString::fromStdString(g_.social_status));
    idf->addRow(QStringLiteral("Social status"), social_);
    tabs->addTab(idw, QStringLiteral("You"));

    // -- prompt tab --------------------------------------------------------------
    auto* pw = new QWidget();
    auto* pv = new QVBoxLayout(pw);
    fancy_ = new QCheckBox(QStringLiteral("fancy mode (structured) — uncheck for raw editing"));
    fancy_->setChecked(g_.use_fancy_prompt);
    pv->addWidget(fancy_);
    role_ = new QLineEdit(QString::fromStdString(g_.role_description));
    role_->setPlaceholderText(QStringLiteral("model role, e.g. 'a ruthless code reviewer'"));
    pv->addWidget(new QLabel(QStringLiteral("Model role")));
    pv->addWidget(role_);
    pv->addWidget(new QLabel(QStringLiteral("How the model should respond")));
    style_ = new QPlainTextEdit(QString::fromStdString(g_.response_style));
    style_->setMaximumHeight(110);
    pv->addWidget(style_);
    pv->addWidget(new QLabel(QStringLiteral("About you (extra context)")));
    about_ = new QPlainTextEdit(QString::fromStdString(g_.about_you_note));
    about_->setMaximumHeight(90);
    pv->addWidget(about_);
    pv->addWidget(new QLabel(
        QStringLiteral("Raw system prompt (used when fancy mode is off; per-session overrides win)")));
    raw_ = new QPlainTextEdit(QString::fromStdString(g_.raw_system_prompt));
    pv->addWidget(raw_, 1);
    budget_lbl_ = new QLabel();
    pv->addWidget(budget_lbl_);
    tabs->addTab(pw, QStringLiteral("Prompt"));

    // -- memory inside prompt tab (bottom)
    auto* mem_row = new QHBoxLayout();
    mem_default_ = new QCheckBox(QStringLiteral("memory on by default"));
    mem_default_->setChecked(g_.memory_enabled_default);
    mem_tools_ = new QCheckBox(QStringLiteral("let the model update memory (tools)"));
    mem_tools_->setChecked(g_.memory_tools_enabled);
    mem_tools_->setToolTip(QStringLiteral("Off by default. Single-shot ops, no agent loops."));
    mem_row->addWidget(mem_default_);
    mem_row->addWidget(mem_tools_);
    pv->addLayout(mem_row);

    // -- model tab ----------------------------------------------------------------
    auto* mw = new QWidget();
    auto* mf = new QFormLayout(mw);
    ctx_ = new QSlider(Qt::Horizontal);
    ctx_->setRange(kContextMin, kContextMax);
    ctx_->setSingleStep(1024);
    ctx_->setPageStep(4096);
    ctx_->setValue(g_.model.context_tokens);
    ctx_lbl_ = new QLabel();
    auto connect_ctx = [this] {
        ctx_lbl_->setText(QStringLiteral("%1 tokens  (32,768 – 75,000 — the T4s say no)")
                              .arg(ctx_->value()));
    };
    connect(ctx_, &QSlider::valueChanged, connect_ctx);
    connect_ctx();
    mf->addRow(QStringLiteral("Context window"), ctx_);
    mf->addRow(QString(), ctx_lbl_);
    temp_ = new QDoubleSpinBox();
    temp_->setRange(0.0, 2.0);
    temp_->setSingleStep(0.05);
    temp_->setValue(g_.model.temperature);
    mf->addRow(QStringLiteral("Temperature"), temp_);
    topp_ = new QDoubleSpinBox();
    topp_->setRange(0.05, 1.0);
    topp_->setSingleStep(0.05);
    topp_->setValue(g_.model.top_p);
    mf->addRow(QStringLiteral("Top-p"), topp_);
    max_out_ = new QSpinBox();
    max_out_->setRange(256, 32768);
    max_out_->setSingleStep(1024);
    max_out_->setValue(g_.model.max_output_tokens);
    mf->addRow(QStringLiteral("Max output tokens"), max_out_);
    think_default_ = new QCheckBox(QStringLiteral("thinking on by default"));
    think_default_->setChecked(g_.model.thinking_enabled);
    mf->addRow(QString(), think_default_);
    tabs->addTab(mw, QStringLiteral("Model"));

    // -- search tab ---------------------------------------------------------------
    auto* sw = new QWidget();
    auto* sf = new QFormLayout(sw);
    search_default_ = new QCheckBox(QStringLiteral("web search on by default (toggle per chat)"));
    search_default_->setChecked(g_.search_enabled_default);
    sf->addRow(QString(), search_default_);
    max_queries_ = new QSpinBox();
    max_queries_->setRange(1, 5);
    max_queries_->setValue(g_.search_max_queries);
    sf->addRow(QStringLiteral("Max queries per search"), max_queries_);
    results_per_ = new QSpinBox();
    results_per_->setRange(3, 8);
    results_per_->setValue(g_.search_results_per_query);
    sf->addRow(QStringLiteral("Results per query"), results_per_);
    digest_ = new QCheckBox(QStringLiteral("summarization layer (recommended)"));
    digest_->setChecked(g_.search_digest);
    sf->addRow(QString(), digest_);
    auto* shint = new QLabel(QStringLiteral(
        "Search runs on the engine notebook (unfiltered DuckDuckGo), plans queries with the "
        "model, digests results, then answers with sources. Separate tool prompt, never mixed "
        "into your system prompt."));
    shint->setWordWrap(true);
    shint->setObjectName("HintLabel");
    sf->addRow(QString(), shint);
    tabs->addTab(sw, QStringLiteral("Search"));

    // -- advanced tab ---------------------------------------------------------------
    auto* aw = new QWidget();
    auto* af = new QFormLayout(aw);
    links_inside_ = new QCheckBox(QStringLiteral("open links inside the app (internal browser)"));
    links_inside_->setChecked(g_.open_links_inside_app);
    af->addRow(QString(), links_inside_);
    edge_data_ = new QCheckBox(QStringLiteral("Windows: reuse Edge browser data in the internal browser"));
    edge_data_->setChecked(g_.edge_reuse_browser_data);
    af->addRow(QString(), edge_data_);
    sync_ = new QCheckBox(QStringLiteral("sync memory + sessions to a private Kaggle dataset"));
    sync_->setChecked(g_.kaggle_sync_enabled);
    af->addRow(QString(), sync_);
    tabs->addTab(aw, QStringLiteral("Advanced"));

    auto* btns = new QHBoxLayout();
    btns->addStretch();
    auto* cancel = new QPushButton(QStringLiteral("Cancel"));
    connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
    auto* ok = new QPushButton(QStringLiteral("Save"));
    ok->setObjectName("AccentButton");
    connect(ok, &QPushButton::clicked, this, &GlobalSettingsDialog::save);
    btns->addWidget(cancel);
    btns->addWidget(ok);
    root->addLayout(btns);
}

void GlobalSettingsDialog::save() {
    g_.user_name = name_->text().toStdString();
    g_.user_gender = gender_custom_->text().trimmed().isEmpty()
                         ? gender_->currentText().toStdString()
                         : gender_custom_->text().trimmed().toStdString();
    if (g_.user_gender == "custom…") g_.user_gender.clear();
    g_.user_sex = sex_->currentText().toStdString();
    g_.user_age = age_->value();
    g_.user_birthday = birthday_->text().trimmed().toStdString();
    g_.user_country = country_->currentText().toStdString();
    g_.country_from_device = country_auto_->isChecked();
    g_.tz_from_device = tz_auto_->isChecked();
    if (!tz_auto_->isChecked()) {
        QTimeZone tz(tz_->currentText().toUtf8());
        if (tz.isValid())
            g_.tz_offset_minutes = (int)(tz.standardTimeOffset(QDateTime::currentDateTimeUtc()) / 60);
    }
    g_.social_status = social_->currentText().toStdString();
    g_.role_description = role_->text().toStdString();
    g_.response_style = style_->toPlainText().toStdString();
    g_.about_you_note = about_->toPlainText().toStdString();
    g_.use_fancy_prompt = fancy_->isChecked();
    g_.raw_system_prompt = raw_->toPlainText().toStdString();
    g_.memory_enabled_default = mem_default_->isChecked();
    g_.memory_tools_enabled = mem_tools_->isChecked();
    g_.model.context_tokens = ctx_->value();
    g_.model.temperature = temp_->value();
    g_.model.top_p = topp_->value();
    g_.model.max_output_tokens = max_out_->value();
    g_.model.thinking_enabled = think_default_->isChecked();
    g_.search_enabled_default = search_default_->isChecked();
    g_.search_max_queries = max_queries_->value();
    g_.search_results_per_query = results_per_->value();
    g_.search_digest = digest_->isChecked();
    g_.open_links_inside_app = links_inside_->isChecked();
    g_.edge_reuse_browser_data = edge_data_->isChecked();
    g_.kaggle_sync_enabled = sync_->isChecked();
    g_.clamp();
    if (g_.raw_system_prompt.size() > kSystemPromptMaxChars)
        QMessageBox::warning(this, QStringLiteral("Too long"),
                             QStringLiteral("Raw prompt exceeds %1 chars — it will be clipped "
                                            "at send time.")
                                 .arg(kSystemPromptMaxChars));
    if (g_.save(settings_file_path())) emit saved();
    accept();
}

// ── Per-session ───────────────────────────────────────────────────────────────

SessionSettingsDialog::SessionSettingsDialog(GlobalSettings& global, SessionSettings& target,
                                             const std::string& bound_token, QWidget* parent)
    : QDialog(parent), g_(global), t_(target) {
    setWindowTitle(QStringLiteral("Session settings"));
    resize(560, 560);
    auto* root = new QVBoxLayout(this);

    prompt_on_ = new QCheckBox(QStringLiteral("override system prompt for this session"));
    prompt_on_->setChecked(t_.has_prompt_override);
    root->addWidget(prompt_on_);
    prompt_ = new QPlainTextEdit(QString::fromStdString(t_.system_prompt_override));
    prompt_->setPlaceholderText(QStringLiteral(
        "Full system prompt for this session only. Empty = global. Fancy/raw handled globally."));
    root->addWidget(prompt_, 1);

    budget_lbl_ = new QLabel();
    auto upd = [this] { budget_lbl_->setText(QStringLiteral("%1 / %2 chars")
                                                 .arg(prompt_->toPlainText().size())
                                                 .arg(kSystemPromptMaxChars)); };
    connect(prompt_, &QPlainTextEdit::textChanged, upd);
    upd();
    root->addWidget(budget_lbl_);

    auto* form = new QFormLayout();
    mem_on_ = new QCheckBox();
    mem_on_->setChecked(t_.effective_memory(g_.memory_enabled_default));
    form->addRow(QStringLiteral("Memory"), mem_on_);
    mem_tools_ = new QCheckBox();
    mem_tools_->setChecked(t_.effective_memory_tools(g_.memory_tools_enabled));
    form->addRow(QStringLiteral("Memory tools"), mem_tools_);
    search_on_ = new QCheckBox();
    search_on_->setChecked(t_.effective_search(g_.search_enabled_default));
    form->addRow(QStringLiteral("Web search"), search_on_);
    temp_ = new QDoubleSpinBox();
    temp_->setRange(0.0, 2.0);
    temp_->setSingleStep(0.05);
    temp_->setValue(t_.model ? t_.model->temperature : g_.model.temperature);
    form->addRow(QStringLiteral("Temperature"), temp_);
    ctx_ = new QSpinBox();
    ctx_->setRange(kContextMin, kContextMax);
    ctx_->setSingleStep(1024);
    ctx_->setValue(t_.model ? t_.model->context_tokens : g_.model.context_tokens);
    form->addRow(QStringLiteral("Context"), ctx_);
    token_pin_ = new QLineEdit(QString::fromStdString(bound_token));
    token_pin_->setPlaceholderText(QStringLiteral("auto (healthiest token)"));
    form->addRow(QStringLiteral("Pinned token"), token_pin_);
    root->addLayout(form);

    auto* btns = new QHBoxLayout();
    btns->addStretch();
    auto* cancel = new QPushButton(QStringLiteral("Cancel"));
    connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
    auto* ok = new QPushButton(QStringLiteral("Save"));
    ok->setObjectName("AccentButton");
    connect(ok, &QPushButton::clicked, this, &SessionSettingsDialog::save);
    btns->addWidget(cancel);
    btns->addWidget(ok);
    root->addLayout(btns);
}

void SessionSettingsDialog::save() {
    t_.has_prompt_override = prompt_on_->isChecked();
    t_.system_prompt_override = prompt_->toPlainText().toStdString();
    t_.memory_enabled_v = mem_on_->isChecked();
    t_.memory_tools_enabled_v = mem_tools_->isChecked();
    t_.search_enabled_v = search_on_->isChecked();
    ModelSettings m;
    m.temperature = temp_->value();
    m.context_tokens = ctx_->value();
    m.clamp();
    t_.model = m;
    QString pin = token_pin_->text().trimmed();
    t_.token_override = pin.isEmpty() ? std::optional<std::string>()
                                      : std::optional<std::string>(pin.toStdString());
    prompt_changed = true;
    emit saved();
    accept();
}

} // namespace shuggle
